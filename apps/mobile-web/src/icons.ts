/**
 * Inline SVG icon set for the controller UI. Returns an <svg> element so buttons stay
 * crisp and professional (no emoji). Icons use `currentColor` so they inherit button text
 * color. Paths are simple 24x24 line icons.
 */
export type IconName =
  | "eye"
  | "mouse"
  | "keyboard"
  | "monitor"
  | "hand"
  | "bell"
  | "plus"
  | "minus"
  | "chevron-down"
  | "chevron-up"
  | "chevron-left"
  | "chevron-right"
  | "pointer"
  | "scroll-up"
  | "scroll-down"
  | "page-up"
  | "page-down"
  | "mouse-left"
  | "mouse-right"
  | "double-click"
  | "drag"
  | "send"
  | "insert"
  | "lock"
  | "clock"
  | "play"
  | "zap"
  | "power"
  | "activity"
  | "x"
  | "check"
  | "heart"
  | "trash"
  | "book"
  | "pencil"
  | "fullscreen"
  | "fullscreen-exit"
  | "github"
  | "reddit";

const PATHS: Record<IconName, string> = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4m0-1V4.5a1.5 1.5 0 0 1 3 0V10m0-1.5a1.5 1.5 0 0 1 3 0V12c0 4-2.5 8-6.5 8S6 17 5 15l-1.5-3a1.4 1.4 0 0 1 2.3-1.5L7 12"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m6 15 6-6 6 6"/>',
  "chevron-left": '<path d="m15 6-6 6 6 6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  pointer: '<path d="m4 4 6 16 2.5-6.5L19 11Z"/>',
  "scroll-up": '<path d="m6 14 6-6 6 6"/><path d="M12 8v11"/>',
  "scroll-down": '<path d="m6 10 6 6 6-6"/><path d="M12 16V5"/>',
  // Like scroll-up/down with a bar: jump a whole page toward the top/bottom.
  "page-up": '<path d="M5 4h14"/><path d="m7 13 5-5 5 5"/><path d="M12 9v11"/>',
  "page-down": '<path d="M5 20h14"/><path d="m7 11 5 5 5-5"/><path d="M12 15V4"/>',
  "mouse-left": '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v8H6V8"/>',
  "mouse-right": '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v8h6V8"/>',
  "double-click": '<path d="m4 4 6 16 2.5-6.5L19 11Z"/><path d="M18 4v3M21 6h-3"/>',
  drag: '<path d="M12 2v20M2 12h20" /><path d="m8 6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/>',
  // Arrow dropping down into an open text field — reads as "insert this into the box you're typing in".
  insert: '<path d="M12 3v8m-3.5-3.5L12 11l3.5-3.5"/><path d="M5 14v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M7 4.5v15l13-7.5Z"/>',
  // Lightning bolt = LashStash (execute a stored automation). Placeholder until a raster mark lands.
  zap: '<path d="M13 2 3 14h7l-1 8 11-14h-7l1-6Z"/>',
  power: '<path d="M12 3v9"/><path d="M6.4 7.4a8 8 0 1 0 11.2 0"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  x: '<path d="M6 6 18 18M18 6 6 18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  heart: '<path d="M12 20s-7-4.4-9.3-8.5a4.5 4.5 0 0 1 8.1-3.9l1.2 1.6 1.2-1.6a4.5 4.5 0 0 1 8.1 3.9C19 15.6 12 20 12 20Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  // Corner brackets pointing out = enter fullscreen; pointing in = exit fullscreen.
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  "fullscreen-exit": '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  // Brand marks: solid glyphs, so they override the icon set's stroke styling with their own fill.
  github:
    '<path fill="currentColor" stroke="none" d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z"/>',
  reddit:
    '<path fill="currentColor" stroke="none" d="M24 11.78a2.6 2.6 0 0 0-4.4-1.86 12.74 12.74 0 0 0-6.86-2.16l1.17-3.68 3.16.74a1.83 1.83 0 1 0 .2-1.18l-3.6-.85a.6.6 0 0 0-.72.43l-1.3 4.08a12.8 12.8 0 0 0-7 2.18 2.6 2.6 0 1 0-2.86 4.28 5.1 5.1 0 0 0-.06.79c0 4 4.66 7.24 10.42 7.24S20.42 17.83 20.42 12.95c0-.26-.02-.52-.06-.78A2.6 2.6 0 0 0 24 11.78ZM6.13 13.5a1.83 1.83 0 1 1 3.66 0 1.83 1.83 0 0 1-3.66 0Zm10.2 4.83c-1.25 1.25-3.64 1.34-4.33 1.34-.7 0-3.09-.09-4.33-1.34a.47.47 0 0 1 .67-.67c.79.79 2.47.99 3.66.99 1.2 0 2.88-.2 3.67-.99a.47.47 0 1 1 .66.67h.03Zm-.27-3a1.83 1.83 0 1 1 0-3.66 1.83 1.83 0 0 1 0 3.66Z"/>',
};

const NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = PATHS[name];
  return svg;
}
