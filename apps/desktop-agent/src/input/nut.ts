import type { MouseButton } from "@whipdesk/protocol";
import { log } from "../logger";
import { clamp01, type ActiveDisplay, type InputBackend, type ScreenSize } from "./types";

/**
 * Primary backend: @nut-tree-fork/nut-js (community fork with free prebuilt binaries).
 * Returns null if the native module can't load, so the selector can fall back.
 */
export async function createNutBackend(): Promise<InputBackend | null> {
  // Static specifier so esbuild INLINES nut.js (+ its pure-JS jimp tree, including the
  // @nut-tree-fork/libnut meta wrapper) into agent.cjs; only the native per-platform addons
  // (@nut-tree-fork/libnut-<os>) stay external. This keeps jimp→…→phin (a no-longer-supported
  // package) out of the user's `npm i -g whipdesk` dependency tree. The inlined module still
  // `require`s the native addon at first use, so a missing/broken native binary rejects here
  // and we fall back — same graceful degradation as before.
  let nut: any;
  try {
    nut = await import("@nut-tree-fork/nut-js");
  } catch (error) {
    // Never swallow the reason: a missing/broken native module otherwise masquerades as a
    // permissions problem on the controller ("view-only" with no host-side trace).
    log.warn("nut.js failed to load — mouse control disabled:", (error as Error).message);
    return null;
  }
  if (!nut) return null;

  const { mouse, keyboard, Button, Key, Point, screen } = nut;

  // Instant movement / no artificial key delays.
  try {
    mouse.config.mouseSpeed = 999999;
  } catch {
    /* older API */
  }
  try {
    keyboard.config.autoDelayMs = 0;
  } catch {
    /* older API */
  }

  let cachedSize: ScreenSize | null = null;
  const getScreenSize = async (): Promise<ScreenSize> => {
    if (cachedSize) return cachedSize;
    cachedSize = { width: await screen.width(), height: await screen.height() };
    return cachedSize;
  };

  // Active display geometry (global points). null => primary at origin (0,0).
  let active: ActiveDisplay | null = null;

  const toPoint = async (nx: number, ny: number) => {
    if (active && active.width > 0 && active.height > 0) {
      return new Point(
        Math.round(active.originX + clamp01(nx) * (active.width - 1)),
        Math.round(active.originY + clamp01(ny) * (active.height - 1)),
      );
    }
    const { width, height } = await getScreenSize();
    return new Point(
      Math.round(clamp01(nx) * Math.max(0, width - 1)),
      Math.round(clamp01(ny) * Math.max(0, height - 1)),
    );
  };

  const toButton = (b: MouseButton) =>
    b === "right" ? Button.RIGHT : b === "middle" ? Button.MIDDLE : Button.LEFT;

  const keyMap = buildKeyMap(Key);
  const modMap: Record<string, unknown> = {
    control: Key.LeftControl,
    ctrl: Key.LeftControl,
    meta: Key.LeftSuper,
    cmd: Key.LeftSuper,
    command: Key.LeftSuper,
    win: Key.LeftSuper,
    super: Key.LeftSuper,
    alt: Key.LeftAlt,
    option: Key.LeftAlt,
    shift: Key.LeftShift,
  };

  const resolveKey = (name: string): unknown => {
    const lower = name.toLowerCase();
    if (lower in keyMap) return keyMap[lower];
    if (name.length === 1) {
      const ch = name.toUpperCase();
      if (ch >= "A" && ch <= "Z") return Key[ch];
      if (ch >= "0" && ch <= "9") return Key[`Num${ch}`];
    }
    return undefined;
  };

  return {
    name: "nut.js",
    canMouse: true,
    canKeyboard: true,
    getScreenSize,
    setActiveDisplay(display) {
      active = display;
    },

    async moveTo(nx, ny) {
      await mouse.setPosition(await toPoint(nx, ny));
    },
    async buttonDown(button, nx, ny) {
      if (nx !== undefined && ny !== undefined) await mouse.setPosition(await toPoint(nx, ny));
      await mouse.pressButton(toButton(button));
    },
    async buttonUp(button) {
      await mouse.releaseButton(toButton(button));
    },
    async click(button, double, nx, ny, modifiers = []) {
      if (nx !== undefined && ny !== undefined) await mouse.setPosition(await toPoint(nx, ny));
      const mods = modifiers
        .map((m) => modMap[m.toLowerCase()])
        .filter((m): m is unknown => m !== undefined);
      for (const m of mods) await keyboard.pressKey(m);
      try {
        if (double) await mouse.doubleClick(toButton(button));
        else await mouse.click(toButton(button));
      } finally {
        for (const m of [...mods].reverse()) await keyboard.releaseKey(m);
      }
    },
    async scroll(dx, dy) {
      if (dy) dy > 0 ? await mouse.scrollDown(Math.abs(dy)) : await mouse.scrollUp(Math.abs(dy));
      if (dx) dx > 0 ? await mouse.scrollRight(Math.abs(dx)) : await mouse.scrollLeft(Math.abs(dx));
    },

    async typeText(text, submit) {
      if (text) await keyboard.type(text);
      if (submit) await keyboard.type(Key.Enter);
    },
    async keyTap(name, modifiers = []) {
      const key = resolveKey(name);
      if (key === undefined) {
        log.warn(`nut.js: unknown key "${name}"`);
        return;
      }
      const mods = modifiers
        .map((m) => modMap[m.toLowerCase()])
        .filter((m): m is unknown => m !== undefined);

      for (const m of mods) await keyboard.pressKey(m);
      await keyboard.pressKey(key);
      await keyboard.releaseKey(key);
      for (const m of [...mods].reverse()) await keyboard.releaseKey(m);
    },
    async keyHold(name, down) {
      // Modifier names ("meta", "alt") resolve through modMap — resolveKey only knows
      // regular keys — so the app-switcher can hold its ⌘/Alt.
      const key = modMap[name.toLowerCase()] ?? resolveKey(name);
      if (key === undefined) {
        log.warn(`nut.js: unknown key "${name}"`);
        return;
      }
      if (down) await keyboard.pressKey(key);
      else await keyboard.releaseKey(key);
    },
  };
}

/** Maps DOM-ish key names to nut.js Key enum members. */
function buildKeyMap(Key: any): Record<string, unknown> {
  return {
    enter: Key.Enter,
    return: Key.Enter,
    escape: Key.Escape,
    esc: Key.Escape,
    backspace: Key.Backspace,
    delete: Key.Delete,
    tab: Key.Tab,
    space: Key.Space,
    " ": Key.Space,
    arrowup: Key.Up,
    arrowdown: Key.Down,
    arrowleft: Key.Left,
    arrowright: Key.Right,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    // Backtick — the ⌘+` same-app window cycle (resolveKey's single-char path only covers A-Z/0-9).
    "`": Key.Grave,
    grave: Key.Grave,
    backquote: Key.Grave,
  };
}
