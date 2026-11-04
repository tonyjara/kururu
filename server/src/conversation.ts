/**
 * The database's side of the conversation: search over cards and Kuru's
 * turns, a card's history, a turn recorded off an agent's report, and an
 * aside Kuru says without waiting for a turn.
 *
 * Small, and apart from `kuru.ts` because these are the server's verbs on the
 * store — each reads the profile on screen or an agent's place in it, which
 * `Kuru`, built only from the store, the outbox and the voice, never sees.
 */
import type { Card } from "../../shared/board";
import { harnessConversation, OPENCODE_SESSION_ID } from "../../shared/harness";
import { type SearchHit, sessionOfTranscript } from "../../shared/store";
import { channels, harness, host, kuru, store, voice, workspaces } from "./context";
import type { SayOutcome } from "./harness";

/** Hits for a profile, with this session's ids beside the keys so a window can go to the card. */
export function searchFor(profileId: string, query: string, scope: "all" | "cards" | "turns", limit: number): SearchHit[] {
  const key = workspaces.keyOf(profileId);
  if (!key) return [];
  const profile = workspaces.profileByKey(key);
  return store.search(query, scope, key, limit).map((hit) => {
    if (hit.kind === "card") {
      const workspaceId = hit.workspaceKey ? (profile?.workspaces.find((w) => w.key === hit.workspaceKey)?.id ?? null) : null;
      return { ...hit, profileId, workspaceId };
    }
    return { ...hit, profileId };
  });
}

/**
 * The profile's pinned lines with Kuru, for its `search` tool's `pinned`
 * scope, newest said first, as hits the way a search's turns are — so Kuru
 * reads "what did I pin" in the words it already reads a search in. The
 * snippet is the opening, since there is no match to mark.
 */
export function pinnedFor(profileId: string): SearchHit[] {
  const key = workspaces.keyOf(profileId);
  if (!key) return [];
  return store
    .pinnedTurns(key)
    .reverse()
    .map(({ turn }) => ({
      kind: "turn" as const,
      id: turn.id,
      conversationId: turn.conversationId,
      conversationKind: "harness" as const,
      profileKey: key,
      role: turn.role,
      via: turn.via,
      at: turn.at,
      snippet: turn.text.replace(/\s+/g, " ").trim().slice(0, PINNED_SNIPPET_MAX),
      text: turn.text.slice(0, PINNED_TEXT_MAX),
      pinned: true,
      profileId,
    }));
}

/** How much of a pinned line Kuru reads in its listing; the whole of it is a search for its words away. */
const PINNED_SNIPPET_MAX = 300;
const PINNED_TEXT_MAX = 2_000;

export function cardHistoryOf(cardId: string): { card: Card; workspaceName: string | null; deleted: boolean; events: import("../../shared/store").CardEvent[] } | null {
  const found = store.findCard(cardId);
  if (!found) return null;
  const profile = workspaces.profileByKey(found.profileKey);
  const workspaceName = found.workspaceKey ? (profile?.workspaces.find((w) => w.key === found.workspaceKey)?.name ?? null) : null;
  return { card: found.card, workspaceName, deleted: found.deleted, events: store.cardHistory(cardId) };
}

/**
 * What a hook report says about a conversation, written down. The harness's
 * prompt on `UserPromptSubmit` is the one report that is `working` with a
 * message; its reply on `Stop` is `done` with one. Any other agent's reply
 * is kept too, as its own conversation named by its transcript, so the
 * search finds what an agent said about a card.
 */
export function recordTurn(agentId: string, report: { status?: string; message?: string }, body: Record<string, unknown>, utterance: string | null): number | null {
  const profileId = workspaces.profileOf(agentId);
  const profile = profileId ? workspaces.profile(profileId) : null;
  if (!profile) return null;
  const reply = typeof body.reply === "string" ? body.reply.trim() : "";
  const at = Date.now();
  const cwd = host.find(agentId)?.cwd ?? null;
  try {
    if (harness.isHarness(agentId) && profile.harness) {
      const base = { conversationId: harnessConversation(profile.harness), profileKey: profile.key, kind: "harness" as const, launcher: profile.harness.launcher, cwd, at };
      if (report.status === "working" && report.message?.trim()) store.recordTurn({ ...base, role: "you", text: report.message.trim() });
      // The reply names the utterance it was said as, so the drawer can put
      // its fate — being said, unheard, heard — beside the words.
      const turn = report.status === "done" && reply ? store.recordTurn({ ...base, role: "kuru", text: reply, voiceId: utterance }) : null;
      kuru.changed();
      return turn;
    }
    if (report.status !== "done" || !reply) return null;
    const reportedSession = typeof body.session === "string" && OPENCODE_SESSION_ID.test(body.session) ? body.session : null;
    const sessionId = sessionOfTranscript(typeof body.transcript === "string" ? body.transcript : null) ?? reportedSession;
    if (!sessionId) return null;
    store.recordTurn({ conversationId: sessionId, profileKey: profile.key, kind: "agent", launcher: null, cwd, role: "agent", text: reply, at });
  } catch (err) {
    console.error(`kururu: a turn could not be written down: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/**
 * A line Kuru says aloud mid-turn through its `say` tool: spoken, and written
 * down as a turn of its own — `via: "kururu"`, which the drawer draws smaller —
 * named for the utterance it was said as, so a line that was cut off shows as
 * unheard beside the reply it preceded and can be played again from there.
 */
export function sayAside(profileId: string, text: string): SayOutcome {
  const profile = workspaces.profile(profileId);
  const key = profile?.key ?? "";
  // Not aloud with "speak replies" off, which `aside` asks; and not in a turn
  // that answers only a channel, for the reason its reply is not
  // (`replySpoken`). In the chat and the drawer either way.
  const outcome: SayOutcome = !voice.speaks() ? "voice-off" : key && !channels.speaks(key) ? "channel" : "spoken";
  const utterance = outcome === "spoken" ? voice.aside(key, text) : null;
  if (key) channels.aside(key, text);
  if (!profile?.harness) return outcome;
  try {
    store.recordTurn({
      conversationId: harnessConversation(profile.harness),
      profileKey: profile.key,
      kind: "harness",
      launcher: profile.harness.launcher,
      cwd: null,
      role: "kuru",
      via: "kururu",
      text,
      voiceId: utterance,
      at: Date.now(),
    });
    kuru.changed();
  } catch (err) {
    console.error(`kururu: a said line could not be written down: ${err instanceof Error ? err.message : String(err)}`);
  }
  return outcome;
}
