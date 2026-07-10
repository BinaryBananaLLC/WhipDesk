/**
 * Escape-key dismissal for dialogs (desktop browsers have a keyboard; the controller is often used
 * from one). Every dialog overlay in the app already closes itself on a backdrop tap — a
 * `pointerdown` whose target is the `.wd-dialog-overlay` element — so Esc simply triggers that same
 * designed dismiss path on the TOPMOST open dialog. Dialogs opened later sit later in the DOM, so
 * document order gives the stacking order and Esc pops them LIFO. Overlays that deliberately don't
 * dismiss on a backdrop tap are equally unaffected by Esc.
 */
export function installEscToClose(): void {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const open = [...document.querySelectorAll<HTMLElement>(".wd-dialog-overlay")].filter(
        (o) => !o.classList.contains("hidden"),
      );
      const top = open[open.length - 1];
      if (!top) return;
      e.preventDefault();
      e.stopPropagation();
      top.dispatchEvent(new PointerEvent("pointerdown"));
    },
    true, // capture, so a dialog's Esc never doubles as input elsewhere (e.g. keys sent to the host)
  );
}
