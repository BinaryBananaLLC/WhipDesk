import type { MouseButton } from "@whipdesk/protocol";

export interface ScreenSize {
  width: number;
  height: number;
}

/** Active display geometry in global logical points (origin = its top-left). */
export interface ActiveDisplay {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Injects input on the host. All pointer coordinates are NORMALIZED [0,1] of the active
 * display; implementations multiply by the active display size (and add its origin) so
 * input lands on whichever monitor is selected. Methods must reject by throwing — the
 * transport layer catches and surfaces an `error` control message.
 */
export interface InputBackend {
  readonly name: string;
  readonly canMouse: boolean;
  readonly canKeyboard: boolean;

  /** Logical screen size in points (used for normalized -> point mapping). */
  getScreenSize(): Promise<ScreenSize>;

  /** Set which display pointer coords map onto. null = primary at origin (0,0). */
  setActiveDisplay(display: ActiveDisplay | null): void;

  moveTo(nx: number, ny: number): Promise<void>;
  buttonDown(button: MouseButton, nx?: number, ny?: number): Promise<void>;
  buttonUp(button: MouseButton): Promise<void>;
  /** `modifiers` (e.g. ["control"], ["meta"]) are held for the duration of the click. */
  click(button: MouseButton, double: boolean, nx?: number, ny?: number, modifiers?: string[]): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;

  typeText(text: string, submit?: boolean): Promise<void>;
  keyTap(key: string, modifiers?: string[]): Promise<void>;
  /**
   * Press (`down: true`) or release a single key and LEAVE it that way — used to hold the
   * app-switcher's ⌘/Alt across several Tab taps. The caller owns releasing it (the session
   * releases any still-held key when the controller disconnects).
   */
  keyHold(key: string, down: boolean): Promise<void>;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
