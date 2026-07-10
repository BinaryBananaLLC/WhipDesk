import type { ClientMessage, MouseButton } from "@whipdesk/protocol";
import type { ControllerTransport } from "./core";
import type { ScreenView } from "./screen";

/**
 * Interaction model selected by the UI tabs:
 *  - "viewer": direct interaction, like the machine's own touchscreen. One finger drags the
 *    POINTER (shows the ring); a tap CLICKS where you touch, and fast consecutive taps are
 *    double/triple clicks. With the Pan tool or drag-to-scroll on, one finger pans/scrolls
 *    instead and taps are inert. Two fingers: pinch to zoom, drag to pan/scroll.
 *  - "mouse": trackpad-style. Tap = click where you touch; drag = move the pointer; the
 *    Right/Double/Drag-hold buttons and long-press = right click cover the rest.
 *  - "touch": touchscreen simulation. Tap = tap (click) where you touch; swipe = scroll.
 *    No right click — it mimics a finger on a touch screen.
 */
export type Interaction = "viewer" | "mouse" | "touch";

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Pixels of finger drag per wheel tick (smaller = faster scrolling). */
const DRAG_SCROLL_DIVISOR = 2.5;

interface Pointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
  moved: boolean;
  consumed: boolean;
}

const TAP_MS = 250;
const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 8; // css px
/** Min ms between host cursor updates while a desktop mouse just glides (hover-follow). */
const HOVER_SEND_MS = 50;

export interface InputCallbacks {
  /** Cursor moved (normalized). Lets the UI mirror position if needed. */
  onCursor?(nx: number, ny: number): void;
  /** Live zoom changed via pinch (so the UI can refresh its zoom label). */
  onZoom?(zoom: number): void;
}

/**
 * Translates touch/pointer gestures into protocol input messages. The active `Interaction`
 * decides how one finger behaves; two-finger gestures (pan/scroll/pinch) are shared.
 * A virtual cursor is always maintained so the on-screen buttons (Click/Right/Double) act
 * at a known location regardless of mode.
 */
export class InputController {
  private interaction: Interaction = "viewer";
  private dragLock = false; // hold the left button during drags (mouse mode)
  private dragScroll = false; // one-finger drag scrolls instead of moving the pointer
  private pan = false; // one-finger drag pans the zoomed view (viewer only), like a minimap
  private holdingLeft = false;
  private cursor = { nx: 0.5, ny: 0.5 };

  private readonly pointers = new Map<number, Pointer>();
  private longPressTimer = 0;
  private twoFinger: { dist: number; mx: number; my: number; start: number; moved: boolean } | null = null;
  private suppressTap = false;
  private hoverSentAt = 0;
  private hoverTrailing = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: ScreenView,
    private readonly conn: ControllerTransport,
    private cb: InputCallbacks = {},
  ) {
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // Desktop controllers: the mouse wheel zooms the view toward the cursor, mirroring the mobile
    // pinch. passive:false so we can preventDefault the page/rubber-band scroll the wheel would do.
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.view.setCursor(this.cursor.nx, this.cursor.ny);
  }

  // ---- public control surface (wired to the ribbon buttons) ----
  setInteraction(kind: Interaction): void {
    this.interaction = kind;
    if (kind === "viewer") this.dragLock = false;
  }
  getInteraction(): Interaction {
    return this.interaction;
  }
  setCallbacks(cb: InputCallbacks): void {
    this.cb = cb;
  }
  setDragLock(on: boolean): void {
    this.dragLock = on;
  }
  getDragLock(): boolean {
    return this.dragLock;
  }
  setDragScroll(on: boolean): void {
    this.dragScroll = on;
    if (on) this.pan = false; // the two one-finger drag behaviors are mutually exclusive
  }
  getDragScroll(): boolean {
    return this.dragScroll;
  }
  /** One-finger drag pans the zoomed picture (viewer only), like dragging a strategy minimap. */
  setPan(on: boolean): void {
    this.pan = on;
    if (on) this.dragScroll = false;
  }
  getPan(): boolean {
    return this.pan;
  }
  private isPanning(): boolean {
    return this.pan && this.interaction === "viewer";
  }
  /** Explicit click at the current virtual cursor (Click / Right buttons). */
  click(button: MouseButton, double = false): void {
    this.send({ type: "pointer", action: "click", button, double, x: this.cursor.nx, y: this.cursor.ny });
    navigator.vibrate?.(15);
  }
  /** Rapid N-click at the cursor (2 = double, 3 = triple/select-all in browsers). */
  multiClick(count: number): void {
    for (let i = 0; i < count; i++) {
      this.send({ type: "pointer", action: "click", button: "left", x: this.cursor.nx, y: this.cursor.ny });
    }
    navigator.vibrate?.(15);
  }
  /** Touch-style long press: press and hold at the cursor, then release. */
  longPress(holdMs = 650): void {
    this.send({ type: "pointer", action: "down", button: "left", x: this.cursor.nx, y: this.cursor.ny });
    navigator.vibrate?.(25);
    window.setTimeout(() => this.send({ type: "pointer", action: "up", button: "left" }), holdMs);
  }
  /** Touch-style swipe/flick from the cursor by a normalized delta (press → move → release). */
  swipe(dnx: number, dny: number): void {
    const sx = clamp01(this.cursor.nx);
    const sy = clamp01(this.cursor.ny);
    const ex = clamp01(this.cursor.nx + dnx);
    const ey = clamp01(this.cursor.ny + dny);
    this.send({ type: "pointer", action: "down", button: "left", x: sx, y: sy });
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      window.setTimeout(() => {
        this.send({ type: "pointer", action: "move", x: sx + (ex - sx) * t, y: sy + (ey - sy) * t });
        if (i === steps) {
          this.moveCursor(ex, ey);
          this.send({ type: "pointer", action: "up", button: "left" });
        }
      }, i * 16);
    }
    navigator.vibrate?.(15);
  }
  /** Discrete scroll step from the Scroll ▲▼ buttons. */
  scrollStep(dy: number): void {
    this.send({ type: "scroll", dx: 0, dy });
  }

  // ---- internals ----
  private send(message: ClientMessage): void {
    this.conn.send(message);
  }

  private positionOf(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private moveCursor(nx: number, ny: number): void {
    this.cursor.nx = clamp01(nx);
    this.cursor.ny = clamp01(ny);
    this.view.setCursor(this.cursor.nx, this.cursor.ny);
    this.cb.onCursor?.(this.cursor.nx, this.cursor.ny);
  }

  private onDown(e: PointerEvent): void {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.positionOf(e);
    this.pointers.set(e.pointerId, {
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      startT: performance.now(),
      moved: false,
      consumed: false,
    });

    if (this.pointers.size === 2) {
      window.clearTimeout(this.longPressTimer);
      this.beginTwoFinger();
      return;
    }
    if (this.pointers.size === 1) {
      // First finger down = a pan/zoom gesture may be starting. Defer host re-crops until it ends.
      this.view.beginViewGesture();
      window.clearTimeout(this.longPressTimer);
      // Long-press = right click only in Mouse mode (Touch has no right click).
      if (this.interaction === "mouse" && !this.dragScroll) {
        this.longPressTimer = window.setTimeout(() => this.onLongPress(), LONG_PRESS_MS);
      }
      // Absolute modes snap the pointer to the touch point (unless we're drag-scrolling/panning).
      if (!this.dragScroll && !this.isPanning() && (this.interaction === "mouse" || this.interaction === "viewer")) {
        const n = this.view.canvasToNorm(p.x, p.y);
        this.moveCursor(n.nx, n.ny);
      }
    }
  }

  /**
   * Mouse-wheel zoom (desktop). Zooms around the pointer so the pixel under the cursor stays put —
   * exactly like a two-finger pinch on mobile. The host re-crop is coalesced by main.ts's viewport
   * debounce, so a wheel flick zooms instantly on-screen and asks the host to sharpen once it
   * settles. deltaMode is normalized so a "lines" wheel (Firefox) matches a "pixels" trackpad.
   */
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.positionOf(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight || 800 : 1;
    // Clamp a single notch so a chunky mouse wheel can't jump multiple zoom stops at once.
    const dy = Math.max(-40, Math.min(40, e.deltaY * unit));
    const factor = Math.exp(-dy * 0.0016); // wheel up (dy<0) => factor>1 => zoom in
    this.view.zoomAround(factor, p.x, p.y);
    this.cb.onZoom?.(this.view.getZoom());
  }

  private onLongPress(): void {
    const only = [...this.pointers.values()][0];
    if (!only || only.moved || only.consumed) return;
    only.consumed = true;
    this.send({ type: "pointer", action: "click", button: "right", x: this.cursor.nx, y: this.cursor.ny });
    navigator.vibrate?.(20);
  }

  private beginTwoFinger(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const a = pts[0]!;
    const b = pts[1]!;
    this.twoFinger = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      start: performance.now(),
      moved: false,
    };
  }

  /**
   * Hover-follow (desktop controllers): a mouse gliding over the canvas with no button down still
   * moves the host cursor, so you can SEE where you are on the remote screen before clicking —
   * exactly like sitting at the machine. Throttled to one host update per HOVER_SEND_MS (it may
   * lag a touch, never flood the channel), with a trailing send so the cursor always comes to rest
   * where the mouse did. Touch can't hover, and Touch mode simulates a hoverless touchscreen.
   */
  private onHoverMove(e: PointerEvent): void {
    if (e.pointerType !== "mouse" || e.buttons !== 0 || this.interaction === "touch") return;
    const p = this.positionOf(e);
    const n = this.view.canvasToNorm(p.x, p.y);
    this.moveCursor(n.nx, n.ny); // the local ring tracks every frame; only host sends are throttled
    window.clearTimeout(this.hoverTrailing);
    const now = performance.now();
    if (now - this.hoverSentAt < HOVER_SEND_MS) {
      this.hoverTrailing = window.setTimeout(() => {
        this.hoverSentAt = performance.now();
        this.send({ type: "pointer", action: "move", x: this.cursor.nx, y: this.cursor.ny });
      }, HOVER_SEND_MS);
      return;
    }
    this.hoverSentAt = now;
    this.send({ type: "pointer", action: "move", x: this.cursor.nx, y: this.cursor.ny });
  }

  private onMove(e: PointerEvent): void {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) {
      this.onHoverMove(e);
      return;
    }
    const p = this.positionOf(e);
    const prevX = ptr.x;
    const prevY = ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;
    if (Math.hypot(p.x - ptr.startX, p.y - ptr.startY) > MOVE_THRESHOLD) ptr.moved = true;

    if (this.pointers.size >= 2 && this.twoFinger) {
      this.onTwoFingerMove();
      return;
    }
    if (this.pointers.size !== 1 || ptr.consumed || !ptr.moved) return;

    window.clearTimeout(this.longPressTimer);
    const dx = p.x - prevX;
    const dy = p.y - prevY;

    // One-finger PAN (viewer): drag the zoomed picture under the finger, no host effect.
    if (this.isPanning()) {
      this.view.panByCanvasPixels(dx, dy);
      return;
    }

    // One-finger scroll: Touch mode always, or any mode with drag-to-scroll enabled.
    // Natural direction: swipe up -> content scrolls up (wheel down).
    if (this.interaction === "touch" || this.dragScroll) {
      this.send({
        type: "scroll",
        dx: Math.round(-dx / DRAG_SCROLL_DIVISOR),
        dy: Math.round(-dy / DRAG_SCROLL_DIVISOR),
      });
      return;
    }

    // viewer + mouse: absolute — the pointer tracks the finger.
    const n = this.view.canvasToNorm(p.x, p.y);
    this.moveCursor(n.nx, n.ny);

    // Drag-hold (mouse mode): keep the left button down through the drag.
    if (this.interaction === "mouse" && this.dragLock && !this.holdingLeft) {
      this.holdingLeft = true;
      this.send({ type: "pointer", action: "down", button: "left", x: this.cursor.nx, y: this.cursor.ny });
    }
    this.send({ type: "pointer", action: "move", x: this.cursor.nx, y: this.cursor.ny });
  }

  private onTwoFingerMove(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2 || !this.twoFinger) return;
    const a = pts[0]!;
    const b = pts[1]!;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dDist = dist - this.twoFinger.dist;
    const dmx = mx - this.twoFinger.mx;
    const dmy = my - this.twoFinger.my;

    if (Math.abs(dDist) > 6) {
      this.twoFinger.moved = true;
      // Zoom around the midpoint between the fingers (not the screen center).
      this.view.zoomAround(1 + dDist / 200, mx, my);
      this.twoFinger.dist = dist;
      return;
    }
    if (Math.abs(dmy) > 2 || Math.abs(dmx) > 2) {
      this.twoFinger.moved = true;
      // When zoomed in, two-finger drag pans the picture 1:1 with the fingers (fast + smooth
      // at any zoom); when not zoomed, it scrolls the host.
      if (this.view.getZoom() > 1) {
        this.view.panByCanvasPixels(dmx, dmy);
      } else {
        this.send({
          type: "scroll",
          dx: Math.round(-dmx / DRAG_SCROLL_DIVISOR),
          dy: Math.round(-dmy / DRAG_SCROLL_DIVISOR),
        });
      }
      this.twoFinger.mx = mx;
      this.twoFinger.my = my;
    }
  }

  private onUp(e: PointerEvent): void {
    const sizeBefore = this.pointers.size;
    const ptr = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPressTimer);

    // The pan/zoom gesture is over once the LAST finger lifts — now ask the host to re-crop, once.
    if (this.pointers.size === 0) this.view.endViewGesture();

    // Releasing the first of two fingers: a two-finger tap = right click (Mouse mode only).
    if (sizeBefore === 2) {
      const tf = this.twoFinger;
      if (tf && !tf.moved && this.interaction === "mouse" && performance.now() - tf.start < TAP_MS) {
        this.send({ type: "pointer", action: "click", button: "right", x: this.cursor.nx, y: this.cursor.ny });
        navigator.vibrate?.(20);
      }
      this.twoFinger = null;
      this.suppressTap = true; // the remaining finger's lift must not click
      for (const remaining of this.pointers.values()) remaining.consumed = true;
      return;
    }

    if (this.holdingLeft && this.pointers.size === 0) {
      this.holdingLeft = false;
      this.send({ type: "pointer", action: "up", button: "left" });
    }
    if (this.pointers.size < 2) this.twoFinger = null;

    if (!ptr || ptr.consumed) {
      // The LAST finger of a two-finger gesture exits here (it was marked consumed when the first
      // lifted) — the gesture is fully over, so clear the tap suppression NOW. Leaving it set made
      // the suppressTap block below eat the NEXT genuine tap: after every pinch-zoom / two-finger
      // pan the first click on the screen silently did nothing ("I have to tap twice after moving
      // the screen"). suppressTap must only ever guard lifts belonging to the SAME gesture.
      if (this.pointers.size === 0) this.suppressTap = false;
      return;
    }
    if (this.suppressTap) {
      if (this.pointers.size === 0) this.suppressTap = false;
      return;
    }

    const duration = performance.now() - ptr.startT;
    const wasTap = !ptr.moved && duration < TAP_MS && this.pointers.size === 0;
    if (!wasTap || this.dragScroll) return;
    // The Pan tool owns one-finger input: grabbing the view must never click through.
    if (this.isPanning()) return;

    // Tap = click at the touched point, in EVERY mode — Browse included, which also covers the
    // Type and Monitor tabs: the screen behaves like the machine's own touchscreen. Consecutive
    // fast taps are consecutive clicks, so a double-tap IS a double click and a triple-tap a
    // triple (the clicks ride one ordered channel and arrive as tightly as they were tapped).
    const n = this.view.canvasToNorm(ptr.startX, ptr.startY);
    this.moveCursor(n.nx, n.ny);
    this.send({ type: "pointer", action: "click", button: "left", x: n.nx, y: n.ny });
    navigator.vibrate?.(12);
  }
}
