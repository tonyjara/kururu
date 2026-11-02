/**
 * Notifications: the only thing kururu does that reaches somebody who is not
 * looking at it, which is what makes every decision in here about
 * *restraint*. The policy is `shared/notify.ts`, ported from ghosttown so that
 * "needs input" means the same thing in both; what is here is the two things
 * the policy cannot be pure about — noticing that a status moved, and knowing
 * which clients can already see it.
 *
 * It lives in the server and not in `agents/`, and that is not filing. The
 * host is where a status is *computed*, and it is also the half of kururu that
 * costs the user every running agent to edit — so a feature that will be
 * tuned (and this one will: every threshold in a notification is a matter of
 * taste) belongs on the side that restarts for free. It is the same line
 * `activity` and `unread` are drawn on, in `context.ts`, and the reason both
 * of those sit on this side too.
 */
import { agentLabel, agentSummary, basename } from "../../shared/labels";
import { type AgentSnapshot, type AgentStatus, countsAsAgent } from "../../shared/model";
import { isNotifyEvent, NOTIFY_THROTTLE_MS, type NotifyEvent, notifyGate, notifyText } from "../../shared/notify";
import { clients, harness, host, notify, onScreenAnywhere, overlay, send, sleeper, unread, workspaces } from "./context";

/**
 * What each terminal's status was the last time we looked.
 *
 * Notifications are about *transitions* and a snapshot only carries states, so
 * somebody has to remember. The host cannot: it raises `onAgents` when anything
 * changes and says nothing about what changed, which is right — a delta is a
 * thing every reader of this protocol would then have to understand, and the
 * one reader that wants it can keep four bytes per terminal instead.
 *
 * An id that is not in here yet notifies for nothing, which is the whole reason
 * the absent case is separated from the equal case below. A server restart
 * relearns every status on the first tick, and without that guard sixteen
 * terminals sitting at `done` would all announce themselves at once — the same
 * "a restart forgets it and that is correct" the `activity` map argues for,
 * except that here forgetting it wrongly is audible.
 */
const lastStatus = new Map<string, AgentStatus>();

/** When each terminal was last allowed to interrupt. See `NOTIFY_THROTTLE_MS`. */
const notifiedAt = new Map<string, number>();

/**
 * Look for terminals that have just started wanting a human, and answer it twice
 * — with a card for whoever is reachable now, and with a mark for whoever is
 * not.
 *
 * Hung off the same `onAgents` that pushes a snapshot, because it is the same
 * event — anything about any agent changed — and a second subscription would
 * only be a second thing to keep in step. That is also why nothing in here
 * pushes: `onAgents` calls this and then pushes, so a mark set on this pass is
 * already in the snapshot that pass sends.
 *
 * It walks every profile's terminals and not just the active one's: an agent
 * blocked in the profile you left is the notification most worth having, since
 * it is the one there is no dot on screen for.
 *
 * The card and the mark share this loop deliberately. They are the same
 * judgement — *this wants a human* — asked of two different audiences, and
 * deciding them apart is how a dot ends up lit for reasons no notification
 * would ever have fired on. What differs is only the audience: `announce` runs
 * the gate per client and is throttled, because interrupting somebody twice is
 * worse than not at all; the mark is for the client that was not there to be
 * interrupted, so it is neither throttled nor per client.
 */
export function noticeStatuses(): void {
  const live = new Set<string>();
  for (const agent of host.agents) {
    live.add(agent.id);
    // Level-triggered on purpose, unlike everything below: a board compares
    // against the state it recorded, so a server restart that forgot
    // `lastStatus` still catches a run up. A no-op when nothing moved.
    workspaces.noteRun(agent.id, agent.status, agent.exited);
    const before = lastStatus.get(agent.id);
    lastStatus.set(agent.id, agent.status);
    // Never seen before, or has not moved. See `lastStatus` for why those are
    // two cases and not one.
    if (before === undefined || before === agent.status) continue;
    // Any edge is something happening, which an idle card's clock starts again on.
    sleeper.status(agent.id, agent.status);
    if (agent.exited) continue;
    // The harness hears every edge a person would; `reapExited` tells it the exits.
    harness.noticed(agent, agent.status, false);
    if (!isNotifyEvent(agent.status)) {
      // It has stopped wanting anybody — it was typed into, or it went back to
      // work — so the dot has nothing left to be about. `forget` covers the
      // terminal going away; this covers the terminal carrying on.
      unread.delete(agent.id);
      continue;
    }
    // Nobody saw it happen, so leave something that says it did. Checked at the
    // moment of the transition and never again: walking in on a terminal that
    // was already `done` before you left is not news, which is the same reason
    // `announce` fires on the edge rather than on the state.
    if (!onScreenAnywhere(agent.id)) unread.add(agent.id);
    announce(agent, agent.status);
  }
  for (const id of [...lastStatus.keys()]) {
    if (live.has(id)) continue;
    lastStatus.delete(id);
    notifiedAt.delete(id);
  }
}

/**
 * Tell whoever should be told, and nobody else.
 *
 * The gate is run *per client* rather than once, because the one question it
 * asks that is not a setting — is this terminal on screen — has a different
 * answer for the desktop showing the pane and the phone in your pocket. Which is
 * exactly the shape `unread` already has, and for the same reason: `watching` is
 * what a human can see, and a warm pooled emulator is nobody looking.
 *
 * The throttle is recorded only if something actually went out. A burst of
 * transitions while you are staring at the pane is not a notification and must
 * not spend the quiet period a real one four seconds later would need.
 */
function announce(agent: AgentSnapshot, event: NotifyEvent): void {
  const now = Date.now();
  if (now - (notifiedAt.get(agent.id) ?? 0) < NOTIFY_THROTTLE_MS) return;

  /**
   * The overlaid snapshot, not the host's. `activity` is what the agent said it
   * was doing — the permission prompt's own words, when a Claude Code hook is
   * installed — and it is the single most useful line a card can carry. It is
   * merged on this side, so the un-overlaid agent would notify with the title
   * and lose it.
   */
  const full = overlay(agent);
  const place = workspaces.placeOf(agent.id);
  /**
   * `agentLabel` answers `starting…` for a terminal opened as an agent whose
   * program the process scan has not named yet, and that is right where it is
   * used: a sidebar row corrects itself two seconds later, when the scan lands.
   * A card does not. It is drawn once and keeps what it was handed, so
   * `starting… needs input` would sit in Notification Center saying nothing for
   * the rest of the afternoon — and it is reachable, because a report can arrive
   * before the first scan and because `procs.ts` does not recognise every agent
   * anybody runs. The command is the better answer here for the reason the
   * placeholder is the better answer there: it is the one name a terminal has
   * that never stops being true.
   */
  const label = full.agent || full.titleOverride ? agentLabel(full) : basename(full.command);
  const text = notifyText({
    label,
    summary: agentSummary(full),
    workspace: place?.workspace,
    // Only when there is more than one profile to be in. With one, naming it on
    // every card is a word that never varies and therefore never informs —
    // ghosttown's rule about its session name, and the same one `labels.ts`
    // applies to a summary that is merely the label again.
    profile: workspaces.all().length > 1 ? place?.profile : undefined,
    event,
  });
  const notification = { agentId: agent.id, event, ...text };

  const isHarness = harness.isHarness(agent.id) !== null;
  let sent = false;
  for (const [ws, st] of clients) {
    // The parent's window is told by the parent's own gate, off what the
    // watch relays (`nodenotice.ts`); a watch is not a window to raise a card on.
    if (st.watcher) continue;
    const verdict = notifyGate(
      { event, visible: st.watching.has(agent.id), isAgent: countsAsAgent(full), isHarness },
      notify,
    );
    if (!verdict.pass) continue;
    send(ws, { type: "notify", notification });
    sent = true;
  }
  if (sent) notifiedAt.set(agent.id, now);
}
