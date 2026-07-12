import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DisplayInfo, ScreenInfo } from "@whipdesk/protocol";
import { listWindowsDisplays } from "./displays-win";
import { log } from "../logger";

const exec = promisify(execFile);

/**
 * A display with enough geometry to map normalized [0,1] pointer coords to the global
 * cursor space used by the input backend. `origin*` + `width/height` are in LOGICAL POINTS
 * in the macOS Quartz/top-left global coordinate system (primary display's top-left = 0,0),
 * which is exactly what nut.js consumes. See AI-AGENT notes below.
 */
export interface DisplayGeometry extends DisplayInfo {
  originX: number;
  originY: number;
}

/** Strip agent-only geometry before sending displays over the wire. */
export function toDisplayInfo(d: DisplayGeometry): DisplayInfo {
  return { id: d.id, name: d.name, primary: d.primary, width: d.width, height: d.height };
}

interface NsScreen {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  name: string;
}

/**
 * macOS-only: read every NSScreen's Cocoa frame (bottom-left origin, y-up) and convert to
 * Quartz top-left global points (y-down, primary top-left = 0,0), which is what nut.js and
 * `screencapture` use. The flip pivots on the primary screen height.
 */
async function readNsScreens(): Promise<NsScreen[] | null> {
  if (process.platform !== "darwin") return null;
  const jxa = `ObjC.import("AppKit");
    var s = $.NSScreen.screens, n = s.count, out = [];
    for (var i = 0; i < n; i++) {
      var sc = s.objectAtIndex(i), f = sc.frame;
      out.push({ x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height,
                 scale: sc.backingScaleFactor, name: ObjC.unwrap(sc.localizedName) });
    }
    JSON.stringify(out);`;
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", jxa]);
    const parsed = JSON.parse(stdout.trim()) as NsScreen[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch (error) {
    log.warn("NSScreen geometry probe failed:", (error as Error).message);
    return null;
  }
}

/** screenshot-desktop returns raw OS device names on Windows (e.g. "\\.\DISPLAY2") which look
 * cryptic in the picker. Normalize those to a friendly "Display N"; leave meaningful names (macOS
 * gives "Built-in Retina Display", monitor model names, etc.) untouched. */
function friendlyDisplayName(raw: unknown, index: number): string {
  const s = String(raw ?? "").trim();
  if (!s) return `Display ${index + 1}`;
  const m = /DISPLAY(\d+)/i.exec(s);
  if (m) return `Display ${m[1]}`;
  // Any other GDI-style device path (\\.\...) is not user-friendly either.
  if (/^\\\\/.test(s)) return `Display ${index + 1}`;
  return s;
}

/** screenshot-desktop's display list: 0-based ids, primary first, names but no geometry.
 * Non-Windows only — Windows enumerates natively (listWindowsDisplays) so it can drop the dep. */
async function listBaseDisplays(): Promise<Array<{ id: number; name: string; primary: boolean }>> {
  try {
    // Static specifier so esbuild INLINES screenshot-desktop into agent.cjs (see screen.ts getShot).
    const mod: any = await import("screenshot-desktop");
    const screenshot = mod ? (mod.default ?? mod) : null;
    if (!screenshot) {
      log.warn("screenshot-desktop not available — assuming a single primary display");
      return [];
    }
    const displays = await screenshot.listDisplays();
    return displays.map((d: { id?: number; name?: string; primary?: boolean }, index: number) => ({
      id: typeof d.id === "number" ? d.id : index,
      name: friendlyDisplayName(d.name, index),
      primary: Boolean(d.primary) || index === 0,
    }));
  } catch (error) {
    log.warn("listDisplays failed:", (error as Error).message);
    return [];
  }
}

/**
 * Merge the capture display list with NSScreen geometry into one model the agent can use
 * for both capture (`id` -> screenshot-desktop screen index) and input (origin+size).
 *
 * Matching strategy (robust for the common 1–2 monitor case):
 *  - primary display  -> the NSScreen at Cocoa origin (0,0)
 *  - others           -> NSScreen with a matching localizedName, else by positional order
 *
 * `fallback` (primary size from the input backend) is used when geometry is unavailable so
 * the primary display still maps input correctly even without JXA.
 */
export async function listDisplayGeometry(fallback: ScreenInfo): Promise<DisplayGeometry[]> {
  // Windows: native EnumDisplayDevices probe returns geometry directly, in the same order ddagrab's
  // output_idx uses. Falls through to the single-primary default below when the probe fails, so a
  // bad probe degrades gracefully instead of crashing.
  if (process.platform === "win32") {
    const wins = await listWindowsDisplays();
    if (wins && wins.length > 0) {
      // DPI reconciliation. EnumDisplaySettings reports geometry in PHYSICAL pixels (e.g. 3840x2160
      // on a 4K panel), but nut.js drives the cursor in the process's coordinate space — which
      // Windows DPI-VIRTUALIZES to logical pixels (2560x1440 at 150%) because the Node runtime is not
      // per-monitor DPI aware. Feeding physical coords straight to nut.js made a normalized click
      // overshoot by the scale factor and clamp into a screen corner — the "scheduled click hit the
      // bottom-left instead of my button" bug, and Windows-only (macOS NSScreen + nut.js are both
      // logical, so they already agree). Divide every display's geometry by the ratio of the physical
      // primary width to nut.js's reported primary width: that ratio is the system scale when nut is
      // DPI-unaware and exactly 1.0 if it ever reports physical, so this self-corrects either way.
      const primaryWin = wins.find((w) => w.primary) ?? wins[0]!;
      const scale = fallback.width > 0 && primaryWin.width > 0 ? primaryWin.width / fallback.width : 1;
      return wins.map((d) => ({
        id: d.id,
        name: friendlyDisplayName(d.name, d.id),
        primary: d.primary || d.id === 0,
        width: Math.round(d.width / scale),
        height: Math.round(d.height / scale),
        originX: Math.round(d.originX / scale),
        originY: Math.round(d.originY / scale),
      }));
    }
  }

  const base = await listBaseDisplays();
  const ns = await readNsScreens();

  if (base.length === 0) {
    // No enumeration at all — assume a single primary display sized by the input backend.
    return [
      {
        id: 0,
        name: "Display 1",
        primary: true,
        width: fallback.width,
        height: fallback.height,
        originX: 0,
        originY: 0,
      },
    ];
  }

  // Primary screen height pivots the Cocoa->Quartz vertical flip.
  const primaryNs = ns?.find((s) => s.x === 0 && s.y === 0) ?? ns?.[0];
  const primaryHeight = primaryNs?.h ?? fallback.height ?? 0;
  const usedNs = new Set<NsScreen>();

  const matchNs = (name: string, primary: boolean): NsScreen | undefined => {
    if (primary) {
      const p = ns?.find((s) => s.x === 0 && s.y === 0 && !usedNs.has(s));
      if (p) return p;
    }
    const byName = ns?.find((s) => s.name && s.name === name && !usedNs.has(s));
    if (byName) return byName;
    return ns?.find((s) => !usedNs.has(s));
  };

  return base.map((d) => {
    const match = matchNs(d.name, d.primary);
    if (match) {
      usedNs.add(match);
      return {
        ...d,
        width: Math.round(match.w),
        height: Math.round(match.h),
        originX: Math.round(match.x),
        // Cocoa bottom-left -> Quartz top-left: topY = primaryHeight - (cocoaY + cocoaH)
        originY: Math.round(primaryHeight - (match.y + match.h)),
      };
    }
    // No geometry: primary falls back to the backend size at origin; others get zero size
    // (capture still works; precise input on that display is disabled until geometry exists).
    return d.primary
      ? { ...d, width: fallback.width, height: fallback.height, originX: 0, originY: 0 }
      : { ...d, width: 0, height: 0, originX: 0, originY: 0 };
  });
}
