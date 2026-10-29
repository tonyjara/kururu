/**
 * The cards the menu bar can pop out as notes, for a Mac with no window open.
 *
 * The desktop app's frog is the one face kururu has when the window is
 * closed, and a note is wanted most then: the card beside the editor or the
 * call. The frog has no socket and no snapshot, so it asks the server
 * (`GET /api/notes/cards`) and is answered with this — the active profile's
 * cards, with what a menu row needs and nothing else.
 *
 * **What needs you first.** The Needs drawer's cards, by its own rule
 * (`needsOf`), never decided again here: a card in Review, a card whose
 * agent is asking or went without finishing, a card in the profile board's
 * Needs you. Then the profile's own board, a column at a time in its order,
 * which is where somebody looking for "the plan" finds it. A workspace's
 * board past its Needs is not offered: it is a board of tasks for agents,
 * and the window is the place to browse those.
 */
import { boardLanes, cardCode, columnCards, type Card } from "./board";
import type { AgentSnapshot, Profile, Workspace } from "./model";
import { needsOf } from "./needs";

export interface NoteCard {
  id: string;
  /** `KUR-12`, as the note's title bar says it. */
  code: string;
  title: string;
  /** The workspace whose board it is on, or null for the profile's own. */
  where: string | null;
}

export interface NoteCardColumn {
  id: string;
  name: string;
  cards: NoteCard[];
}

export interface NoteCards {
  /** Whose cards these are: a note is kept under its profile's key, as the window's are. */
  profileKey: string;
  profileName: string;
  needs: NoteCard[];
  /** The profile's board, its lanes in order, empty ones included. */
  columns: NoteCardColumn[];
}

function row(profile: Profile, card: Card, workspace: Workspace | null): NoteCard {
  return {
    id: card.id,
    code: cardCode(workspace ? workspace.name : profile.name, card.number),
    title: card.title,
    where: workspace ? workspace.name : null,
  };
}

export function noteCards(profile: Profile, agents: readonly AgentSnapshot[]): NoteCards {
  const needs = needsOf(profile, agents);
  const seen = new Set<string>();
  const needed: NoteCard[] = [];
  for (const workspace of needs.workspaces) {
    const where = profile.workspaces.find((w) => w.id === workspace.workspace.id) ?? null;
    for (const need of workspace.needs) {
      if (!need.card || seen.has(need.card.id)) continue;
      seen.add(need.card.id);
      needed.push(row(profile, need.card, where));
    }
  }
  for (const card of needs.cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    needed.push(row(profile, card, null));
  }
  const columns = boardLanes(profile.board).map((lane) => ({
    id: lane.id,
    name: lane.name,
    cards: columnCards(profile.board, lane.id).map((card) => row(profile, card, null)),
  }));
  return { profileKey: profile.key, profileName: profile.name, needs: needed, columns };
}
