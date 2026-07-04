import { execFile } from "node:child_process";
import { promisify } from "node:util";
import screenshot from "screenshot-desktop";
import type { DisplayInfo, ScreenInfo } from "@whipdesk/protocol";
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

/** screenshot-desktop's display list: 0-based ids, primary first, names but no geometry. */
async function listBaseDisplays(): Promise<Array<{ id: number; name: string; primary: boolean }>> {
  try {
    const displays = await screenshot.listDisplays();
    return displays.map((d, index) => ({
      id: typeof d.id === "number" ? d.id : index,
      name: friendlyDisplayName(d.name, index),
      primary: Boolean((d as { primary?: boolean }).primary) || index === 0,
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
