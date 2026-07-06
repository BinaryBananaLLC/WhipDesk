import { execFile } from "node:child_process";
import { log } from "../logger";

/**
 * Windows display enumeration WITHOUT `screenshot-desktop` (whose win32 helper trips ESET's
 * `MSIL/CaptureScreen.A` scan — see win-capture.ts). A short PowerShell/P-Invoke probe walks
 * `EnumDisplayDevices` in the SAME order screenshot-desktop did (`\\.\DISPLAY1`, `\\.\DISPLAY2`, …),
 * so the 0-based index still maps 1:1 onto ffmpeg ddagrab's `output_idx` — no change to which
 * monitor a given id captures. Unlike the old path it also returns each display's desktop position
 * (`dmPosition`), which is exactly the global top-left coordinate nut.js consumes, so precise input
 * on secondary monitors now works (it was previously zeroed out — capture-only).
 */

export interface WinDisplay {
  /** 0-based, aligned with ddagrab output_idx. */
  id: number;
  /** Raw device name (e.g. "\\.\DISPLAY1"); the caller friendly-names it. */
  name: string;
  primary: boolean;
  width: number;
  height: number;
  /** Desktop position in Windows virtual-screen pixels (nut.js global coords). */
  originX: number;
  originY: number;
}

/** Attached-desktop displays in EnumDisplayDevices order, or null if the probe failed. */
export async function listWindowsDisplays(): Promise<WinDisplay[] | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PROBE_PS],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log.debug("display probe failed:", err.message);
          return resolve(null);
        }
        const out: WinDisplay[] = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          // name;primary(0/1);x;y;w;h
          const p = line.trim().split(";");
          if (p.length !== 6) continue;
          const [name, primary, x, y, w, h] = p;
          const width = Number(w);
          const height = Number(h);
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
          out.push({
            id: out.length,
            name: name || `\\\\.\\DISPLAY${out.length + 1}`,
            primary: primary === "1",
            width,
            height,
            originX: Number(x) || 0,
            originY: Number(y) || 0,
          });
        }
        resolve(out.length > 0 ? out : null);
      },
    );
  });
}

// Enumerate every ACTIVE display adapter (EnumDisplayDevices) in its native order and print its
// current mode from EnumDisplaySettings as "<deviceName>;<primary>;<x>;<y>;<width>;<height>".
const PROBE_PS = `
$src = @'
using System;
using System.Runtime.InteropServices;
public static class WdDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion; public ushort dmDriverVersion; public ushort dmSize; public ushort dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption;
    public short dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevices(string dev, uint num, ref DISPLAY_DEVICE info, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  const int ATTACHED = 0x1;      // DISPLAY_DEVICE_ATTACHED_TO_DESKTOP
  const int PRIMARY = 0x4;       // DISPLAY_DEVICE_PRIMARY_DEVICE
  const int CURRENT = -1;        // ENUM_CURRENT_SETTINGS
  public static void Probe() {
    uint i = 0;
    while (true) {
      var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      i++;
      if ((d.StateFlags & ATTACHED) == 0) continue;
      var dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(d.DeviceName, CURRENT, ref dm)) continue;
      string primary = (d.StateFlags & PRIMARY) != 0 ? "1" : "0";
      Console.WriteLine(d.DeviceName + ";" + primary + ";" + dm.dmPositionX + ";" + dm.dmPositionY + ";" + dm.dmPelsWidth + ";" + dm.dmPelsHeight);
    }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[WdDisp]::Probe()
`.trim();
