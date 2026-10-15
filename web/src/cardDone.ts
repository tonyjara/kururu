/**
 * Done's own question — end the agent too, or merge — asked identically
 * wherever a card can be moved to Done: the board's drag and its card menu,
 * and the Needs drawer's right-click "Move to Done" on a card the drawer
 * otherwise never touches. One flow, built once, so the two can never drift
 * into two different questions for the same move.
 */
import { useState } from "react";
import { canResume, type Card, type CardWorktree } from "../../shared/board";
import type { MergeBlock, MergeResolution } from "../../shared/projects";
import * as api from "./session";

/**
 * A merge, or a move to Done, waiting for its second click — as a centred
 * dialog rather than the menu or row it may have opened from, because a
 * question about ending an agent wants to be seen, not scrolled to.
 */
export interface Ask {
  cardId: string;
  title: string;
  hint?: string;
  yes?: string;
  run?: () => void;
  alt?: { label: string; run: () => void };
  choices?: { label: string; outcome: string; run: () => void }[];
}

/**
 * What a caller wants told about while a merge is in flight. A card on a
 * board shows a spinner and writes a note on the card itself; the Needs
 * drawer has no card to write on and can leave any of these out.
 */
interface On {
  working?: (cardId: string, text: string) => void;
  done?: (cardId: string) => void;
  note?: (cardId: string, text: string) => void;
  error?: (cardId: string, err: unknown) => void;
  clearError?: (cardId: string) => void;
}

export function useCardDone(agentOpen: (card: Card) => boolean, devOpen: (card: Card) => boolean, on: On = {}) {
  const [ask, setAsk] = useState<Ask | null>(null);

  /**
   * The git a move to Done needs when there is a worktree: commit, when the
   * merge asked for one, then merge. A blocked merge gets its own question
   * instead of the error it would otherwise fail with.
   */
  const merge = (workspaceId: string, card: Card, tree: CardWorktree, commitFirst: boolean, resolve?: MergeResolution) => {
    on.working?.(card.id, commitFirst ? "Committing and merging…" : "Merging…");
    return (commitFirst ? api.commitCard(workspaceId, card.id) : Promise.resolve(null))
      .then(() => api.mergeCard(workspaceId, card.id, resolve))
      .then((reply) => {
        on.done?.(card.id);
        if ("blocked" in reply) {
          askAboutBlock(workspaceId, card, tree, reply.blocked);
          return;
        }
        const merged = `Merged ${reply.commits} ${reply.commits === 1 ? "commit" : "commits"} into ${tree.base}; worktree removed`;
        if (reply.note) on.error?.(card.id, new Error(`${merged} — but ${reply.note}`));
        else on.note?.(card.id, merged);
      })
      .catch((err: unknown) => {
        on.done?.(card.id);
        on.error?.(card.id, err);
      });
  };

  /**
   * The merge that stopped before it started, because the checkout `base` is
   * on has uncommitted work in the files this branch changes. Git would have
   * refused the fast-forward over it; the server saw that coming and ended
   * nothing. The card says what is in the way and, when a dry run says the
   * two sets of changes fit, offers the two ways through with what each one
   * does — commit the work on the base first and rebase the card over it, or
   * git's own autostash around the fast-forward. A dry run that conflicted
   * gets neither, because both would land in the same conflict, one of them
   * in a worse place: that one is the person's to resolve by hand. An
   * untracked file the branch would create is the same kind of stop, since
   * autostash leaves untracked files where they are and a commit would only
   * turn the collision into an add/add conflict.
   */
  const askAboutBlock = (workspaceId: string, card: Card, tree: CardWorktree, block: MergeBlock) => {
    const list = (paths: string[]) => paths.slice(0, 4).join(", ") + (paths.length > 4 ? ` and ${paths.length - 4} more` : "");
    const parts: string[] = [];
    if (block.files.length) {
      parts.push(
        `${block.base} has uncommitted changes in ${list(block.files)}, which this branch also changes, and git will not fast-forward over them.`,
      );
    }
    if (block.untracked.length) {
      parts.push(
        `${block.base} has untracked ${list(block.untracked)}, which this branch creates. Move or remove ${
          block.untracked.length === 1 ? "it" : "them"
        } and merge again.`,
      );
    }
    const offer = !block.untracked.length && block.clean !== false;
    if (!block.untracked.length) {
      parts.push(
        block.clean === true
          ? "In a dry run the two fit together, so either of these gets through:"
          : block.clean === false
            ? `In a dry run they conflict, so neither committing nor stashing them would get past this. Resolve it on ${block.base} by hand, then merge again.`
            : "Whether the two fit together could not be checked; if they do not, the step that finds out stops and says so.",
      );
    }
    setAsk({
      cardId: card.id,
      title: "Merge blocked",
      hint: parts.join(" "),
      choices: offer
        ? [
            {
              label: `Commit ${block.base}, then merge`,
              outcome:
                `Everything uncommitted on ${block.base} is committed as “wip: before merging ${card.title}”, the card is rebased onto ` +
                `that, and ${block.base} fast-forwards. A rebase that conflicts is aborted and the worktree stays.`,
              run: () => merge(workspaceId, card, tree, false, "commit"),
            },
            {
              label: "Stash, merge, restore",
              outcome:
                `git merge --autostash: the changes are set aside, ${block.base} fast-forwards, and they are put back uncommitted. ` +
                "If they do not apply, they stay in git stash and the card says so.",
              run: () => merge(workspaceId, card, tree, false, "stash"),
            },
          ]
        : [],
    });
  };

  /**
   * Every road into Done — the board's drag, its own menu row, and the
   * Needs drawer's "Move to Done" alike. Done is the one that is not just a
   * move for a card with a worktree: on a board that runs cards in
   * worktrees, done means merged — so the card asks, in place, with what
   * the merge will cost, and a yes is `merge-card`, which rebases, fast-
   * forwards the base, takes the worktree down, ends the agent and lands
   * the card in Done itself. Uncommitted work is offered a commit first
   * rather than a refusal, because the card is its message and whoever
   * moved it has already said the work is finished. "Just move" is there
   * for the card whose merge cannot happen yet — a rebase that conflicts, a
   * base that is somewhere else — and leaves the worktree standing. An
   * agent still open with no worktree is asked whether it goes too, rather
   * than ended outright, since it may be the one that did the merge and
   * still have something to say.
   */
  const moveToDone = (workspaceId: string, card: Card, index?: number) => {
    const tree = card.worktree;
    const running = agentOpen(card);
    if (card.column === "done" || (!tree && !running)) {
      api.moveCard(workspaceId, card.id, "done", index);
      return;
    }
    if (!tree) {
      const agentId = card.run?.agentId;
      on.clearError?.(card.id);
      setAsk({
        cardId: card.id,
        title: `End ${card.run?.label ?? "the agent"} too?`,
        hint: canResume(card.run, false) ? "The conversation can be picked up again from the robot." : undefined,
        yes: "Move and end agent",
        run: () => {
          api.moveCard(workspaceId, card.id, "done", index);
          if (agentId) api.closeTab(agentId);
        },
        alt: { label: "Just move", run: () => api.moveCard(workspaceId, card.id, "done", index) },
      });
      return;
    }
    api.worktreeStatus(workspaceId, card.id).then((status) => {
      const changes = status.changes.length;
      const commits = `${status.ahead} ${status.ahead === 1 ? "commit" : "commits"}`;
      const dirty = changes ? ` ${changes} uncommitted ${changes === 1 ? "file is" : "files are"} committed first as “${card.title}”.` : "";
      const nothing = !changes && status.ahead === 0 ? " Nothing on the branch is new." : "";
      on.clearError?.(card.id);
      setAsk({
        cardId: card.id,
        title: running ? `Merge and end ${card.run?.label ?? "the agent"}?` : `Merge into ${tree.base}?`,
        hint:
          `${commits} into ${tree.base}.${dirty}${nothing} ` +
          `The worktree is removed${devOpen(card) ? ", its dev server stopped" : ""} and branch ${tree.branch} deleted.`,
        yes: changes ? "Commit and merge" : "Merge",
        run: () => merge(workspaceId, card, tree, changes > 0),
        alt: { label: "Just move", run: () => api.moveCard(workspaceId, card.id, "done", index) },
      });
    }, (err: unknown) => on.error?.(card.id, err));
  };

  return { ask, setAsk, merge, moveToDone };
}
