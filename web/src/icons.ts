/**
 * Kururu's icons, as drawings rather than characters.
 *
 * They were characters — `✕`, `▸`, `⊞` — and a character is the font's to draw:
 * its weight, its size inside the em and which of the fallback faces it comes
 * out of are all decided somewhere kururu has no say, so the close button on a
 * tab was a hairline a few pixels across and the split buttons were whatever
 * the Nerd Font stack happened to hold for a box-drawing symbol. Fine under a
 * mouse, and not a thing a thumb can find.
 *
 * These are Lucide's (ISC — the notice is `web/src/icons.LICENSE`), vendored as
 * the inner markup of each 24×24 drawing rather than installed. A dependency
 * would bring fifteen hundred icons to use fifteen, and would also be one more
 * `bun install`, which on this project strips the executable bit off node-pty's
 * spawn helper under a running host. To add one, copy the children of its
 * `<svg>` from lucide-static and give it a name in `shared/skin.ts` first.
 *
 * They reach the page as `mask-image` on a `::before`, not as `<svg>` elements
 * in the TSX, and that keeps the rule `Icon.tsx` and `skin.ts` are built on: an
 * icon is a custom property, so a skin that swaps one for a glyph moves a
 * property and nothing re-renders. A mask is what makes a data URI take
 * `currentColor` — an SVG drawn as an image cannot see the colour of the
 * element it sits in, and every one of these changes colour on hover.
 */
import { ICON_NAMES, type IconName } from "../../shared/skin";

const VECTORS: Record<IconName, string> = {
  close: /* x */ `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  /* zap. A dev server is started, not played: the triangle read as a media
     control on a row that has nothing to play, and it is now on `play` below,
     where there is something. */
  run: /* zap */ `<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>`,
  restart: /* rotate-cw */ `<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>`,
  caret: /* chevron-down */ `<path d="m6 9 6 6 6-6"/>`,
  add: /* plus */ `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  edit: /* pencil */ `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
  external: /* external-link */ `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
  "split-right": /* columns-2 */ `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>`,
  "split-down": /* rows-2 */ `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/>`,
  settings: /* settings */ `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>`,
  share: /* qr-code */ `<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>`,
  follow: /* arrow-left-right */ `<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>`,
  pin: /* pin */ `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`,
  panes: /* layout-panel-left */ `<rect width="7" height="18" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/>`,
  hide: /* eye-off */ `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>`,
  database: /* database */ `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>`,
  /* square, filled, and drawn inside lucide's frame rather than on it. The
     others here are strokes and take their weight from the 2-unit line; a solid
     shape takes it from its area, and lucide's 18×18 square filled is nearly
     twice the ink of the play triangle it sits next to — which at twelve pixels
     reads as a tile rather than as the other half of a pair. This is the square
     that matches the triangle's weight. */
  stop: /* square */ `<rect width="14" height="14" x="5" y="5" rx="2"/>`,
  play: /* play */ `<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>`,
};

/**
 * The ones that are solid rather than drawn in line: a bolt, a play triangle and
 * a stop square are all a shape at this size, and an outlined shape reads as a
 * gap where a button should be.
 */
const FILLED = new Set<IconName>(["run", "stop", "play"]);

/**
 * One drawing as something `mask-image` can take. The stroke is black because a
 * mask reads only alpha, so the colour is irrelevant and the one that needs no
 * escaping is the one to write.
 */
export function iconUrl(name: IconName): string {
  const fill = FILLED.has(name) ? "black" : "none";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}" stroke="black"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${VECTORS[name]}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Written once, at load, and never again: no skin can change a drawing, only
 * ask for a glyph in its place, so there is nothing about these that depends on
 * which skin is on. Done at import rather than beside `applySkin` so the first
 * paint — before any snapshot has arrived — already has them, and an icon is
 * never an empty 1em box that fills in a moment later.
 */
export function applyIcons(): void {
  const root = document.documentElement;
  for (const name of ICON_NAMES) root.style.setProperty(`--icon-${name}-svg`, iconUrl(name));
}
