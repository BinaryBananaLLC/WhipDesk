import type { ScreenView } from "./screen";
import type { Whipository } from "./whipository";
import whipositoryMark from "./assets/whipository.png";

export interface PlacementResult {
  /** Normalized [0,1] desktop point the user targeted. */
  nx: number;
  ny: number;
  /** Prompt text (only when `withText`). */
  text?: string;
}

export interface PlacementOptions {
  withText: boolean;
  hint: string;
  confirmLabel: string;
  /** When set (and `withText`), a tiny Whips button lets the user insert a saved prompt. */
  whipository?: Whipository;
}

/**
 * Full-screen "place a target" mode for scheduling a timer action. The user can pan + pinch-zoom
 * the LIVE screen (like Browse mode) and drop a crosshair on the exact element — then Confirm. For
 * a prompt action they type the text right here, seeing where it will land. All gestures are
 * handled locally, so nothing reaches the host (no stray clicks on the real machine).
 *
 * The crosshair is anchored to a DESKTOP point (normalized), so it stays glued to the element
 * while the user pans/zooms to get a clear look.
 */
export function placeTarget(
  view: ScreenView,
  root: HTMLElement,
  opts: PlacementOptions,
  onDone: (result: PlacementResult | null) => void,
): void {
  const layer = document.createElement("div");
  layer.className = "wd-place-layer";

  const marker = document.createElement("div");
  marker.className = "wd-place-marker";

  const bar = document.createElement("div");
  bar.className = "wd-place-bar";
  const hint = document.createElement("p");
  hint.className = "wd-place-hint";
  hint.textContent = opts.hint;
  bar.appendChild(hint);

  let textInput: HTMLTextAreaElement | null = null;
  if (opts.withText) {
    textInput = document.createElement("textarea");
    textInput.className = "wd-input wd-input-area wd-place-text";
    textInput.placeholder = "Type the prompt to send…";
    if (opts.whipository) {
      // Prompt box + a tiny Whipository button beside it: inserting a saved whip fills THIS box
      // (the user still confirms the target), never the host directly.
      const row = document.createElement("div");
      row.className = "wd-place-text-row";
      const whips = document.createElement("button");
      whips.type = "button";
      whips.className = "wd-btn wd-icon-only wd-place-whips wd-whips-btn";
      whips.title = "Whipository — insert a saved prompt";
      whips.setAttribute("aria-label", "Insert a saved prompt");
      const whipsImg = document.createElement("img");
      whipsImg.src = whipositoryMark;
      whipsImg.alt = "";
      whipsImg.decoding = "async";
      whips.appendChild(whipsImg);
      whips.onclick = () =>
        opts.whipository!.open((text) => {
          textInput!.value = textInput!.value ? `${textInput!.value}${text}` : text;
          textInput!.focus();
        });
      row.append(textInput, whips);
      bar.appendChild(row);
    } else {
      bar.appendChild(textInput);
    }
  }

  const buttons = document.createElement("div");
  buttons.className = "wd-place-buttons";
  const cancel = document.createElement("button");
  cancel.className = "wd-btn";
  cancel.textContent = "Cancel";
  const confirm = document.createElement("button");
  confirm.className = "wd-btn wd-go";
  confirm.textContent = opts.confirmLabel;
  buttons.append(cancel, confirm);
  bar.appendChild(buttons);

  root.append(layer, marker, bar);
  root.classList.add("wd-placing"); // hide the bottom ribbon + status UI behind the placement bar

  // Crosshair anchored to a desktop point; re-positioned every frame so it tracks pan/zoom.
  let markerNorm = { nx: 0.5, ny: 0.5 };
  let raf = 0;
  const positionMarker = () => {
    const { cx, cy } = view.normToCanvas(markerNorm.nx, markerNorm.ny);
    marker.style.left = `${cx}px`;
    marker.style.top = `${cy}px`;
    raf = requestAnimationFrame(positionMarker);
  };
  raf = requestAnimationFrame(positionMarker);

  const pointers = new Map<number, { x: number; y: number }>();
  let mode: "idle" | "marker" | "pan" = "idle";
  let pinch: { dist: number; mx: number; my: number } | null = null;
  let start = { x: 0, y: 0 };
  let moved = false;

  const localPos = (e: PointerEvent) => {
    const rect = layer.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const nearMarker = (p: { x: number; y: number }) => {
    const { cx, cy } = view.normToCanvas(markerNorm.nx, markerNorm.ny);
    return Math.hypot(p.x - cx, p.y - cy) < 38;
  };

  layer.addEventListener("pointerdown", (e) => {
    layer.setPointerCapture?.(e.pointerId);
    const p = localPos(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      mode = "idle";
    } else if (pointers.size === 1) {
      start = p;
      moved = false;
      mode = nearMarker(p) ? "marker" : "pan";
      if (mode === "marker") markerNorm = view.canvasToNorm(p.x, p.y);
    }
  });

  layer.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = localPos(e);
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && pinch) {
      const pts = [...pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (Math.abs(dist - pinch.dist) > 4) {
        view.zoomAround(1 + (dist - pinch.dist) / 200, mx, my);
        pinch.dist = dist;
      }
      view.panByCanvasPixels(mx - pinch.mx, my - pinch.my);
      pinch.mx = mx;
      pinch.my = my;
      return;
    }
    if (Math.hypot(p.x - start.x, p.y - start.y) > 6) moved = true;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (mode === "marker") markerNorm = view.canvasToNorm(p.x, p.y);
    else if (mode === "pan") view.panByCanvasPixels(dx, dy);
  });

  const onUp = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    // A tap (no real drag) anywhere drops the crosshair there.
    if (p && mode === "pan" && !moved) markerNorm = view.canvasToNorm(p.x, p.y);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) mode = "idle";
  };
  layer.addEventListener("pointerup", onUp);
  layer.addEventListener("pointercancel", onUp);

  const finish = (result: PlacementResult | null) => {
    cancelAnimationFrame(raf);
    root.classList.remove("wd-placing");
    layer.remove();
    marker.remove();
    bar.remove();
    onDone(result);
  };
  cancel.onclick = () => finish(null);
  confirm.onclick = () => {
    const text = textInput?.value.trim() ?? "";
    if (opts.withText && !text) {
      textInput?.focus();
      return;
    }
    finish({ nx: markerNorm.nx, ny: markerNorm.ny, text: opts.withText ? text : undefined });
  };
}
