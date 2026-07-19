import type { ScreenInfo, ViewMode } from "@whipdesk/protocol";

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// Target width of the client-derived overview snapshot, and how often to refresh it (ms) while the
// whole desktop is on screen. The overview is a downscaled copy of the last FULL-desktop H.264 frame
// the client already has — no separate host capture (a 2nd screen grab fights the live encoder).
const OVERVIEW_SNAP_W = 480;
const OVERVIEW_SNAP_MS = 600;

// How far the view center may pan past each desktop edge (fraction of the desktop). >0.5
// means an edge can sit past the canvas center, so the bottom of the desktop can be placed
// mid-screen, above the ribbon.
const PAN_MIN = -0.6;
const PAN_MAX = 1.6;

// After the host re-crops, its ffmpeg re-keys and the new frames take a VARIABLE beat to arrive
// (avfoundation re-init alone can exceed half a second). The host now tells us exactly when the new
// crop is live (screen-region active:true → setFrameRegionActive), so this timer is only a FALLBACK
// for an old agent that doesn't send it — kept long so it never preempts the real signal. Until the
// switch we keep drawing the current frame at its PREVIOUS region so it holds its place (no "jump").
const REGION_BRIDGE_MS = 1500;
// Once the host says the new crop is live, wait this much for the client's jitter buffer to actually
// PRESENT that first frame before moving the rectangle — so the switch lands with the new content,
// not a frame early (old content briefly at the new spot) or late (new content at the old spot).
const REGION_ACTIVE_HOLD_MS = 120;

// The minimap fades out this long after the last pan/zoom, then fades back in the moment you move
// again — so it guides you while you're navigating but gets out of the way once you've settled.
const MINIMAP_IDLE_MS = 3000;

/** A normalized [0,1] desktop sub-rectangle. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

function isFull(r: Region | null): boolean {
  return !r || (r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999);
}

/** Same desktop sub-rectangle (both full counts as same). Tolerant of the host's clamp rounding. */
function sameRegion(a: Region | null, b: Region | null): boolean {
  if (isFull(a) && isFull(b)) return true;
  if (!a || !b) return false;
  const e = 0.005;
  return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.w - b.w) < e && Math.abs(a.h - b.h) < e;
}

/**
 * Renders the desktop H.264 track to a canvas and owns the view transform.
 *
 * ONE video track. At fit it carries the whole desktop; when the user settles a zoom the HOST
 * re-crops it to that region (sharp, native-res) and echoes which region the track now covers.
 *
 * Rendering is intentionally TINY and stretch-proof: the track covers desktop region `region`
 * (full, or the host's crop), so we draw it into the canvas rectangle that `region` occupies under
 * the current zoom/pan — and we ALWAYS preserve the video's own aspect ratio inside that rectangle.
 * That single rule means it can never stretch, even in the brief window after a zoom while the new
 * crop's frames are still arriving. The transform is updated live as the user pinches/pans, so the
 * picture tracks the gesture immediately; the host's sharp re-crop lands a moment later.
 * `canvasToNorm` always returns full-desktop normals, so input stays correct at any zoom.
 */
export class ScreenView {
  private readonly ctx: CanvasRenderingContext2D;
  /** The single desktop video track (full desktop, or the host's crop when zoomed). */
  private mainEl: HTMLVideoElement | null = null;
  /** Desktop region the track currently covers (the host's LATEST echo); null = the whole desktop.
   * Drives the minimap immediately. */
  private region: Region | null = null;
  /** Region the CURRENTLY DISPLAYED frame represents; lags `region` by REGION_BRIDGE_MS so the
   * on-screen picture holds its place across a re-crop instead of jumping (see setFrameRegion). */
  private shownRegion: Region | null = null;
  private regionBridge = 0;
  /** Pending jitter-buffer hold before adopting a region the host just reported LIVE. */
  private regionActiveHold = 0;
  /** True once this agent has sent any `active:true` region echo. From then on the blind
   * REGION_BRIDGE_MS fallback is never armed: under re-crop churn (rapid pan swipes) a crop can
   * take far longer than any fixed timer to go live, and a blind flip draws the OLD-crop frame at
   * the NEW rectangle — the "wrong part of the screen" bug. Same-aspect pans have no draw-time
   * safety net, so placement must wait for the host's real signal. */
  private hasActiveEcho = false;

  private screen: ScreenInfo = { width: 0, height: 0 };
  private viewMode: ViewMode = "fit";
  private zoom = 1;
  private center = { nx: 0.5, ny: 0.5 };
  private cursor: { nx: number; ny: number } | null = null;
  private onZoomCb?: (zoom: number) => void;
  private onViewCb?: (region: Region) => void;
  private onGestureCb?: (active: boolean) => void;

  // While a pan/zoom gesture is in progress we DON'T ask the host to re-crop: re-cropping mid-drag
  // thrashes the capture and can land a stale crop while the finger is still moving. We mark the
  // view dirty during the gesture and emit the final region EXACTLY ONCE when the finger lifts.
  // Local rendering still tracks the gesture live (requestDraw), so the picture follows the finger.
  private gestureActive = false;
  private viewDirty = false;

  private videoActive = false;
  private videoRaf = 0;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private layout = { S: 1, tx: 0, ty: 0 };
  private rafPending = false;

  // Minimap = DOM overlay on its OWN animation loop, so the video pipeline can never stop it. Its
  // visibility is driven by the HOST's crop region (this.region) — NOT this.zoom, which can collapse
  // back to ~1 after a crop — so it stays up the whole time you're viewing a sub-region.
  private overlayBox: HTMLDivElement | null = null;
  private overlayView: HTMLDivElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private lastOverlayKey = "";
  private overlayCanvasKey = "";
  /** When the minimap last saw pan/zoom activity (perf.now ms); drives the idle fade-out. */
  private minimapActiveAt = 0;
  /** Current faded-in state, so we only write opacity/transition on an actual change. */
  private minimapShown = true;

  // Low-res full-desktop overview, kept by snapshotting the last FULL-desktop H.264 frame into an
  // offscreen canvas (see maybeSnapshot). Painted into the minimap, and drawn as the base layer under
  // the sharp H.264 frame while zoomed so a pan reveals real (if soft + slightly stale) content off
  // the crop instead of black, until the host's re-crop lands. `overviewReady` gates use until the
  // first snapshot exists; `overviewDirty` forces a minimap repaint when a fresh snapshot lands.
  private overview: HTMLCanvasElement | null = null;
  private overviewCtx: CanvasRenderingContext2D | null = null;
  private overviewReady = false;
  private overviewDirty = false;
  private lastSnapAt = 0;
  // The host's live low-res full-desktop overview track (frames only while the main track is cropped).
  // When present we snapshot IT while zoomed, so the minimap + base layer stay live without zooming
  // out; uncropped we still snapshot the main full-desktop frame. null when no overview track.
  private overviewEl: HTMLVideoElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.createOverlay();
    this.startOverlayLoop();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener("orientationchange", () => window.setTimeout(() => this.resize(), 200));
  }

  /** Build the minimap once: outer box = the whole desktop, inner box = the part on screen.
   * Inline-styled, position:fixed, max z-index, pointer-events:none — can't be covered or eat taps.
   * Sits BELOW the top-right alerts bell (top offset clears the 38px bell) so it never covers it —
   * #app is its own stacking context, so the bell can't be lifted above this fixed max-z overlay. */
  private createOverlay(): void {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;top:calc(env(safe-area-inset-top, 0px) + 56px);right:10px;box-sizing:border-box;" +
      "border:1.5px solid rgba(255,255,255,0.8);border-radius:6px;background:rgba(0,0,0,0.55);" +
      "z-index:2147483600;pointer-events:none;display:none;box-shadow:0 1px 8px rgba(0,0,0,0.6);";
    // Behind the view rect: a canvas showing the live low-res overview (the actual desktop), so the
    // minimap is a real thumbnail, not just an outline. Falls back to the box's dark fill until the
    // first overview frame arrives (or when the host can't produce one — no `sharp`).
    const mini = document.createElement("canvas");
    mini.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:5px;display:block;";
    const view = document.createElement("div");
    view.style.cssText =
      "position:absolute;box-sizing:border-box;border:2px solid #4ea1ff;background:rgba(78,161,255,0.18);border-radius:2px;";
    box.appendChild(mini);
    box.appendChild(view);
    document.body.appendChild(box);
    this.overlayBox = box;
    this.overlayView = view;
    this.overlayCanvas = mini;
    this.overlayCtx = mini.getContext("2d");
  }

  /** Always-on loop, INDEPENDENT of the video draw loop — nothing in the video path can stop it. */
  private startOverlayLoop(): void {
    const tick = () => {
      this.renderOverlay();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private renderOverlay(): void {
    const box = this.overlayBox;
    const view = this.overlayView;
    if (!box || !view) return;
    const v = this.getVisibleRegion();
    const reg = this.region;
    const dW = this.dispW();
    const dH = this.dispH();
    // VISIBILITY is gated on the host crop (authoritative; survives a client zoom collapse) OR the
    // live digital view being smaller than the whole desktop — so the minimap stays up the whole
    // time you're zoomed. But the INNER rectangle tracks the LIVE visible region (getVisibleRegion),
    // NOT the host's crop echo, so it follows your pan/zoom every frame instead of snapping to the
    // right spot a second later when the host re-crops.
    const show = !!reg || v.w < 0.985 || v.h < 0.985;
    if (!show) {
      if (box.style.display !== "none") box.style.display = "none";
      this.lastOverlayKey = "";
      this.overlayCanvasKey = "";
      return;
    }
    if (box.style.display === "none") {
      box.style.display = "block";
      // Just started viewing a sub-region: appear and start the idle countdown fresh.
      this.minimapActiveAt = performance.now();
      this.minimapShown = false; // force the fade-in write below
    }

    // Box size + live thumbnail. The box keeps the desktop's aspect; repaint the thumbnail when the
    // box resizes OR a fresh overview frame arrived (independent of the view rect moving).
    const mmW = Math.round(Math.min(132, Math.max(76, this.cssW * 0.32)));
    const mmH = Math.round(mmW * (dH / dW || 0.625));
    const canvasKey = `${mmW}x${mmH}`;
    if (canvasKey !== this.overlayCanvasKey || this.overviewDirty) {
      this.overlayCanvasKey = canvasKey;
      this.overviewDirty = false;
      box.style.width = `${mmW}px`;
      box.style.height = `${mmH}px`;
      this.paintMinimap(mmW, mmH);
    }

    // Blue "you are here" rectangle — tracks the LIVE visible region. A change to it means the user
    // is panning/zooming, which counts as activity and keeps the minimap awake.
    const inner = v;
    const now = performance.now();
    const key = `${inner.x.toFixed(3)},${inner.y.toFixed(3)},${inner.w.toFixed(3)},${inner.h.toFixed(3)}`;
    if (key !== this.lastOverlayKey) {
      this.lastOverlayKey = key;
      this.minimapActiveAt = now; // moved -> restart the idle timer (and fade back in below)
      view.style.left = `${(clamp(inner.x, 0, 1) * 100).toFixed(2)}%`;
      view.style.top = `${(clamp(inner.y, 0, 1) * 100).toFixed(2)}%`;
      view.style.width = `${(clamp(Math.max(0.04, inner.w), 0, 1) * 100).toFixed(2)}%`;
      view.style.height = `${(clamp(Math.max(0.04, inner.h), 0, 1) * 100).toFixed(2)}%`;
    }

    // Fade out once you've held still for a few seconds; snap back in the instant you move again.
    const shouldShow = now - this.minimapActiveAt < MINIMAP_IDLE_MS;
    if (shouldShow !== this.minimapShown) {
      this.minimapShown = shouldShow;
      box.style.transition = `opacity ${shouldShow ? 0.18 : 0.5}s ease`;
      box.style.opacity = shouldShow ? "1" : "0";
    }
  }

  /** Paint the latest overview into the minimap canvas (full desktop -> box; aspects already match). */
  private paintMinimap(boxW: number, boxH: number): void {
    const cv = this.overlayCanvas;
    const cx = this.overlayCtx;
    if (!cv || !cx) return;
    const pw = Math.max(1, Math.round(boxW * this.dpr));
    const ph = Math.max(1, Math.round(boxH * this.dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    cx.clearRect(0, 0, pw, ph);
    const img = this.overviewImg();
    if (!img) return; // no snapshot yet — the box's dark fill shows through
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "low";
    cx.drawImage(img, 0, 0, pw, ph);
  }

  /** The current overview snapshot, or null until one exists / after a screen change invalidates it. */
  private overviewImg(): HTMLCanvasElement | null {
    return this.overviewReady ? this.overview : null;
  }

  /**
   * Refresh the overview by downscaling the current FULL-desktop H.264 frame into an offscreen
   * canvas. Throttled to OVERVIEW_SNAP_MS. The caller guarantees `src` is the whole desktop (not a
   * crop), so the snapshot is always a true full-screen thumbnail.
   */
  private maybeSnapshot(src: CanvasImageSource, vw: number, vh: number): void {
    const now = performance.now();
    if (now - this.lastSnapAt < OVERVIEW_SNAP_MS) return;
    this.lastSnapAt = now;
    if (!this.overview) {
      this.overview = document.createElement("canvas");
      this.overviewCtx = this.overview.getContext("2d");
    }
    const cv = this.overview;
    const cx = this.overviewCtx;
    if (!cv || !cx) return;
    const w = OVERVIEW_SNAP_W;
    const h = Math.max(1, Math.round((w * vh) / vw));
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "medium";
    cx.drawImage(src, 0, 0, vw, vh, 0, 0, w, h);
    this.overviewReady = true;
    this.overviewDirty = true; // minimap repaints to show the fresh snapshot
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.requestDraw();
    this.emitView(); // canvas aspect changed -> visible region changed
  }

  setScreen(screen: ScreenInfo): void {
    const changed = screen.width !== this.screen.width || screen.height !== this.screen.height;
    this.screen = screen;
    if (changed) {
      // A different desktop (resolution / display switch): the old snapshot no longer represents it.
      this.overviewReady = false;
      this.lastSnapAt = 0;
      this.overviewDirty = true; // clear the minimap thumbnail until a fresh full-desktop frame lands
    }
    this.requestDraw();
  }
  getScreen(): ScreenInfo {
    return this.screen;
  }

  /** Desktop dimensions drive the transform; fall back to the frame's pixels until known. */
  private dispW(): number {
    return this.screen.width || this.mainEl?.videoWidth || 1;
  }
  private dispH(): number {
    return this.screen.height || this.mainEl?.videoHeight || 1;
  }

  /** The host echoes the REQUESTED region the moment it applies a viewport; null/full = whole desktop.
   * We update the target (minimap) now but HOLD the displayed frame at its previous region — the move
   * happens on the matching active echo (setFrameRegionActive), or this fallback timer for an old
   * agent that doesn't send one. */
  setFrameRegion(r: Region | null): void {
    const next = isFull(r) ? null : r;
    this.region = next; // immediate: the minimap reflects the host crop right away
    // A new request supersedes any pending adopt for the previous region.
    window.clearTimeout(this.regionActiveHold);
    window.clearTimeout(this.regionBridge);
    // Blind fallback ONLY for old agents that never send active echoes (see hasActiveEcho).
    if (!this.hasActiveEcho) {
      this.regionBridge = window.setTimeout(() => {
        this.shownRegion = next;
        if (!this.videoActive) this.requestDraw();
      }, REGION_BRIDGE_MS);
    }
    if (!this.videoActive) this.requestDraw();
  }

  /** The host reports the requested region is now LIVE (its first re-cropped frame is on the wire).
   * THIS is when we move the displayed frame onto the new rectangle — after a short hold so the
   * client's jitter buffer has actually presented that frame. Same-aspect pans (where the frame's
   * own aspect can't reveal the switch) depend on this; without it they relied on a blind timer that
   * raced the variable re-crop latency, snapping the frame to the wrong place early or late. */
  setFrameRegionActive(r: Region | null): void {
    this.hasActiveEcho = true; // this agent sends live signals — retire the blind fallback timer
    const next = isFull(r) ? null : r;
    // Ignore a stale active echo for a region we've already panned/zoomed past — the current
    // target's own active echo will follow.
    if (!sameRegion(next, this.region)) return;
    if (sameRegion(next, this.shownRegion)) return; // already placed there
    window.clearTimeout(this.regionActiveHold);
    const adopt = () => {
      if (!sameRegion(next, this.region)) return; // target moved while we waited
      this.shownRegion = next;
      window.clearTimeout(this.regionBridge);
      if (!this.videoActive) this.requestDraw();
    };
    this.regionActiveHold = window.setTimeout(() => {
      if (!sameRegion(next, this.region)) return; // target moved while we held
      // "Active" means the agent put the new crop's FIRST PACKET on the wire — not that this
      // browser decoded it. On a lossy remote link that first IDR can be lost (the next forced
      // keyframe repairs it seconds later), and flipping on a fixed timer paints the old-crop
      // frame at the new rectangle in the meantime — a pan keeps the aspect identical, so
      // nothing downstream can catch it. Flip on the next frame the browser actually PRESENTS:
      // until real new content exists, the old frame stays at its true (old) place over the live
      // overview, which is geometrically correct. Fixed-timer only where rVFC is unsupported.
      const el = this.mainEl as
        | (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
        | null;
      if (el && typeof el.requestVideoFrameCallback === "function") el.requestVideoFrameCallback(adopt);
      else adopt();
    }, REGION_ACTIVE_HOLD_MS);
  }

  /** Attach (or clear, with null) the desktop video track. */
  setVideoSource(el: HTMLVideoElement | null): void {
    this.mainEl = el;
    this.videoActive = !!el;
    if (el) this.startVideoLoop();
    else this.stopVideoLoop();
  }
  isVideoActive(): boolean {
    return this.videoActive;
  }

  /** Attach (or clear, with null) the live low-res full-desktop overview track. */
  setOverviewSource(el: HTMLVideoElement | null): void {
    this.overviewEl = el;
  }

  private startVideoLoop(): void {
    if (this.videoRaf) return;
    const tick = () => {
      if (!this.videoActive) {
        this.videoRaf = 0;
        return;
      }
      this.draw();
      this.videoRaf = requestAnimationFrame(tick);
    };
    this.videoRaf = requestAnimationFrame(tick);
  }
  private stopVideoLoop(): void {
    if (this.videoRaf) cancelAnimationFrame(this.videoRaf);
    this.videoRaf = 0;
    this.requestDraw();
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (mode === "fit") {
      this.zoom = 1;
      this.center = { nx: 0.5, ny: 0.5 };
    } else if (this.zoom === 1) {
      this.zoom = 2;
    }
    this.emitView();
    this.requestDraw();
  }
  getViewMode(): ViewMode {
    return this.viewMode;
  }
  toggleViewMode(): ViewMode {
    this.setViewMode(this.viewMode === "fit" ? "magnify" : "fit");
    return this.viewMode;
  }

  setZoom(z: number): void {
    this.zoom = clamp(z, 1, 8);
    this.viewMode = this.zoom === 1 ? "fit" : "magnify";
    if (this.zoom === 1) this.center = { nx: 0.5, ny: 0.5 };
    this.onZoomCb?.(this.zoom);
    this.emitView();
    this.requestDraw();
  }
  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }
  getZoom(): number {
    return this.zoom;
  }
  /** Canvas CSS px per host pixel under the current transform (fit scale × zoom). Input uses it
   * to convert finger travel into host-content pixels, so drag-scroll speed is zoom-aware. */
  getScale(): number {
    return this.computeLayout().S;
  }
  /** Notified on every zoom change (buttons + pinch). */
  setOnZoom(cb: (zoom: number) => void): void {
    this.onZoomCb = cb;
  }
  /** Notified whenever the VISIBLE desktop region changes (zoom + pan), for the host crop. */
  setOnView(cb: (region: Region) => void): void {
    this.onViewCb = cb;
  }
  /** Notified when a touch gesture begins (true) / ends (false). The end notification fires AFTER
   * the end-of-gesture view emission, so "gesture ended without changing the view" is detectable
   * — the controller uses this to hold host re-crops while the user is still interacting. */
  setOnGesture(cb: (active: boolean) => void): void {
    this.onGestureCb = cb;
  }
  /**
   * Bracket a pan/zoom gesture so the host re-crop is deferred until it FINISHES. The input layer
   * calls beginViewGesture() when the first finger lands and endViewGesture() when the last finger
   * lifts. Between them, emitView() only flags the view dirty; on end we emit the final region once.
   * Discrete changes (zoom buttons, double-tap, zoom-to-fit) happen outside a gesture and emit
   * immediately, so they still re-crop right away.
   */
  beginViewGesture(): void {
    this.gestureActive = true;
    this.onGestureCb?.(true);
  }
  endViewGesture(): void {
    if (!this.gestureActive) return;
    this.gestureActive = false;
    if (this.viewDirty) {
      this.viewDirty = false;
      this.onViewCb?.(this.getVisibleRegion());
    }
    this.onGestureCb?.(false);
  }
  private emitView(): void {
    if (this.gestureActive) {
      this.viewDirty = true;
      return;
    }
    this.onViewCb?.(this.getVisibleRegion());
  }

  /**
   * Zoom by `factor` keeping the desktop point currently under canvas (cx,cy) fixed under
   * the fingers — i.e. zoom around the pinch focal point rather than the screen center.
   */
  zoomAround(factor: number, cx: number, cy: number): void {
    const focus = this.canvasToNorm(cx, cy);
    const next = clamp(this.zoom * factor, 1, 8);
    if (next === 1) {
      this.setZoom(1);
      return;
    }
    this.zoom = next;
    this.viewMode = "magnify";
    const dw = this.dispW();
    const dh = this.dispH();
    const fit = Math.min(this.cssW / dw, this.cssH / dh);
    const S = fit * this.zoom;
    // center is the desktop point shown at the canvas center; solve so `focus` stays at (cx,cy).
    this.center.nx = clamp(focus.nx - (cx - this.cssW / 2) / (dw * S || 1), PAN_MIN, PAN_MAX);
    this.center.ny = clamp(focus.ny - (cy - this.cssH / 2) / (dh * S || 1), PAN_MIN, PAN_MAX);
    this.onZoomCb?.(this.zoom);
    this.emitView();
    this.requestDraw();
  }

  panByNorm(dnx: number, dny: number): void {
    this.center.nx = clamp(this.center.nx + dnx, PAN_MIN, PAN_MAX);
    this.center.ny = clamp(this.center.ny + dny, PAN_MIN, PAN_MAX);
    this.emitView();
    this.requestDraw();
  }

  /**
   * Pan so the image follows the finger 1:1: a drag of `dx,dy` CSS pixels moves the picture
   * by the same number of pixels, at ANY zoom.
   */
  panByCanvasPixels(dx: number, dy: number): void {
    const { S } = this.computeLayout();
    const dw = this.dispW();
    const dh = this.dispH();
    if (!dw || !dh || !S) return;
    this.center.nx = clamp(this.center.nx - dx / (dw * S), PAN_MIN, PAN_MAX);
    this.center.ny = clamp(this.center.ny - dy / (dh * S), PAN_MIN, PAN_MAX);
    this.emitView();
    this.requestDraw();
  }

  setCursor(nx: number | null, ny = 0): void {
    this.cursor = nx === null ? null : { nx, ny };
    if (!this.videoActive) this.requestDraw();
  }

  private computeLayout(): { S: number; tx: number; ty: number } {
    const { cssW, cssH } = this;
    const dw = this.dispW();
    const dh = this.dispH();
    if (!dw || !dh) {
      this.layout = { S: 1, tx: 0, ty: 0 };
      return this.layout;
    }
    const fit = Math.min(cssW / dw, cssH / dh);
    const S = fit * this.zoom;
    let tx: number;
    let ty: number;
    if (this.viewMode === "fit" || this.zoom === 1) {
      tx = (cssW - dw * S) / 2;
      ty = (cssH - dh * S) / 2;
    } else {
      tx = cssW / 2 - this.center.nx * dw * S;
      ty = cssH / 2 - this.center.ny * dh * S;
    }
    this.layout = { S, tx, ty };
    return this.layout;
  }

  canvasToNorm(cx: number, cy: number): { nx: number; ny: number } {
    const { S, tx, ty } = this.computeLayout();
    return {
      nx: clamp((cx - tx) / (this.dispW() * S || 1), 0, 1),
      ny: clamp((cy - ty) / (this.dispH() * S || 1), 0, 1),
    };
  }
  normToCanvas(nx: number, ny: number): { cx: number; cy: number } {
    const { S, tx, ty } = this.computeLayout();
    return { cx: tx + nx * this.dispW() * S, cy: ty + ny * this.dispH() * S };
  }

  /** The desktop region currently visible on the canvas (intersection with the desktop). */
  getVisibleRegion(): Region {
    const { S, tx, ty } = this.computeLayout();
    const dw = this.dispW() * S;
    const dh = this.dispH() * S;
    if (!dw || !dh) return { x: 0, y: 0, w: 1, h: 1 };
    const x0 = clamp(-tx / dw, 0, 1);
    const y0 = clamp(-ty / dh, 0, 1);
    const x1 = clamp((this.cssW - tx) / dw, 0, 1);
    const y1 = clamp((this.cssH - ty) / dh, 0, 1);
    return { x: x0, y: y0, w: Math.max(0.05, x1 - x0), h: Math.max(0.05, y1 - y0) };
  }

  requestDraw(): void {
    if (this.videoActive) return; // the video loop already redraws every frame
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const main = this.mainEl && this.mainEl.videoWidth > 0 ? this.mainEl : null;
    if (!main) return;

    const { S, tx, ty } = this.computeLayout();
    const dispW = this.dispW();
    const dispH = this.dispH();
    const DW = dispW * S;
    const DH = dispH * S;
    const vw = main.videoWidth;
    const vh = main.videoHeight;

    const frameAspect = vw / vh;
    const aspectOf = (reg: Region | null): number => (reg ? (reg.w * dispW) / (reg.h * dispH) : dispW / dispH);

    // The timed bridge in setFrameRegion holds the picture in place across a re-crop. But for a
    // transition that CHANGES the crop's shape (zoom in/out, or full<->crop) we can adopt the new
    // region the instant its frames actually arrive — detectable when the frame's aspect now matches
    // the latest echo (this.region) but not the region we're still drawing at. A pure pan keeps the
    // same aspect, so this can't misfire there and the timer stays in charge.
    if (this.region !== this.shownRegion) {
      const matchesTarget = Math.abs(frameAspect / aspectOf(this.region) - 1) < 0.06;
      const matchesShown = Math.abs(frameAspect / aspectOf(this.shownRegion) - 1) < 0.06;
      if (matchesTarget && !matchesShown) {
        this.shownRegion = this.region;
        window.clearTimeout(this.regionBridge);
      }
    }

    // Place the frame at the desktop rectangle `shownRegion` represents — it lags the host's latest
    // crop echo so a pan/zoom HOLDS the picture in place until the re-cropped frames land instead of
    // snapping to the new rectangle (the "jump back" on release). The aspect check keeps a still-
    // mismatched transient frame out of a crop rect: fall back to a full-desktop digital placement
    // until the frame and shownRegion agree.
    const r = this.shownRegion;
    const useCrop = !!r && Math.abs(frameAspect / aspectOf(r) - 1) < 0.08;

    const rx = useCrop ? tx + r!.x * DW : tx;
    const ry = useCrop ? ty + r!.y * DH : ty;
    const rw = useCrop ? r!.w * DW : DW;
    const rh = useCrop ? r!.h * DH : DH;

    // BASE LAYER: while a crop is involved (zoomed in, or mid-transition to/from a crop) the H.264
    // frame only covers PART of the desktop. Paint the low-res full-desktop overview underneath —
    // placed at the whole desktop rectangle — so a pan/zoom reveals real (if soft) content off the
    // crop instead of black, until the host's sharp re-crop lands on top. At fit (no crop) the H.264
    // frame already IS the whole desktop, so we skip this and show only the sharp picture.
    const overview = this.overviewImg();
    if (overview && (this.region || this.shownRegion)) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(overview, tx, ty, DW, DH);
    }

    // Draw the frame into that rectangle PRESERVING its aspect ratio (contain) — never stretch.
    const scale = Math.min(rw / vw, rh / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(main, 0, 0, vw, vh, rx + (rw - w) / 2, ry + (rh - h) / 2, w, h);

    if (this.cursor) {
      const { cx, cy } = this.normToCanvas(this.cursor.nx, this.cursor.ny);
      this.drawCursor(cx, cy);
    }
    // Minimap is a DOM overlay on its own loop (renderOverlay) — not drawn on the canvas.

    // Keep the overview fresh. While CROPPED the host streams a live low-res full-desktop overview
    // track — snapshot THAT, so the minimap + base layer track the real desktop (alt-tab, scrolling)
    // without ever zooming out. UNCROPPED there's no overview track, but the main frame IS the whole
    // desktop (once its aspect proves it, not a transient crop frame), so snapshot that instead.
    const ov = this.overviewEl;
    if (this.region && ov && ov.videoWidth > 0) {
      this.maybeSnapshot(ov, ov.videoWidth, ov.videoHeight);
    } else if (!this.region && !this.shownRegion && dispH > 0) {
      const fullAspect = dispW / dispH;
      if (fullAspect > 0 && Math.abs(frameAspect / fullAspect - 1) < 0.06) {
        this.maybeSnapshot(main, vw, vh);
      }
    }
  }

  private drawCursor(cx: number, cy: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(78,161,255,0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(78,161,255,0.95)";
    ctx.fill();
    ctx.restore();
  }

}
