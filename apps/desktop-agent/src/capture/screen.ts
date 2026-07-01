import screenshot from "screenshot-desktop";
import { optionalImport } from "../util/optional-import";
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
 * Default capturer. Uses `screenshot-desktop` (shells to macOS `screencapture` /
 * Windows native) and asks for JPEG directly, so the basic path needs no native deps.
 * If `sharp` is installed it crops to the active viewport, downscales + re-encodes to cut
 * bandwidth; otherwise the full-resolution JPEG is sent as-is.
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
  readonly backend = "screenshot-desktop";
  /** undefined = not yet probed, null = unavailable, otherwise the sharp factory. */
  private sharp: any = undefined;
  /** 0-based display index understood by screenshot-desktop. */
  private displayId = 0;

  constructor(private options: CaptureOptions) {}

  /** Probe optional deps once at startup. */
  async init(): Promise<void> {
    await this.getSharp();
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
    const raw = (await screenshot({ format: "jpg", screen: this.displayId })) as Buffer;
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
}
