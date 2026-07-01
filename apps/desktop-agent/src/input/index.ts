import { log } from "../logger";
import { createAppleScriptBackend } from "./applescript";
import { createNutBackend } from "./nut";
import type { InputBackend, ScreenSize } from "./types";

export type { InputBackend, ScreenSize } from "./types";

/**
 * Picks the best available input backend:
 *   1. nut.js (full mouse + keyboard)
 *   2. AppleScript (keyboard only, macOS) — keeps "send a prompt" working
 *   3. null backend (view-only)
 */
export async function selectInputBackend(): Promise<InputBackend> {
  const nut = await createNutBackend();
  if (nut) {
    log.info(`input backend: ${nut.name}`);
    return nut;
  }

  const apple = await createAppleScriptBackend();
  if (apple) {
    log.warn(`input backend: ${apple.name} — mouse control unavailable`);
    return apple;
  }

  log.warn("input backend: none — running view-only");
  return createNullBackend();
}

function createNullBackend(): InputBackend {
  return {
    name: "null",
    canMouse: false,
    canKeyboard: false,
    async getScreenSize(): Promise<ScreenSize> {
      return { width: 0, height: 0 };
    },
    setActiveDisplay() {},
    async moveTo() {},
    async buttonDown() {},
    async buttonUp() {},
    async click() {},
    async scroll() {},
    async typeText() {},
    async keyTap() {},
  };
}
