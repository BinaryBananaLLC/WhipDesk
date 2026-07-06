import { optionalImport } from "../util/optional-import";
import { grabWindowsJpeg } from "./win-capture";
import { log } from "../logger";

export interface CaptureOptions {
  quality: number;
  maxWidth: number;
}

/** A normalized [0,1] sub-region of the captured display. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether a viewport is effectively the whole screen (no crop needed). */
export function isFullViewport(vp: Viewport | null): boolean {
  return !vp || (vp.x <= 0.001 && vp.y <= 0.001 && vp.w >= 0.999 && vp.h >= 0.999);
}

/**
 * Default capturer. On macOS/Linux it uses `screenshot-desktop` (shells to `screencapture` /
 * scrot) and asks for JPEG directly. On Windows it grabs a single frame with the BUNDLED ffmpeg
 * instead (win-capture.ts), so the Windows build ships NO `screenshot-desktop` — its win32 helper
 * trips ESET's `MSIL/CaptureScreen.A` PUA scan and blocks winget/Store validation. Either way, if
 * `sharp` is installed the frame is downscaled + re-encoded to cut bandwidth; otherwise the
 * full-resolution JPEG is sent as-is.
 *
 * This is only the LOW-RATE sampler that feeds the region change-watchers; the live screen the
 * controller sees is the direct H.264 capture (encoder.ts), which was always pure ffmpeg.
 *
 * Region capture (Phase 1): when the controller zooms in it sends a `set-viewport`, and the
 * capturer crops to exactly that rectangle before encoding — so a magnified view streams a
 * few hundred px instead of the whole desktop. Cropping needs `sharp`; without it we fall
 * back to sending the full frame and the controller magnifies client-side.
 *
 * AI-AGENT: keep this class behind the `capture()` shape. A future `FfmpegCapturer`
 * (avfoundation/gdigrab MJPEG) can drop in for higher FPS — see docs/ARCHITECTURE.md.
 */
export class ScreenCapturer {
  readonly backend = process.platform === "win32" ? "ffmpeg" : "screenshot-desktop";
  /** undefined = not yet probed, null = unavailable, otherwise the sharp factory. */
  private sharp: any = undefined;
  /** undefined = not yet probed, null = unavailable, otherwise the screenshot-desktop fn (non-Windows). */
  private shot: any = undefined;
  /** 0-based display index (screenshot-desktop screen id / ffmpeg output_idx). */
  private displayId = 0;

  constructor(private options: CaptureOptions) {}

  /** Probe optional deps once at startup. */
  async init(): Promise<void> {
    await this.getSharp();
  }

  /** Lazy-load screenshot-desktop (non-Windows only) so the Windows bundle never ships it. */
  private async getShot(): Promise<any> {
    if (this.shot !== undefined) return this.shot;
    const mod = await optionalImport("screenshot-desktop");
    this.shot = mod ? (mod.default ?? mod) : null;
    if (!this.shot) log.warn("screenshot-desktop not available — region change-watchers disabled");
    return this.shot;
  }

  /** The host can always crop to a sub-region now (the H.264 encoder applies a crop filter). */
  get canCrop(): boolean {
    return true;
  }

  setOptions(patch: Partial<CaptureOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  setDisplay(id: number): void {
    this.displayId = Math.max(0, Math.round(id));
  }

  private async getSharp(): Promise<any> {
    if (this.sharp !== undefined) return this.sharp;
    const mod = await optionalImport("sharp");
    this.sharp = mod ? mod.default ?? mod : null;
    if (!this.sharp) {
      log.warn("sharp not available — sampling full-resolution JPEG frames");
    }
    return this.sharp;
  }

  /** Capture the FULL active display as a JPEG (downscaled to maxWidth). Cropping/zoom is done
   * downstream by the H.264 encoder's filter, so this stays a plain full-screen sampler used by
   * the change-watchers and the encoder's pipe fallback. */
  async capture(): Promise<Buffer> {
    const raw = await this.grabRaw();
    const sharp = await this.getSharp();
    if (!sharp) return raw;
    try {
      return await sharp(raw)
        .resize({ width: this.options.maxWidth, withoutEnlargement: true })
        .jpeg({ quality: this.options.quality })
        .toBuffer();
    } catch (error) {
      log.warn("sharp transform failed; sending raw frame", (error as Error).message);
      return raw;
    }
  }

  /** Grab one full-display JPEG: bundled ffmpeg on Windows, screenshot-desktop elsewhere. */
  private async grabRaw(): Promise<Buffer> {
    if (process.platform === "win32") {
      return grabWindowsJpeg(this.displayId, this.options.maxWidth, this.options.quality);
    }
    const shot = await this.getShot();
    if (!shot) throw new Error("screenshot-desktop not available");
    return (await shot({ format: "jpg", screen: this.displayId })) as Buffer;
  }
}
