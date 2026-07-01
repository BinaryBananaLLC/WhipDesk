import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import { log } from "../logger";

const exec = promisify(execFile);

/**
 * Real video pipeline (always on). A BUNDLED ffmpeg (`ffmpeg-static` — no system install, no
 * flags) grabs the screen DIRECTLY with the OS capture device (avfoundation on macOS, gdigrab on
 * Windows, x11grab on Linux) and hardware-encodes it to a SINGLE H.264 RTP stream on a WebRTC
 * video track. The browser decodes it in hardware via a plain `<video>` element.
 *
 * ONE capture. At fit it carries the whole desktop on a single track; when the user SETTLES a zoom
 * the track is re-cropped server-side to just that region (native-resolution, so it's pixel-sharp)
 * and re-keys once. WHILE CROPPED a SECOND low-res full-desktop "overview" track is emitted from the
 * SAME ffmpeg via a `split` filter (the full frame exists in the pipeline before the crop) — the
 * controller uses it for the minimap + the base layer under a pan, kept live without ever zooming
 * out. Hard-won macOS facts that shaped this:
 *  - Two concurrent avfoundation screen CAPTURES deadlock (both yield zero frames), so the overview
 *    is NOT a second grab — it's a second encode of the one capture's frames (split → 2 RTP outputs).
 *  - ffmpeg-static can't change a crop live (no `zmq`), so a zoom change restarts the one ffmpeg.
 *    The controller debounces to the SETTLED region (no per-pan thrash) and digital-zooms its last
 *    frame to bridge the ~0.3s re-key, so the picture never stretches or blanks.
 *  - avfoundation reports a bogus `tbr=1000k`; without `-fps_mode vfr` ffmpeg duplicates frames
 *    toward a million fps and the RTP muxer drowns. `-use_wallclock_as_timestamps 1` + `-fps_mode
 *    vfr` give the muxer sane timing.
 *
 * This is the ONLY screen path — there is no JPEG/screenshot fallback.
 */

/** RTP payload type + clock the encoder emits; the WebRTC layer advertises the same in SDP. */
export const VIDEO_PAYLOAD_TYPE = 96;
export const VIDEO_CLOCK_RATE = 90000;

let encoderName: string | null | undefined;
async function pickH264Encoder(): Promise<string | null> {
  if (encoderName !== undefined) return encoderName;
  if (!ffmpegPath) {
    encoderName = null;
    return null;
  }
  try {
    const { stdout } = await exec(ffmpegPath, ["-hide_banner", "-encoders"]);
    if (process.platform === "darwin" && /h264_videotoolbox/.test(stdout)) encoderName = "h264_videotoolbox";
    else if (/\blibx264\b/.test(stdout)) encoderName = "libx264";
    else if (/h264_videotoolbox/.test(stdout)) encoderName = "h264_videotoolbox";
    else encoderName = null;
  } catch {
    encoderName = null;
  }
  return encoderName;
}

/** True when a WebRTC video track can be produced (bundled ffmpeg + a usable H.264 encoder). */
export async function videoEncodingAvailable(): Promise<boolean> {
  if (!ffmpegPath) {
    log.warn("bundled ffmpeg not found for this platform — screen sharing unavailable");
    return false;
  }
  const enc = await pickH264Encoder();
  if (!enc) {
    log.warn("no usable H.264 encoder in bundled ffmpeg — screen sharing unavailable");
    return false;
  }
  return true;
}

/** A normalized [0,1] crop of the desktop. null = full screen. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

const isFull = (r: Region | null): boolean =>
  !r || (r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999);

/** One full-desktop (or cropped) screen-capture -> H.264 RTP pipeline. */
export interface CaptureConfig {
  /** Active display index, mapped to the platform's capture device (avfoundation/gdigrab/x11grab). */
  displayIndex: number;
  /** Crop to this sub-region (normalized) before scaling — the server-side zoom. null = whole screen. */
  crop: Region | null;
  fps: number;
  kbps: number;
  /** Output width cap (px); height keeps aspect. Capture is native-res then scaled to this. */
  maxWidth: number;
  /** When set AND cropped, also emit a low-res full-desktop overview from the same ffmpeg (split). */
  overview?: OverviewConfig | null;
}

/** Low-res full-desktop second track, encoded alongside the cropped main track from one capture. */
export interface OverviewConfig {
  width: number;
  fps: number;
  kbps: number;
}

// macOS avfoundation lists screen-capture devices AFTER cameras, so the device index for
// "Capture screen N" is machine-dependent (e.g. the camera is [0] and "Capture screen 0" is [1]).
// Probe ffmpeg ONCE and map screen N -> device index. Cache the in-flight PROMISE (not the Map) so
// two near-simultaneous callers can't race: marking the Map "present" before the async probe
// finished let a second caller read an empty Map and wrongly conclude "no device".
let avScreenMapPromise: Promise<Map<number, string>> | null = null;
async function avScreenIndex(displayId: number): Promise<string | null> {
  if (process.platform !== "darwin" || !ffmpegPath) return null;
  if (!avScreenMapPromise) {
    avScreenMapPromise = (async () => {
      const map = new Map<number, string>();
      try {
        // This intentionally fails (no real input) but prints the device list to stderr.
        await exec(ffmpegPath!, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
      } catch (error) {
        const out = String((error as { stderr?: string }).stderr ?? "");
        for (const m of out.matchAll(/\[(\d+)\]\s+Capture screen (\d+)/g)) map.set(Number(m[2]), m[1]!);
      }
      return map;
    })();
  }
  const map = await avScreenMapPromise;
  return map.get(displayId) ?? map.get(0) ?? null;
}

/**
 * ffmpeg input args to grab the screen DIRECTLY on this platform, or null if unsupported.
 *
 * macOS: avfoundation. CRITICAL — the screen device only supports uyvy422/yuyv422/nv12 capture
 * pixel formats; if `-pixel_format` is omitted ffmpeg defaults to yuv420p and the device rejects
 * it ("Selected pixel format (yuv420p) is not supported by the input device"), so capture produces
 * ZERO frames. We pin `nv12` (4:2:0, what VideoToolbox encodes natively). The harmless
 * `NSKVONotifying_AVCaptureScreenInput not linked` line on stderr is a known ffmpeg-static cosmetic
 * warning, not a failure.
 */
async function captureDeviceFor(displayIndex: number, fps: number): Promise<string[] | null> {
  const r = String(Math.max(1, Math.min(60, Math.round(fps))));
  if (process.platform === "darwin") {
    const idx = await avScreenIndex(displayIndex);
    if (idx == null) return null;
    return ["-f", "avfoundation", "-capture_cursor", "1", "-pixel_format", "nv12", "-framerate", r, "-i", `${idx}:none`];
  }
  if (process.platform === "win32") {
    return ["-f", "gdigrab", "-framerate", r, "-i", "desktop"];
  }
  if (process.platform === "linux") {
    return ["-f", "x11grab", "-framerate", r, "-i", process.env.DISPLAY || ":0.0"];
  }
  return null;
}

/** Build the scale (+optional crop) filter. Comma inside min() is escaped for the filtergraph. */
function videoFilter(crop: Region | null, maxWidth: number): string {
  const scale = `scale=min(${Math.round(maxWidth)}\\,iw):-2`;
  if (isFull(crop)) return scale;
  const c = crop!;
  return `crop=iw*${c.w.toFixed(4)}:ih*${c.h.toFixed(4)}:iw*${c.x.toFixed(4)}:ih*${c.y.toFixed(4)},${scale}`;
}

/** Overview branch of the split graph: the FULL frame scaled small and decimated to a few fps. */
function overviewFilter(ov: OverviewConfig): string {
  return `scale=min(${Math.round(ov.width)}\\,iw):-2,fps=${Math.max(1, Math.round(ov.fps))}`;
}

function sameCrop(a: Region | null, b: Region | null): boolean {
  if (isFull(a) && isFull(b)) return true;
  if (!a || !b) return false;
  const e = 0.002;
  return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.w - b.w) < e && Math.abs(a.h - b.h) < e;
}
/** True when two configs would produce an identical ffmpeg pipeline (only crop + display change). */
function sameConfig(a: CaptureConfig, b: CaptureConfig): boolean {
  return a.displayIndex === b.displayIndex && sameCrop(a.crop, b.crop);
}

const kbpsArg = (kbps: number): string => `${Math.max(80, Math.round(kbps))}k`;

/** A werift video track (or anything) that consumes raw RTP packets. */
export interface VideoTrackSink {
  writeRtp(packet: Buffer): void;
}

/**
 * ONE screen capture hardware-encoded into a single H.264 RTP stream — the whole desktop, or a
 * native-resolution crop (server-side zoom). A short GOP self-heals the stream after packet loss; a
 * health monitor restarts a capture that stalls (e.g. the display sleeps). One that never yields a
 * frame (no Screen Recording permission) is reported via `onError` after a few tries — there is NO
 * JPEG fallback. `reconfigure` (zoom / display switch) restarts the one ffmpeg; the controller
 * debounces zoom to the settled region so this happens at most once per zoom gesture.
 */
export class ScreenCaptureSession {
  private proc: ChildProcessByStdio<null, null, Readable> | null = null;
  private sock: Socket | null = null;
  /** Second RTP socket for the overview output (only bound while cropped + overview configured). */
  private sockOv: Socket | null = null;
  private listener: ((packet: Buffer) => void) | null = null;
  private overviewListener: ((packet: Buffer) => void) | null = null;
  /** Fired once per (re)spawn when its FIRST frame reaches the wire, with the crop that spawn used. */
  private activeListener: ((crop: Region | null) => void) | null = null;
  private health: ReturnType<typeof setInterval> | null = null;
  private spawnAt = 0;
  private lastPacketAt = 0;
  private everGotPacket = false;
  private deadRestarts = 0;
  private erroredOut = false;
  private stopped = false;
  private restarting = false;
  /** Config the running ffmpeg was built from; lets a restart detect that `cfg` moved during it. */
  private appliedCfg: CaptureConfig | null = null;

  /** Don't declare a not-yet-producing capture dead until it's had this long to start up. */
  private static readonly FIRST_FRAME_GRACE_MS = 6000;
  /** Once it HAS produced frames, restart if it goes silent this long (display sleep, etc.). */
  private static readonly STALL_MS = 5000;
  /** Give up on a capture that has NEVER produced a frame after this many restarts (permission). */
  private static readonly MAX_DEAD_RESTARTS = 2;

  constructor(private cfg: CaptureConfig, private readonly onError?: () => void) {}

  onRtp(cb: (packet: Buffer) => void): void {
    this.listener = cb;
  }

  /** RTP for the overview output (full desktop, low-res). Fires only while cropped. */
  onOverviewRtp(cb: (packet: Buffer) => void): void {
    this.overviewListener = cb;
  }

  /** Fires when a (re)cropped capture produces its first frame — the new region is now LIVE. */
  onActive(cb: (crop: Region | null) => void): void {
    this.activeListener = cb;
  }

  async start(): Promise<void> {
    await this.spawn();
  }

  /** Change the zoom crop or target display. A no-op when nothing changed, so a redundant viewport
   * echo never restarts ffmpeg. If a restart is already running (the controller settled a new zoom
   * mid-restart) we stash the new config — the running restart loop applies it when it finishes. */
  async reconfigure(patch: Partial<CaptureConfig>): Promise<void> {
    const next = { ...this.cfg, ...patch };
    if (sameConfig(next, this.cfg)) return;
    this.cfg = next;
    if (this.stopped || this.restarting) return;
    await this.restart();
  }

  stop(): void {
    this.stopped = true;
    this.listener = null;
    this.kill();
  }

  private async spawn(): Promise<boolean> {
    if (this.stopped) return false;
    const cfg = this.cfg;
    const enc = await pickH264Encoder();
    const capture = await captureDeviceFor(cfg.displayIndex, cfg.fps);
    if (!enc || !ffmpegPath || !capture) {
      if (!capture) log.warn("no direct screen-capture device on this platform — screen sharing unavailable");
      this.fail();
      return false;
    }

    // The overview is worth sending ONLY while cropped — uncropped, the main track already carries
    // the whole desktop. So a zoom-in (crop set) brings the 2nd output up at the re-crop restart, and
    // a zoom-out (crop cleared) drops back to the unchanged single-output pipeline.
    const ov = !isFull(cfg.crop) && cfg.overview ? cfg.overview : null;

    let sock: Socket;
    let sockOv: Socket | null = null;
    try {
      sock = await bindUdp();
      if (ov) sockOv = await bindUdp();
    } catch {
      if (sockOv) closeQuietly(sockOv);
      this.fail();
      return false;
    }
    if (this.stopped) {
      closeQuietly(sock);
      if (sockOv) closeQuietly(sockOv);
      return false;
    }
    const port = (sock.address() as { port: number }).port;
    const portOv = sockOv ? (sockOv.address() as { port: number }).port : 0;
    const preset = enc === "libx264" ? ["-preset", "ultrafast", "-tune", "zerolatency"] : ["-realtime", "1"];
    // Shared input: stamp frames with monotonic wall-clock PTS (avfoundation's own timestamps are
    // unreliable); paired with each output's `-fps_mode vfr` this gives the RTP muxer sane timing.
    const input = ["-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-use_wallclock_as_timestamps", "1", ...capture, "-an"];
    // One H.264 RTP output: vfr (avfoundation reports a bogus tbr=1000k; without VFR ffmpeg duplicates
    // frames toward a million fps and the RTP muxer drowns), short GOP self-heals after loss.
    const h264Out = (kbps: number, gop: number, ssrc: string, outPort: number): string[] => [
      "-fps_mode", "vfr",
      "-c:v", enc, ...preset,
      "-pix_fmt", "yuv420p",
      "-g", String(gop),
      "-b:v", kbpsArg(kbps),
      "-maxrate", kbpsArg(kbps),
      "-bufsize", kbpsArg(kbps * 2),
      "-payload_type", String(VIDEO_PAYLOAD_TYPE),
      "-ssrc", ssrc,
      "-f", "rtp", `rtp://127.0.0.1:${outPort}?pkt_size=1200`,
    ];
    const mainGop = Math.max(10, Math.round(cfg.fps));
    const args = ov
      ? [
          ...input,
          // The full captured frame fans into two encodes: [m] the sharp crop, [o] the small overview.
          "-filter_complex",
          `[0:v]split=2[m][o];[m]${videoFilter(cfg.crop, cfg.maxWidth)}[mainout];[o]${overviewFilter(ov)}[ovout]`,
          "-map", "[mainout]", ...h264Out(cfg.kbps, mainGop, "1", port),
          "-map", "[ovout]", ...h264Out(ov.kbps, Math.max(1, Math.round(ov.fps)), "2", portOv),
        ]
      : [...input, "-vf", videoFilter(cfg.crop, cfg.maxWidth), ...h264Out(cfg.kbps, mainGop, "1", port)];

    let proc: ChildProcessByStdio<null, null, Readable>;
    try {
      // No stdin: direct capture reads the screen device, never a pipe.
      proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      log.warn("video encoder failed to start:", (error as Error).message);
      closeQuietly(sock);
      if (sockOv) closeQuietly(sockOv);
      this.fail();
      return false;
    }
    this.proc = proc;
    this.sock = sock;
    this.sockOv = sockOv;
    this.appliedCfg = cfg;
    this.spawnAt = Date.now();
    this.lastPacketAt = Date.now();
    // The crop THIS spawn encodes; the first packet means its frames are now LIVE on the wire.
    const spawnCrop = cfg.crop;
    let firstPacket = true;
    sock.on("message", (msg) => {
      this.lastPacketAt = Date.now();
      this.everGotPacket = true;
      this.deadRestarts = 0;
      if (firstPacket) {
        firstPacket = false;
        this.activeListener?.(spawnCrop);
      }
      this.listener?.(msg);
    });
    sock.on("error", () => {
      /* dies on stop */
    });
    if (sockOv) {
      // Overview packets are best-effort and DON'T feed the health monitor (it keys on the main track).
      sockOv.on("message", (msg) => this.overviewListener?.(msg));
      sockOv.on("error", () => {
        /* dies on stop */
      });
    }
    proc.stderr.on("data", (d: Buffer) => {
      // ffmpeg's stderr arrives in multi-line chunks. Log line-by-line and DROP the harmless
      // macOS objc/KVO chatter ffmpeg-static prints when avfoundation loads ("class
      // `NSKVONotifying_AVCaptureScreenInput' not linked into application") — it's cosmetic, capture
      // works fine, and surfacing it just alarms users. Real ffmpeg errors still come through.
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (!t || /^objc\[|NSKVONotifying|not linked into application/.test(t)) continue;
        log.debug("ffmpeg:", t.slice(0, 200));
      }
    });
    proc.on("error", (e) => log.warn("video encoder process error:", e.message));
    this.startHealthMonitor();
    log.debug(
      `video: H.264 capture started (${enc}, ${kbpsArg(cfg.kbps)}@${cfg.fps}fps, ${cfg.crop ? "zoomed" : "full desktop"}${ov ? " + overview" : ""})`,
    );
    return true;
  }

  // Self-heal: a capture that produced frames then went silent (display sleep, resolution change)
  // is restarted until it recovers. One that has NEVER produced a frame after the startup grace is
  // almost certainly a permission/device problem, so after a couple of tries we stop and report
  // rather than spin ffmpeg. Single process => a restart never stacks captures (no death-spiral).
  private startHealthMonitor(): void {
    if (this.health) clearInterval(this.health);
    this.health = setInterval(() => {
      if (this.stopped || this.restarting || !this.proc) return;
      const now = Date.now();
      if (this.everGotPacket) {
        if (now - this.lastPacketAt > ScreenCaptureSession.STALL_MS) {
          log.debug("screen capture stalled — restarting");
          void this.restart();
        }
        return;
      }
      if (now - this.spawnAt < ScreenCaptureSession.FIRST_FRAME_GRACE_MS) return;
      if (++this.deadRestarts > ScreenCaptureSession.MAX_DEAD_RESTARTS) {
        this.kill();
        this.fail();
        return;
      }
      void this.restart();
    }, 1000);
    this.health.unref?.();
  }

  private async restart(): Promise<void> {
    if (this.stopped || this.restarting) return;
    this.restarting = true;
    try {
      // Loop so a config change that lands DURING a restart (settled a new zoom) is applied: spawn
      // snaps the config it used into `appliedCfg`; if `cfg` moved past it, go round again.
      do {
        this.kill();
        if (!(await this.spawn())) break;
      } while (!this.stopped && this.appliedCfg !== null && !sameConfig(this.cfg, this.appliedCfg));
    } finally {
      this.restarting = false;
    }
  }

  private fail(): void {
    if (this.erroredOut) return;
    this.erroredOut = true;
    log.error("screen capture is not producing frames — check Screen Recording permission");
    this.onError?.();
  }

  private kill(): void {
    if (this.health) {
      clearInterval(this.health);
      this.health = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    if (this.sock) {
      closeQuietly(this.sock);
      this.sock = null;
    }
    if (this.sockOv) {
      closeQuietly(this.sockOv);
      this.sockOv = null;
    }
  }
}

function bindUdp(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.once("error", reject);
    sock.bind(0, "127.0.0.1", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
  });
}
function closeQuietly(sock: Socket): void {
  try {
    sock.close();
  } catch {
    /* ignore */
  }
}

export interface VideoHubOptions {
  /** Current active display index (read live so a display switch re-targets the capture). */
  displayIndex: () => number;
  fps: number;
  kbps: number;
  maxWidth: number;
  /** Low-res full-desktop overview, emitted as a 2nd track while cropped. null = no overview track. */
  overview?: OverviewConfig | null;
  /** Fired when the capture gives up producing frames (e.g. no Screen Recording permission). */
  onError?: () => void;
  /** Fired when a (re)cropped capture's first frame reaches the wire — the new region is now LIVE. */
  onCropActive?: (crop: Region | null) => void;
}

/**
 * Owns the agent's ONE shared {@link ScreenCaptureSession} and fans its RTP to every attached
 * WebRTC track. The session starts lazily on the first attached track and stops when the last one
 * leaves, so an idle agent spawns no ffmpeg. `setViewport` re-crops the single track to the
 * controller's settled zoom region (the only time the capture restarts besides a display switch).
 */
export class VideoHub {
  private session: ScreenCaptureSession | null = null;
  private starting: Promise<void> | null = null;
  private readonly sinks = new Set<VideoTrackSink>();
  /** Overview-track sinks (the 2nd, low-res full-desktop output that flows only while cropped). */
  private readonly overviewSinks = new Set<VideoTrackSink>();
  private crop: Region | null = null;

  constructor(private readonly opts: VideoHubOptions) {}

  get size(): number {
    return this.sinks.size;
  }

  async attach(sink: VideoTrackSink): Promise<void> {
    this.sinks.add(sink);
    await this.ensureSession();
  }

  detach(sink: VideoTrackSink): void {
    this.sinks.delete(sink);
    this.maybeStop();
  }

  /** Attach a sink for the low-res full-desktop overview track (carries RTP only while cropped). */
  async attachOverview(sink: VideoTrackSink): Promise<void> {
    this.overviewSinks.add(sink);
    await this.ensureSession();
  }

  detachOverview(sink: VideoTrackSink): void {
    this.overviewSinks.delete(sink);
    this.maybeStop();
  }

  private maybeStop(): void {
    if (this.sinks.size === 0 && this.overviewSinks.size === 0 && this.session) {
      this.session.stop();
      this.session = null;
      this.crop = null; // next session starts on the full screen
    }
  }

  /** Server-side zoom: re-crop the track to the settled region (sharp, native-res). null = full. */
  setViewport(crop: Region | null): void {
    this.crop = isFull(crop) ? null : crop;
    void this.session?.reconfigure({ crop: this.crop });
  }

  setDisplay(index: number): void {
    this.crop = null;
    void this.session?.reconfigure({ displayIndex: index, crop: null });
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const session = new ScreenCaptureSession(
        {
          displayIndex: this.opts.displayIndex(),
          crop: this.crop,
          fps: this.opts.fps,
          kbps: this.opts.kbps,
          maxWidth: this.opts.maxWidth,
          overview: this.opts.overview ?? null,
        },
        this.opts.onError,
      );
      session.onRtp((p) => this.fan(p));
      session.onOverviewRtp((p) => this.fanOverview(p));
      if (this.opts.onCropActive) session.onActive((crop) => this.opts.onCropActive!(crop));
      await session.start();
      // The controller may have disconnected during startup — don't leave ffmpeg orphaned.
      if (this.sinks.size === 0 && this.overviewSinks.size === 0) session.stop();
      else this.session = session;
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  private fan(packet: Buffer): void {
    for (const sink of this.sinks) {
      try {
        sink.writeRtp(packet);
      } catch {
        /* a dead track shouldn't break the others */
      }
    }
  }

  private fanOverview(packet: Buffer): void {
    for (const sink of this.overviewSinks) {
      try {
        sink.writeRtp(packet);
      } catch {
        /* a dead track shouldn't break the others */
      }
    }
  }
}
