import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { log } from "../logger";

/**
 * Windows single-frame screenshot via the BUNDLED ffmpeg — the same binary that already drives the
 * live H.264 stream (encoder.ts). This exists so Windows builds don't have to ship
 * `screenshot-desktop`, whose win32 helper (`screenCapture_1.3.2.bat`, a C#/batch polyglot that
 * `csc.exe`-compiles to a screen-grabbing .NET exe) trips ESET's `MSIL/CaptureScreen.A` PUA
 * heuristic and blocks the winget/Store binary-validation scans. The live video was always ffmpeg;
 * this closes the last screenshot-desktop use on Windows (the region change-watcher sampler).
 *
 * ddagrab (Desktop Duplication, GPU) is preferred — it matches the live capture's monitor selection
 * (`output_idx`) and works on HDR desktops; gdigrab is the fallback for machines without D3D11. The
 * frame is decoded to a plain 8-bit JPEG (cursor omitted so a moving pointer doesn't read as a
 * region change), which is exactly what the RegionWatcher + `sharp` consume.
 */

const isWin = process.platform === "win32";

/** mjpeg's qscale runs 2 (best) .. 31 (worst); map our 0..100 quality onto it. */
function mjpegQ(quality: number): string {
  const q = Math.round(31 - (Math.max(0, Math.min(100, quality)) / 100) * 29);
  return String(Math.max(2, Math.min(31, q)));
}

/** Even, capped width — mjpeg tolerates odd dims but keep parity with the encoder's scale filter. */
function scaleFilter(maxWidth: number): string {
  return `scale=trunc(min(${Math.round(maxWidth)}\\,iw)/2)*2:-2`;
}

function grab(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("bundled ffmpeg not found"));
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 0) return resolve(buf);
      reject(new Error(`ffmpeg grab exit ${code ?? "?"}: ${err.split("\n").find(Boolean) ?? "no frame"}`));
    });
  });
}

/** ddagrab yields one JPEG for the selected monitor; needs D3D11 (Win8+ with a real GPU). */
function grabDdagrab(displayIndex: number, maxWidth: number, quality: number): Promise<Buffer> {
  const idx = Math.max(0, Math.round(displayIndex));
  return grab([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi",
    "-i", `ddagrab=output_idx=${idx}:framerate=30:draw_mouse=0`,
    "-frames:v", "1",
    "-vf", `hwdownload,format=bgra,${scaleFilter(maxWidth)}`,
    "-f", "image2", "-c:v", "mjpeg", "-q:v", mjpegQ(quality),
    "pipe:1",
  ]);
}

/** gdigrab grabs the whole virtual desktop via GDI BitBlt — works without D3D11, black on HDR. */
function grabGdigrab(maxWidth: number, quality: number): Promise<Buffer> {
  return grab([
    "-hide_banner", "-loglevel", "error",
    "-f", "gdigrab", "-framerate", "30", "-draw_mouse", "0",
    "-i", "desktop",
    "-frames:v", "1",
    "-vf", scaleFilter(maxWidth),
    "-f", "image2", "-c:v", "mjpeg", "-q:v", mjpegQ(quality),
    "pipe:1",
  ]);
}

let gdigrabForced = false;

/**
 * Grab a single full-display JPEG on Windows. Tries ddagrab (per-monitor, HDR-safe) and, if it
 * yields nothing (no D3D11 / unsupported GPU), falls back to gdigrab for the rest of the session —
 * mirroring the live encoder's `winCaptureFallback`. Throws on Windows only when both fail.
 */
export async function grabWindowsJpeg(displayIndex: number, maxWidth: number, quality: number): Promise<Buffer> {
  if (!isWin) throw new Error("grabWindowsJpeg is Windows-only");
  if (!gdigrabForced) {
    try {
      return await grabDdagrab(displayIndex, maxWidth, quality);
    } catch (error) {
      gdigrabForced = true;
      log.debug("ddagrab screenshot failed, falling back to gdigrab:", (error as Error).message);
    }
  }
  return grabGdigrab(maxWidth, quality);
}
