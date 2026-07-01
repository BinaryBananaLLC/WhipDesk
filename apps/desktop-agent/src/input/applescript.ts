import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InputBackend, ScreenSize } from "./types";

const exec = promisify(execFile);

/**
 * Keyboard-only fallback for macOS via `osascript`. Used when nut.js fails to load so
 * that the headline feature — typing a prompt into the AI — keeps working. Mouse methods
 * are no-ops (capabilities advertise `canMouse: false`).
 */
export async function createAppleScriptBackend(): Promise<InputBackend | null> {
  if (process.platform !== "darwin") return null;

  const run = (script: string) => exec("osascript", ["-e", script]).then(() => undefined);

  return {
    name: "applescript (keyboard-only)",
    canMouse: false,
    canKeyboard: true,

    async getScreenSize(): Promise<ScreenSize> {
      return { width: 0, height: 0 };
    },
    setActiveDisplay() {},
    async moveTo() {},
    async buttonDown() {},
    async buttonUp() {},
    async click() {},
    async scroll() {},

    async typeText(text, submit) {
      if (text) await run(`tell application "System Events" to keystroke ${asAppleString(text)}`);
      if (submit) await run(`tell application "System Events" to key code 36`);
    },
    async keyTap(name, modifiers = []) {
      const using = modifiers
        .map(modifierClause)
        .filter((m): m is string => m !== null)
        .join(", ");
      const usingClause = using ? ` using {${using}}` : "";
      const code = KEY_CODES[name.toLowerCase()];
      if (code !== undefined) {
        await run(`tell application "System Events" to key code ${code}${usingClause}`);
      } else if (name.length === 1) {
        await run(`tell application "System Events" to keystroke ${asAppleString(name)}${usingClause}`);
      }
    },
  };
}

function asAppleString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function modifierClause(name: string): string | null {
  switch (name.toLowerCase()) {
    case "meta":
    case "cmd":
    case "command":
    case "win":
      return "command down";
    case "control":
    case "ctrl":
      return "control down";
    case "alt":
    case "option":
      return "option down";
    case "shift":
      return "shift down";
    default:
      return null;
  }
}

/** AppleScript virtual key codes for common special keys. */
const KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  arrowleft: 123,
  arrowright: 124,
  arrowdown: 125,
  arrowup: 126,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
};
