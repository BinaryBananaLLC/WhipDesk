import type { WatchRegion } from "@whipdesk/protocol";
import { optionalImport } from "../util/optional-import";
import { log } from "../logger";
import type { NotificationHub } from "../notifications";

interface Tracked {
  region: WatchRegion;
  baseline: Buffer | null;
  lastNotifiedAt: number;
}

const SAMPLE = 24; // downscale each region to SAMPLE x SAMPLE greyscale for diffing
const CHECK_INTERVAL_MS = 1200; // how often to evaluate regions (independent of capture fps)
const CHANGE_THRESHOLD = 0.05; // mean per-pixel difference fraction that counts as "changed"
const COOLDOWN_MS = 8000; // minimum gap between notifications for the same region

/**
 * Watches user-selected screen regions for visual change and fires a notification when the
 * pixels inside one change. Each region is downscaled to a small greyscale thumbnail; a
 * frame "changed" when the mean absolute pixel difference vs the baseline exceeds a
 * threshold. Uses `sharp` (optional dep) to crop + resize the JPEG the host already
 * produces, so there's no extra capture. Throttled so it costs little CPU.
 */
export class RegionWatcher {
  private readonly regions = new Map<string, Tracked>();
  private sharp: any = undefined;
  private lastCheck = 0;
  private busy = false;

  constructor(private readonly hub: NotificationHub) {}

  get count(): number {
    return this.regions.size;
  }

  list(): WatchRegion[] {
    return [...this.regions.values()].map((t) => t.region);
  }

  add(region: WatchRegion): void {
    this.regions.set(region.id, { region, baseline: null, lastNotifiedAt: 0 });
    log.info(`region watcher added: "${region.label}" (${this.regions.size} total)`);
  }

  remove(id: string): void {
    if (this.regions.delete(id)) log.info(`region watcher removed (${this.regions.size} left)`);
  }

  /** Reset baselines (e.g. after a display switch) so we don't false-fire. */
  resetBaselines(): void {
    for (const t of this.regions.values()) t.baseline = null;
  }

  private async getSharp(): Promise<any> {
    if (this.sharp !== undefined) return this.sharp;
    const mod = await optionalImport("sharp");
    this.sharp = mod ? (mod.default ?? mod) : null;
    if (!this.sharp) log.warn("region watchers need `sharp` — not available, watching disabled");
    return this.sharp;
  }

  /** Feed the latest full-screen JPEG. Internally throttled; safe to call every frame. */
  check(jpeg: Buffer): void {
    if (this.regions.size === 0 || this.busy) return;
    const now = Date.now();
    if (now - this.lastCheck < CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    this.busy = true;
    void this.run(jpeg).finally(() => {
      this.busy = false;
    });
  }

  private async run(jpeg: Buffer): Promise<void> {
    const sharp = await this.getSharp();
    if (!sharp) return;

    let meta: { width?: number; height?: number };
    try {
      meta = await sharp(jpeg).metadata();
    } catch {
      return;
    }
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return;

    for (const tracked of this.regions.values()) {
      const { region } = tracked;
      const left = Math.max(0, Math.min(W - 1, Math.round(region.x * W)));
      const top = Math.max(0, Math.min(H - 1, Math.round(region.y * H)));
      const width = Math.max(1, Math.min(W - left, Math.round(region.w * W)));
      const height = Math.max(1, Math.min(H - top, Math.round(region.h * H)));

      let thumb: Buffer;
      try {
        thumb = await sharp(jpeg)
          .extract({ left, top, width, height })
          .resize(SAMPLE, SAMPLE, { fit: "fill" })
          .greyscale()
          .raw()
          .toBuffer();
      } catch {
        continue;
      }

      if (!tracked.baseline) {
        tracked.baseline = thumb;
        continue;
      }

      const diff = meanDiff(tracked.baseline, thumb);
      if (diff > CHANGE_THRESHOLD) {
        const now = Date.now();
        if (now - tracked.lastNotifiedAt > COOLDOWN_MS) {
          tracked.lastNotifiedAt = now;
          tracked.baseline = thumb; // re-arm to the new state
          this.hub.emit({
            title: `Changed: ${region.label}`,
            body: "The watched area of your screen changed.",
            level: "success",
            source: `region:${region.id}`,
          });
        }
      }
    }
  }
}

function meanDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / (n * 255);
}
