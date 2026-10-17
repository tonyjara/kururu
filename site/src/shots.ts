/**
 * The screenshots, taken from the real app in an isolated instance filled with
 * made-up projects, so nothing of anybody's own work is on the page. Sizes are
 * the files' own, so every <img> reserves its box; the wide ones come in two
 * widths and the browser picks.
 */
export type ShotInfo = { src: string; srcSet?: string; alt: string; width: number; height: number };

function wide(name: string, height: number, alt: string): ShotInfo {
  return {
    src: `/shots/${name}.webp`,
    srcSet: `/shots/${name}-1200.webp 1200w, /shots/${name}.webp 2400w`,
    alt,
    width: 2400,
    height,
  };
}

export const SHOTS = {
  hero: wide(
    "hero",
    1500,
    "Kururu's window: a sidebar of four project workspaces and their agents, a board with cards in To do, In progress, Review and Done, and below it an agent fixing a bug beside a shell running tests.",
  ),
  board: wide(
    "board",
    823,
    "A project's board. Cards in progress and in review show the agent working on them, its model, and an open button.",
  ),
  reader: wide(
    "reader",
    1500,
    "A markdown guide rendered in a pane, with a highlighted code block and a table, beside the agent that wrote it.",
  ),
  kuru: wide(
    "kuru",
    1500,
    "The Kuru drawer: spoken and typed prompts, Kuru's replies about the agents across projects, and a notice that one agent is blocked.",
  ),
  needs: wide(
    "needs",
    1500,
    "The Needs you drawer listing four items in three workspaces, beside an agent asking permission to run a database migration.",
  ),
  phone: {
    src: "/shots/phone.webp",
    alt: "Kururu on a phone: the workspaces and every agent in them, with status and context used.",
    width: 780,
    height: 1688,
  },
  phone2: {
    src: "/shots/phone2.webp",
    alt: "The Kuru conversation on a phone.",
    width: 780,
    height: 1688,
  },
} satisfies Record<string, ShotInfo>;
