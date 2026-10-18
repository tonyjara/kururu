/**
 * The screenshots, taken from the real app in an isolated instance filled with
 * made-up projects, so nothing of anybody's own work is on the page. Sizes are
 * the files' own, so every <img> reserves its box.
 *
 * Each is WebP with a JPEG beside it. WebP alone was smaller and enough for
 * every current browser, but a browser that will not decode it — an iPhone in
 * Lockdown Mode is the likely one — got an empty frame with nothing to fall
 * back to. The wide ones come in two widths and the browser picks.
 */
export type ShotInfo = {
  /** The file's name under /shots, without the extension. */
  name: string;
  alt: string;
  width: number;
  height: number;
  /** Also cut at 1200px wide, as `<name>-1200`. */
  wide?: boolean;
  /**
   * What a phone gets instead. A whole desktop window drawn 370px wide is a
   * smudge of two-pixel text, so the hero shows a corner of it a phone can read.
   */
  phone?: { name: string; width: number; height: number };
};

export const SHOTS = {
  hero: {
    name: "hero",
    wide: true,
    width: 2400,
    height: 1500,
    phone: { name: "hero-phone", width: 1240, height: 1240 },
    alt: "Kururu's window: a sidebar of four project workspaces and their agents, a board with cards in To do, In progress, Review and Done, and below it an agent fixing a bug beside a shell running tests.",
  },
  board: {
    name: "board",
    wide: true,
    width: 2400,
    height: 823,
    alt: "A project's board. Cards in progress and in review show the agent working on them, its model, and an open button.",
  },
  reader: {
    name: "reader",
    wide: true,
    width: 2400,
    height: 1500,
    alt: "A markdown guide rendered in a pane, with a highlighted code block and a table, beside the agent that wrote it.",
  },
  kuru: {
    name: "kuru",
    wide: true,
    width: 2400,
    height: 1500,
    alt: "The Kuru drawer: spoken and typed prompts, Kuru's replies about the agents across projects, and a notice that one agent is blocked.",
  },
  needs: {
    name: "needs",
    wide: true,
    width: 2400,
    height: 1500,
    alt: "The Needs you drawer listing four items in three workspaces, beside an agent asking permission to run a database migration.",
  },
  phone: {
    name: "phone",
    width: 780,
    height: 1688,
    alt: "Kururu on a phone: the workspaces and every agent in them, with status and context used.",
  },
  phone2: {
    name: "phone2",
    width: 780,
    height: 1688,
    alt: "The Kuru conversation on a phone.",
  },
} satisfies Record<string, ShotInfo>;
