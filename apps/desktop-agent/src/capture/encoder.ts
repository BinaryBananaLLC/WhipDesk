import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import { invalidateHdrCache, windowsHdrState } from "./hdr-win";
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

/** How to feed one platform's screen into ffmpeg: the input-side args plus any filter chain needed
 * to land frames in system memory (Windows ddagrab yields GPU/D3D11 frames). */
interface CaptureSource {
  inputArgs: string[];
  /** Comma-terminated filter run BEFORE any crop/scale. "" when frames are already in RAM. */
  hwPrefix: string;
  /** Comma-LED filter appended AFTER each branch's crop/scale (e.g. HDR→SDR tone map — placed
   * post-scale so the pricey float math runs at output size, not native 4K). "" when unneeded. */
  postFilter: string;
  /** True when this source captures an HDR desktop and tone-maps it (for the start log line). */
  winHdr?: boolean;
}

/**
 * HDR desktop → SDR H.264. With HDR ON, Windows composites the desktop in scRGB (linear FP16,
 * 1.0 = SDR reference white); duplicating it as 8-bit BGRA is a raw truncation — the grey
 * "washed out" remote image. So the HDR path duplicates the real FP16 frames and tone-maps:
 * hable handles the unbounded scRGB highlights, then zscale re-encodes gamma + converts to
 * BT.709 YUV (tin=linear tells it the input is already linear light). The bundled ffmpeg ships
 * zscale/tonemap (libzimg) — verified against ffmpeg-static.
 */
const HDR_TONEMAP =
  ",tonemap=tonemap=hable:desat=0:peak=10" +
  ",zscale=tin=linear:pin=bt709:t=bt709:p=bt709:m=bt709:r=tv,format=yuv420p";

/**
 * ffmpeg input args to grab the screen DIRECTLY on this platform, or null if unsupported.
 *
 * macOS: avfoundation. CRITICAL — the screen device only supports uyvy422/yuyv422/nv12 capture
 * pixel formats; if `-pixel_format` is omitted ffmpeg defaults to yuv420p and the device rejects
 * it ("Selected pixel format (yuv420p) is not supported by the input device"), so capture produces
 * ZERO frames. We pin `nv12` (4:2:0, what VideoToolbox encodes natively). The harmless
 * `NSKVONotifying_AVCaptureScreenInput not linked` line on stderr is a known ffmpeg-static cosmetic
 * warning, not a failure.
 *
 * Windows: ddagrab (Desktop Duplication API, GPU). Unlike gdigrab's GDI BitBlt it reads the DWM
 * composited surface, so it stays fast at 4K AND captures HDR desktops — gdigrab returns black /
 * artifacts on HDR. ddagrab yields D3D11 frames, so `hwPrefix` downloads them to RAM before the
 * crop/scale filters. `output_idx` selects the monitor (gdigrab could only grab the whole virtual
 * desktop). `dup_frames` stays on (default) so frames flow steadily and the stall monitor never
 * false-trips on a static screen. A ddagrab that never produces a frame (no D3D11 / older Windows)
 * falls back to gdigrab via `winFallback`. When the desktop is HDR (hdr-win.ts probe), an 8-bit
 * duplication would be a washed-out truncation — the HDR chain grabs scRGB FP16 and tone-maps to
 * SDR instead (see HDR_TONEMAP). HDR toggles mid-session kill ddagrab ("Output parameters
 * changed" / AcquireNextFrame 0x887A0026 = DXGI_ERROR_ACCESS_LOST); the stderr watcher drops the
 * HDR cache and the unexpected-exit handler respawns within ~0.5s on the re-probed chain.
 *
 * Linux: x11grab.
 */
async function captureDeviceFor(displayIndex: number, fps: number, winFallback: boolean): Promise<CaptureSource | null> {
  const r = String(Math.max(1, Math.min(60, Math.round(fps))));
  // Wall-clock PTS override for the raw-grab demuxers whose own timestamps are unreliable.
  const ts = ["-fflags", "+genpts", "-use_wallclock_as_timestamps", "1"];
  if (process.platform === "darwin") {
    const idx = await avScreenIndex(displayIndex);
    if (idx == null) return null;
    return {
      inputArgs: [...ts, "-f", "avfoundation", "-capture_cursor", "1", "-pixel_format", "nv12", "-framerate", r, "-i", `${idx}:none`],
      hwPrefix: "",
      postFilter: "",
    };
  }
  if (process.platform === "win32") {
    if (winFallback) {
      return { inputArgs: [...ts, "-f", "gdigrab", "-framerate", r, "-i", "desktop"], hwPrefix: "", postFilter: "" };
    }
    // ddagrab drives its own PTS at `framerate`, so no wallclock override; hwdownload brings the
    // D3D11 frame to system memory for the software (libx264) filters + encoder.
    const idx = Math.max(0, Math.round(displayIndex));
    // HDR desktop: duplicate the real scRGB FP16 frames and tone-map to SDR (see HDR_TONEMAP).
    // The probe is cached (~0.5s cold, free warm), so re-crop restarts don't pay for it. If the
    // state flipped since the cache (HDR toggled), ddagrab dies with "Output parameters changed" /
    // "Requested output format unavailable" — the stderr watcher invalidates the cache and the
    // quick-restart respawns with the right chain.
    const hdr = (await windowsHdrState())?.active === true;
    if (hdr) {
      return {
        inputArgs: ["-f", "lavfi", "-i", `ddagrab=output_idx=${idx}:framerate=${r}:draw_mouse=1:output_fmt=rgbaf16`],
        // gbrpf32le BEFORE the split/crop/scale: swscale handles planar-float scaling everywhere,
        // while direct rgbaf16 scaling is spottier across builds. Tone-mapping itself stays
        // per-branch AFTER the scale (postFilter) so the heavy math runs at ≤maxWidth, not 4K.
        hwPrefix: "hwdownload,format=rgbaf16,format=gbrpf32le,",
        postFilter: HDR_TONEMAP,
        winHdr: true,
      };
    }
    return {
      inputArgs: ["-f", "lavfi", "-i", `ddagrab=output_idx=${idx}:framerate=${r}:draw_mouse=1`],
      hwPrefix: "hwdownload,format=bgra,",
      postFilter: "",
    };
  }
  if (process.platform === "linux") {
    return { inputArgs: [...ts, "-f", "x11grab", "-framerate", r, "-i", process.env.DISPLAY || ":0.0"], hwPrefix: "", postFilter: "" };
  }
  return null;
}

/** Build the scale (+optional crop) filter. Comma inside min() is escaped for the filtergraph.
 * The width is truncated to an even value (`trunc(w/2)*2`) — libx264 needs BOTH dimensions divisible
 * by 2, and a narrow crop (cropped width < maxWidth) would otherwise pass an ODD native width
 * straight through the scale and make the encoder abort ("width not divisible by 2"). `-2` on the
 * height already keeps it even; this makes the width match. */
function videoFilter(crop: Region | null, maxWidth: number): string {
  const scale = `scale=trunc(min(${Math.round(maxWidth)}\\,iw)/2)*2:-2`;
  if (isFull(crop)) return scale;
  const c = crop!;
  return `crop=iw*${c.w.toFixed(4)}:ih*${c.h.toFixed(4)}:iw*${c.x.toFixed(4)}:ih*${c.y.toFixed(4)},${scale}`;
}

/** Overview branch of the split graph: the FULL frame scaled small and decimated to a few fps.
 * Width truncated to even for the same libx264 reason as videoFilter(). */
function overviewFilter(ov: OverviewConfig): string {
  return `scale=trunc(min(${Math.round(ov.width)}\\,iw)/2)*2:-2,fps=${Math.max(1, Math.round(ov.fps))}`;
}

function sameCrop(a: Region | null, b: Region | null): boolean {
  if (isFull(a) && isFull(b)) return true;
  if (!a || !b) return false;
  const e = 0.002;
  return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.w - b.w) < e && Math.abs(a.h - b.h) < e;
}
/** True when two configs would produce an identical ffmpeg pipeline. */
function sameConfig(a: CaptureConfig, b: CaptureConfig): boolean {
  return (
    a.displayIndex === b.displayIndex &&
    sameCrop(a.crop, b.crop) &&
    a.fps === b.fps &&
    a.kbps === b.kbps
  );
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
  /** Whether the CURRENT spawn has delivered any packet — distinguishes a capture that "went
   * silent" from one that never started (the avfoundation zero-frame deadlock) in stall logs. */
  private spawnGotPacket = false;
  /** Consecutive stall-restarts whose spawn never produced a frame (resets on any packet). */
  private framelessRestarts = 0;
  /** Resolves the restart loop's bounded wait as soon as the current spawn's first packet lands. */
  private firstPacketWaiter: (() => void) | null = null;
  private deadRestarts = 0;
  private erroredOut = false;
  private stopped = false;
  private restarting = false;
  /** Config the running ffmpeg was built from; lets a restart detect that `cfg` moved during it. */
  private appliedCfg: CaptureConfig | null = null;
  /** Windows only: set once ddagrab fails to produce a frame, switching capture to gdigrab. */
  private winCaptureFallback = false;

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
    // Route the initial spawn through restart() so it holds the `restarting` lock: a reconfigure
    // that lands DURING startup (a zoomed controller re-asserts its crop the moment it's admitted)
    // then just updates `cfg` for the loop instead of racing a SECOND concurrent spawn. Two
    // concurrent spawns end with one ffmpeg orphaned but still streaming — interleaved RTP from
    // two different crops on one track, i.e. the client renders the WRONG part of the screen.
    await this.restart();
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
    const capture = await captureDeviceFor(cfg.displayIndex, cfg.fps, this.winCaptureFallback);
    if (!enc || !ffmpegPath || !capture) {
      if (!capture) log.warn("no direct screen-capture device on this platform — screen sharing unavailable");
      this.fail();
      return false;
    }

    // The overview is worth sending ONLY while cropped — uncropped, the main track already carries
    // the whole desktop. So a zoom-in (crop set) brings the 2nd output up at the re-crop restart, and
    // a zoom-out (crop cleared) drops back to the unchanged single-output pipeline.
    const ov = !isFull(cfg.crop) && cfg.overview ? cfg.overview : null;

    let sock: Socket | null = null;
    let sockOv: Socket | null = null;
    try {
      sock = await bindUdp();
      if (ov) {
        sockOv = await bindUdp();
        // ffmpeg's RTP muxer also binds a LOCAL port adjacent to the one it sends to (RTCP), and
        // the OS loves handing out consecutive ephemeral ports — adjacent receive sockets then
        // collide with it ("bind failed: Address already in use" on stderr; harmless but noisy,
        // and it costs that output its RTCP). Re-bind the overview socket until non-adjacent.
        for (let tries = 0; tries < 4; tries++) {
          const p = (sock.address() as { port: number }).port;
          const q = (sockOv.address() as { port: number }).port;
          if (Math.abs(p - q) > 1) break;
          const again = await bindUdp();
          closeQuietly(sockOv);
          sockOv = again;
        }
      }
    } catch {
      if (sock) closeQuietly(sock);
      if (sockOv) closeQuietly(sockOv);
      this.fail();
      return false;
    }
    if (!sock) return false;
    if (this.stopped) {
      closeQuietly(sock);
      if (sockOv) closeQuietly(sockOv);
      return false;
    }
    const port = (sock.address() as { port: number }).port;
    const portOv = sockOv ? (sockOv.address() as { port: number }).port : 0;
    const preset = enc === "libx264" ? ["-preset", "ultrafast", "-tune", "zerolatency"] : ["-realtime", "1"];
    // Input flags are platform-specific (see captureDeviceFor); paired with each output's
    // `-fps_mode vfr` they give the RTP muxer sane timing.
    const input = ["-hide_banner", "-loglevel", "error", ...capture.inputArgs, "-an"];
    // One H.264 RTP output: vfr (avfoundation reports a bogus tbr=1000k; without VFR ffmpeg duplicates
    // frames toward a million fps and the RTP muxer drowns), short GOP self-heals after loss.
    const h264Out = (kbps: number, gop: number, ssrc: string, outPort: number): string[] => [
      "-fps_mode", "vfr",
      "-c:v", enc, ...preset,
      "-pix_fmt", "yuv420p",
      "-g", String(gop),
      // Also key on WALL-CLOCK time, not just frame count: with VFR a static screen yields few output
      // frames, so a frames-based GOP can leave a lost IDR unrepaired "until something moves". Forcing
      // a keyframe ~1s (by PTS, which advances via -use_wallclock_as_timestamps) guarantees the client
      // can always re-sync within ~1s even with no PLI and a frozen desktop.
      "-force_key_frames", "expr:gte(t,n_forced*1)",
      "-b:v", kbpsArg(kbps),
      "-maxrate", kbpsArg(kbps),
      "-bufsize", kbpsArg(kbps * 2),
      "-payload_type", String(VIDEO_PAYLOAD_TYPE),
      "-ssrc", ssrc,
      // buffer_size = SO_SNDBUF: keyframe bursts must not overflow the send side either (the
      // receive side is widened in bindUdp — see the black-bottom-of-keyframe note there).
      "-f", "rtp", `rtp://127.0.0.1:${outPort}?pkt_size=1200&buffer_size=1048576`,
    ];
    const mainGop = Math.max(10, Math.round(cfg.fps));
    const args = ov
      ? [
          ...input,
          // The full captured frame fans into two encodes: [m] the sharp crop, [o] the small overview.
          // hwPrefix (ddagrab) downloads once, before the split, so both branches get RAM frames.
          // postFilter (HDR tone map) runs per-branch AFTER the scale — cheap at output size.
          "-filter_complex",
          `[0:v]${capture.hwPrefix}split=2[m][o];[m]${videoFilter(cfg.crop, cfg.maxWidth)}${capture.postFilter}[mainout];[o]${overviewFilter(ov)}${capture.postFilter}[ovout]`,
          "-map", "[mainout]", ...h264Out(cfg.kbps, mainGop, "1", port),
          "-map", "[ovout]", ...h264Out(ov.kbps, Math.max(1, Math.round(ov.fps)), "2", portOv),
        ]
      : [...input, "-vf", `${capture.hwPrefix}${videoFilter(cfg.crop, cfg.maxWidth)}${capture.postFilter}`, ...h264Out(cfg.kbps, mainGop, "1", port)];

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
    this.spawnGotPacket = false;
    // The crop THIS spawn encodes; the first packet means its frames are now LIVE on the wire.
    const spawnCrop = cfg.crop;
    let firstPacket = true;
    sock.on("message", (msg) => {
      this.lastPacketAt = Date.now();
      this.everGotPacket = true;
      this.spawnGotPacket = true;
      this.deadRestarts = 0;
      if (firstPacket) {
        firstPacket = false;
        this.framelessRestarts = 0;
        this.firstPacketWaiter?.();
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
        // A display-format change (HDR toggled, mode switch) kills ddagrab with one of these.
        // Drop the cached HDR state NOW so the imminent respawn probes the real state and picks
        // the right capture chain instead of dying again on the stale one.
        if (
          process.platform === "win32" &&
          /AcquireNextFrame failed|Output parameters changed|Requested output format unavailable/i.test(t)
        ) {
          invalidateHdrCache();
        }
        log.debug("ffmpeg:", t.slice(0, 200));
      }
    });
    proc.on("error", (e) => log.warn("video encoder process error:", e.message));
    // A death WE caused nulls this.proc first (kill()); anything else exiting is unexpected —
    // restart PROMPTLY instead of waiting out the 5s stall monitor. This is the recovery path for
    // display-mode flips (HDR toggle kills ddagrab with "Output parameters changed") and plain
    // encoder crashes. A spawn that died young waits longer so a hard-broken pipeline can't spin.
    proc.on("exit", (code, sig) => {
      if (this.proc !== proc || this.stopped) return;
      log.debug(`ffmpeg exited unexpectedly (${code ?? sig ?? "?"})`);
      const delay = Date.now() - this.spawnAt < 2000 ? 2000 : 400;
      const t = setTimeout(() => {
        if (this.proc === proc && !this.stopped) void this.restart();
      }, delay);
      t.unref?.();
    });
    this.startHealthMonitor();
    const cropDesc = isFull(cfg.crop)
      ? "full desktop"
      : `zoomed ${cfg.crop!.x.toFixed(2)},${cfg.crop!.y.toFixed(2)} ${cfg.crop!.w.toFixed(2)}x${cfg.crop!.h.toFixed(2)}`;
    log.debug(
      `video: H.264 capture started (${enc}, ${kbpsArg(cfg.kbps)}@${cfg.fps}fps, ${cropDesc}${ov ? " + overview" : ""}${capture.winHdr ? ", HDR desktop tone-mapped to SDR" : ""})`,
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
        // A spawn that has NEVER produced gets a growing leash: the zero-frame state is
        // perpetuated by tearing down frameless sessions, and a late avfoundation init can
        // succeed where an early kill re-poisons the state. Observed worst HEALTHY
        // spawn->first-packet is ~2s, so 4s is 2x headroom while recovering a cycle sooner
        // than the old 5s+2.5s ladder.
        const stallMs = this.spawnGotPacket
          ? ScreenCaptureSession.STALL_MS
          : Math.min(4000 + this.framelessRestarts * 1500, 10_000);
        if (now - this.lastPacketAt > stallMs) {
          if (!this.spawnGotPacket) this.framelessRestarts += 1;
          log.debug(
            `screen capture stalled — restarting (${this.spawnGotPacket ? "went silent" : `spawn never produced a frame after ${Math.round(stallMs / 1000)}s`})`,
          );
          void this.restart();
        }
        return;
      }
      if (now - this.spawnAt < ScreenCaptureSession.FIRST_FRAME_GRACE_MS) return;
      if (process.platform === "win32" && !this.winCaptureFallback) {
        // ddagrab never produced a frame (no D3D11 / unsupported GPU) — retry once with gdigrab.
        this.winCaptureFallback = true;
        log.debug("screen capture: ddagrab produced no frame — falling back to gdigrab");
        void this.restart();
        return;
      }
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
        await this.killAndWait();
        if (!(await this.spawn())) break;
        // Let the fresh capture reach its FIRST frame (bounded) before a newer crop may replace
        // it: tearing down sessions that never produced is what drives WindowServer into the
        // zero-frame state, and coalescing to the newest crop only after the previous one is
        // live also skips useless intermediate restarts during a swipe burst.
        await this.waitForFirstPacket(3000);
      } while (!this.stopped && this.appliedCfg !== null && !sameConfig(this.cfg, this.appliedCfg));
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Kill the current ffmpeg and WAIT until it has actually EXITED — plus a short macOS beat for
   * WindowServer to release its screen-capture session — before the caller spawns the next one.
   *
   * kill() alone is fire-and-forget: signal delivery and the OS-side capture teardown are both
   * asynchronous, so under re-crop churn (pan swipe after swipe) the next ffmpeg starts while the
   * old capture session is still registered — the documented avfoundation deadlock where BOTH
   * captures yield zero frames. Worse, the health monitor's recovery restart repeats the same
   * unserialized kill→spawn every 5s, re-triggering the overlap each time: the observed
   * "stalled — restarting" loop with no "crop live" ever following, dead for tens of seconds.
   * Serializing exit→settle→spawn removes the overlap entirely, at ~150ms per re-crop.
   */
  private async killAndWait(): Promise<void> {
    const proc = this.proc;
    const exited =
      proc && proc.exitCode === null && proc.signalCode === null
        ? new Promise<void>((resolve) => {
            // Cap past kill()'s 1.5s SIGKILL escalation — a truly unkillable process must not
            // wedge re-crops forever.
            const cap = setTimeout(resolve, 2500);
            cap.unref?.();
            proc.once("exit", () => {
              clearTimeout(cap);
              resolve();
            });
          })
        : null;
    this.kill();
    if (exited) {
      await exited;
      if (process.platform === "darwin") await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Bounded wait for the current spawn's first RTP packet (resolves immediately if it already
   * produced, on stop, or at the cap). See the restart loop for why replacing a capture that
   * hasn't produced yet is dangerous on macOS. */
  private waitForFirstPacket(capMs: number): Promise<void> {
    if (this.spawnGotPacket || this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(cap);
        if (this.firstPacketWaiter === done) this.firstPacketWaiter = null;
        resolve();
      };
      const cap = setTimeout(done, capMs);
      cap.unref?.();
      this.firstPacketWaiter = done;
    });
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
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // SIGTERM, not SIGKILL: ffmpeg's signal handler stops the AVCapture session properly before
      // exiting. SIGKILL gives it no chance to, leaving the dead process's screen-capture session
      // registered in WindowServer — those orphans ACCUMULATE under re-crop churn (pan swipe after
      // swipe) until macOS serves NEW captures zero frames for tens of seconds. Proven by logs:
      // even fully serialized 5s-apart respawns stayed frameless for 47s while the SIGKILL-based
      // stall loop kept re-poisoning the state. Escalate to SIGKILL only if ffmpeg hangs.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // A TERM-responsive ffmpeg exits well under 300ms. One that NEVER produced a frame is
      // usually wedged inside avfoundation init and won't process the signal at all — it needs
      // the KILL anyway, and every extra ms of waiting just extends the recovery outage, so give
      // frameless spawns a much shorter escalation deadline.
      const hardKill = setTimeout(
        () => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        },
        this.spawnGotPacket ? 1500 : 700,
      );
      hardKill.unref?.();
      proc.once("exit", () => clearTimeout(hardKill));
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
      // ffmpeg blasts each encoded frame onto loopback as a burst of ~1200B packets. A 4K
      // keyframe is hundreds of packets — far past the OS default receive buffer (Windows: a few
      // KB) — so the burst's TAIL gets dropped before Node drains the socket, and the client
      // renders the bottom of every keyframe as black/garbage blocks while the top looks fine
      // (small overview frames never overflow, which is why the minimap stayed clean). A few MB
      // of buffer absorbs the worst IDR burst.
      try {
        sock.setRecvBufferSize(4 * 1024 * 1024);
      } catch {
        /* not fatal — small frames still flow */
      }
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
  /** Current encoder rate (adaptive: the quality ladder moves these between reconnects). */
  private kbps: number;
  private fps: number;
  /** True while every controller is backgrounded — the encoder is stopped, sinks are kept. */
  private paused = false;

  constructor(private readonly opts: VideoHubOptions) {
    this.kbps = opts.kbps;
    this.fps = opts.fps;
  }

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

  /** Adaptive quality: retarget the encoder's bitrate/framerate (restart-based, like a re-crop). */
  setQuality(kbps: number, fps: number): void {
    this.kbps = kbps;
    this.fps = fps;
    void this.session?.reconfigure({ kbps, fps });
  }

  /**
   * Nobody is looking (every controller reported hidden): stop the encoder but KEEP the sinks, so
   * the host burns no CPU/bandwidth encoding frames no one sees. Unpausing restarts the capture,
   * which re-keys (fresh IDR) — the controller shows live video again within the usual re-key time.
   * Region watchers/session monitors are untouched: they run on their own samplers, never this one.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      if (this.session) {
        this.session.stop();
        this.session = null;
      }
    } else if (this.sinks.size > 0 || this.overviewSinks.size > 0) {
      void this.ensureSession();
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.paused) return;
    if (this.session) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const session = new ScreenCaptureSession(
        {
          displayIndex: this.opts.displayIndex(),
          crop: this.crop,
          fps: this.fps,
          kbps: this.kbps,
          maxWidth: this.opts.maxWidth,
          overview: this.opts.overview ?? null,
        },
        this.opts.onError,
      );
      session.onRtp((p) => this.fan(p));
      session.onOverviewRtp((p) => this.fanOverview(p));
      if (this.opts.onCropActive) session.onActive((crop) => this.opts.onCropActive!(crop));
      await session.start();
      // The controller may have disconnected (or everyone backgrounded) during startup — don't
      // leave ffmpeg orphaned.
      if (this.paused || (this.sinks.size === 0 && this.overviewSinks.size === 0)) session.stop();
      else {
        this.session = session;
        // A setViewport/setQuality/setDisplay that landed WHILE the session was starting hit a
        // null `this.session` (its reconfigure went nowhere) and would be silently lost — leaving
        // the encoder on a stale crop that the controller believes is already applied (the
        // "wrong viewport that never fixes itself" bug). Re-assert the latest state; reconfigure
        // no-ops when nothing actually moved, so this is free in the common case.
        void session.reconfigure({
          displayIndex: this.opts.displayIndex(),
          crop: this.crop,
          kbps: this.kbps,
          fps: this.fps,
        });
      }
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
