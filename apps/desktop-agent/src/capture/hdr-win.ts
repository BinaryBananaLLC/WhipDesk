import { execFile } from "node:child_process";
import { log } from "../logger";

/**
 * Windows HDR ("advanced color") detection via DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO —
 * the same bit the Settings app flips. Runs a short PowerShell/P-Invoke probe (~0.5s), so results
 * are cached: capture restarts happen on every zoom re-crop and must not pay a probe each time.
 *
 * Why the encoder cares: with HDR ON the desktop is composited in scRGB, and an 8-bit BGRA
 * Desktop Duplication of it is a raw truncation — the classic grey "washed out" remote image. The
 * capture must instead duplicate FP16 frames and tone-map them to SDR (encoder.ts). Toggling HDR
 * mid-session kills ddagrab ("Output parameters changed" / AcquireNextFrame 0x887A0026), so the
 * encoder invalidates this cache on those errors and the next spawn re-probes the real state.
 */

interface HdrState {
  /** Any active display currently has HDR (advanced color) ENABLED. */
  active: boolean;
  /** Any active display supports HDR (even if currently off) — for softer launch messaging. */
  supported: boolean;
}

let cached: { state: HdrState; at: number } | null = null;
let inflight: Promise<HdrState | null> | null = null;

/** Force the next query to re-probe (call when ffmpeg reports a display-format change). */
export function invalidateHdrCache(): void {
  cached = null;
}

/**
 * Cached HDR state; probes when older than `maxAgeMs`. Non-Windows and probe failures return
 * null (callers treat unknown as SDR — the wrong guess self-heals via the capture fallback).
 */
export async function windowsHdrState(maxAgeMs = 15_000): Promise<HdrState | null> {
  if (process.platform !== "win32") return null;
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.state;
  if (inflight) return inflight;
  inflight = probe()
    .then((state) => {
      if (state) cached = { state, at: Date.now() };
      return state;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function probe(): Promise<HdrState | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PROBE_PS],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log.debug("hdr probe failed:", err.message);
          return resolve(null);
        }
        let supported = false;
        let active = false;
        let sawAny = false;
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^([01]) ([01])$/.exec(line.trim());
          if (!m) continue;
          sawAny = true;
          if (m[1] === "1") supported = true;
          if (m[2] === "1") active = true;
        }
        resolve(sawAny ? { supported, active } : null);
      },
    );
  });
}

// Queries every ACTIVE display path and prints "<hdrSupported> <hdrEnabled>" per display.
// DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO.value bits: 0 = supported, 1 = enabled.
const PROBE_PS = `
$src = @'
using System;
using System.Runtime.InteropServices;
public static class WdHdr {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_SOURCE { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct RATIONAL { public uint num; public uint den; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_TARGET { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public RATIONAL refreshRate; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_INFO { public PATH_SOURCE sourceInfo; public PATH_TARGET targetInfo; public uint flags; }
  [StructLayout(LayoutKind.Sequential, Size = 64)] public struct MODE_INFO { public uint infoType; public uint id; public LUID adapterId; }
  [StructLayout(LayoutKind.Sequential)] public struct DEVICE_INFO_HEADER { public uint type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential)] public struct GET_ADVANCED_COLOR_INFO { public DEVICE_INFO_HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; }
  [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
  [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PATH_INFO[] paths, ref uint numModes, [Out] MODE_INFO[] modes, IntPtr topologyId);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref GET_ADVANCED_COLOR_INFO info);
  public static void Probe() {
    uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return;
    var paths = new PATH_INFO[np];
    var modes = new MODE_INFO[nm];
    if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return;
    for (int i = 0; i < np; i++) {
      var q = new GET_ADVANCED_COLOR_INFO();
      q.header.type = 9;
      q.header.size = (uint)Marshal.SizeOf(typeof(GET_ADVANCED_COLOR_INFO));
      q.header.adapterId = paths[i].targetInfo.adapterId;
      q.header.id = paths[i].targetInfo.id;
      if (DisplayConfigGetDeviceInfo(ref q) == 0)
        Console.WriteLine(((q.value & 1) != 0 ? "1" : "0") + " " + ((q.value & 2) != 0 ? "1" : "0"));
    }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[WdHdr]::Probe()
`.trim();
