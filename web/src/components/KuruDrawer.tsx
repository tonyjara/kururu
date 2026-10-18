/**
 * The conversation with Kuru, in the one place it has.
 *
 * It replaced a button with three facts on one glyph and a menu box asked to
 * hold prose. The bot button's ink said whether the session ran, its top
 * corner counted unheard replies, its bottom corner was a dot in three other
 * colours for your messages, and the button itself went somewhere else — the
 * terminal — while both corners opened a 340px popover with a scroll cap,
 * which is the wrong room for three paragraphs. Meanwhile the conversation had
 * no home: your spoken messages were on one list, your typed ones nowhere,
 * Kuru's replies existed while the pill said them and then only once missed,
 * and the rest was the terminal's scrollback.
 *
 * So: one timeline, oldest at the top, opened at the bottom. Your messages
 * carry a mic for a clip or nothing for a typed line, the time, the clip's
 * length, and one word in the status inks for where they are — Saving,
 * Hearing, Waiting for Kuru, Sent, Delivered, Failed — with Resend and
 * Discard inline on a failed one. Kuru's replies carry the speaker glyph and
 * the full text; the speaker is Play and Stop both, for any reply with words
 * to say again, and shows which it is — an unheard one also says so beside
 * it, the one audible right now says Speaking, and a line said mid-turn
 * through the `say` tool is drawn smaller. A live line over the composer
 * says what Kuru is doing now — thinking, with Stop beside it — and the
 * composer under it types to Kuru through the same outbox a clip goes
 * through — so the phone talks to Kuru today, since playback works over
 * plain http and only the microphone needs the secure context.
 *
 * **The live line stands outside the list, over the composer,** where it
 * was inside the list at its foot until 2026-10-18. At the foot it scrolled
 * away with everything else the moment you read up, which is when "is it
 * still going?" is asked; over the box it is always where the next message
 * is typed. Stop is the Escape a press in Kuru's terminal sends, through the
 * server (`Harness.interrupt`), which also puts the status right afterwards
 * — Claude Code tells no hook about a turn it was stopped in — so the line
 * goes when the turn has ended and not before. It leaves the composer alone:
 * a half-written message stays half-written.
 *
 * **Who spoke is a colour, and only two people speak.** Yours are on raised
 * chrome at the right, Kuru's on the terminals' ground at the left, and
 * nothing else wears either: kururu's notices that an agent finished or
 * blocked, and a background task reporting back, arrive in Kuru's session as
 * user turns, and were drawn as yours — most of "your" lines on a busy day,
 * so the two colours alternated and said nothing. They are a third kind now
 * (`readPrompt` in `shared/kuru.ts` decides, out of the database, wrappers
 * and all), drawn as one quiet line — who, which agent, what happened —
 * with the whole message behind a tap.
 *
 * **A column beside the panes, on the sidebar's terms.** It used to be a
 * panel floated over them, on the argument that a column resizes every pty
 * on open and close — which is true of a resize dragged frame by frame, and
 * not of one settled in `terminals.ts`'s usual 60ms, the same debounce a
 * sidebar toggle already rides. So it is a flex sibling of `.stage` now,
 * narrowing it the way the sidebar and the file tree do, and the terminals
 * resize once, at the end, instead of never. It does not dim them, because
 * you read Kuru's answer while watching the agent it talks about, and a
 * click into them — a terminal, a card — is just a click into the layout,
 * not a reason to close; only the close button, the chip, or the keyboard
 * does that. On a narrow window it is still a full-screen sheet over
 * everything, the usual close button, one sheet at a time like the board
 * and the databases — and there a click outside does close it, since
 * "outside" is still something else drawn above the sheet.
 *
 * **Unheard means neither heard nor seen.** A reply stops counting when it is
 * played to its end, or when it has been in view in the open drawer for
 * `KURU_SEEN_MS`. The count's job is to bring you here; once you are here it
 * has done it, and a count that survived reading would teach you to ignore
 * it. So nothing here clears the count by hand: a reply's own speaker says it
 * again, and asking Kuru what you missed has it call `play_missed` for all of
 * them. The header used to carry "Play unheard" and "Mark all heard" for
 * those two jobs, and they were two buttons nobody could say the use of.
 *
 * **The speaker in the header is Settings → Voice's "Speak replies"** — the
 * one setting, not a copy of it: read off the socket's `voice` and written
 * back whole through `setVoice`, so the two places cannot disagree. Muting
 * also stops a reply already audible here, because a mute that lets the
 * sentence finish reads as a mute that did not work.
 *
 * What it draws is the server's `kuru` message (`shared/kuru.ts`), already
 * merged: nothing in here decides what a message's state is or whether a
 * reply was heard. What it adds is this page's own two states for a clip the
 * server does not have yet — recording, and saving — from the voice module.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cardCode } from "../../../shared/board";
import { CHANNEL_NAMES, channelReady, isChannelKind, type TelegramStatus } from "../../../shared/channels";
import { KURU_SEEN_MS, clipLength, splitCardCodes, type KuruConversation, type KuruItem, type KuruReply, type NoticeItem, type YouItem } from "../../../shared/kuru";
import { splitMentions } from "../../../shared/made";
import type { AgentSnapshot, MascotConfig, Profile } from "../../../shared/model";
import type { OutboxState, VoiceSettings } from "../../../shared/voice";
import { kuruLive, kuruWorking, type KuruLive } from "../kuru";
import * as api from "../session";
import { useKururu } from "../session";
import { dismissVoice, talkDown, talkUp, useOutgoing, useVoiceUi, voiceIsRemote, voiceNow } from "../voice";
import { Icon } from "./Icon";
import { MadeInline } from "./MadeLinks";
import { Mascot } from "./Status";
import { MicIcon, PlaneIcon, SpeakerIcon, SpeakerOffIcon } from "./VoiceIcons";

/** How close to the foot the list has to be for a new item to keep it there. Reading something older must not be yanked away. */
const STICK_PX = 48;
/** How long a reply just scrolled to stays marked, so the eye finds it. */
const FOCUS_MS = 1800;
/** Seen reports are gathered for a moment so a screenful read at once is one message. */
const SEEN_BATCH_MS = 300;
/**
 * How long Stop stays "Stopping…" waiting for the turn to end. A little over
 * the server's own watch (`STOP_WATCH_MS` in `harness.ts`), after which a
 * turn still running is one the Escape did not reach, and Stop is offered
 * again.
 */
const STOPPING_MS = 5000;

/** One of your messages as the drawer draws it: the server's states, and this page's two for a clip the server has not taken yet. */
type RowState = OutboxState | "saving" | "recording";

/**
 * Words for the states worth a mark: a message still working its way
 * through, or one that failed and needs Resend. A delivered message is the
 * normal case and gets no mark — it got through, and saying so on every
 * line it ever occupies is noise once that is true far more often than not.
 */
const STATE_WORD: Partial<Record<RowState, string>> = {
  recording: "Recording",
  saving: "Saving",
  transcribing: "Hearing",
  queued: "Waiting for Kuru",
  failed: "Failed",
};

export function KuruDrawer({
  profile,
  agents,
  mascot,
  sheet,
  focus,
  asked,
  onClose,
  onResize,
  onResetWidth,
  onEditing,
  onCard,
  onTerminal,
  chips,
}: {
  profile: Profile;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
  /** A full-screen sheet on a narrow window, rather than a panel beside the panes. */
  sheet: boolean;
  /** The reply to open at — an utterance id — and a counter so the same ask twice scrolls twice. */
  focus: string | null;
  asked: number;
  onClose: () => void;
  /** A width proposed by the drawer's own grip — desktop only, see `Grip` below. */
  onResize: (px: number) => void;
  onResetWidth: () => void;
  /** The composer has the keyboard, so the prefix and the panes must leave it alone. */
  onEditing: (editing: boolean) => void;
  /** A card named in a reply was clicked: take me to it — the profile's sheet for one of its own, the workspace's board for the rest. */
  onCard: (workspaceId: string | null, cardId: string) => void;
  /** Take me to Kuru's terminal — started, resumed or revealed. */
  onTerminal: () => void;
  /**
   * The two drawers' chips, which lead this header while the drawer is open —
   * Kuru's lit, since it is this drawer, and the other the way across. See
   * `DrawerChips.tsx`.
   */
  chips: ReactNode;
}) {
  const { kuru, channels, voice } = useKururu();
  const conversation = kuru.find((c) => c.profileId === profile.id) ?? null;
  // The drawer is the active profile's, so Telegram is this conversation's
  // when it talks to whichever profile is active, or was pointed at this one.
  const telegram = channels?.telegram && channelReady(channels.telegram) && (channels.telegram.profileId ?? profile.id) === profile.id ? channels.telegram : null;
  const outgoing = useOutgoing();
  const ui = useVoiceUi();
  const live = kuruLive(profile, agents, conversation, ui.phase === "speaking");
  const working = kuruWorking(profile, agents);
  const list = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);

  /**
   * The speaker icon's own replay: which row asked to hear its reply again.
   * There is one player, so one id is enough. Set the moment it is asked
   * for, so a click shows the stop state at once rather than waiting out the
   * gap before the first sentence is ready; `started` keeps that optimism
   * from reading as "done" the instant it is set, and is what tells a replay
   * that reached the pill's phase from one that never did — the row clears
   * only once the player has actually left `speaking`, not before it got
   * there, whatever took it away: the reply ending, Escape, or another row's
   * click stopping it first.
   */
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const replayStarted = useRef(false);
  useEffect(() => {
    if (!replayingId) return;
    if (ui.phase === "speaking") {
      replayStarted.current = true;
      return;
    }
    if (replayStarted.current) {
      replayStarted.current = false;
      setReplayingId(null);
    }
  }, [ui.phase, replayingId]);

  /**
   * The speaker clicked, on any reply: stop whatever that row is doing if it
   * is the one audible right now — this row's own replay, or Kuru genuinely
   * saying it for the first time — through `dismissVoice`, the pill's ✕
   * itself, so a reply cut off here lands unheard exactly as it would from
   * there. Otherwise this reply was not playing, so anything else that was
   * is stopped first — one player, one row at a time — and this one is asked
   * for, with the words the drawer already has: a reply already heard has
   * left the missed list and kept no other copy of them.
   */
  const onReplay = useCallback(
    (item: KuruReply) => {
      if (!item.utterance) return;
      if (replayingId === item.id || item.fate === "speaking") {
        dismissVoice();
        if (replayingId === item.id) {
          replayStarted.current = false;
          setReplayingId(null);
        }
        return;
      }
      if (ui.phase === "speaking") dismissVoice();
      replayStarted.current = false;
      setReplayingId(item.id);
      api.kuruReplay(profile.id, item.utterance, item.text);
    },
    [profile.id, replayingId, ui.phase],
  );

  /**
   * Everything seen so far, by id, so items the socket's window has slid past
   * stay on screen and pages fetched from before it have somewhere to go. The
   * window is the truth for its own span: an item in it replaces the one here,
   * and one from inside its span that it no longer carries — a failed message
   * discarded — goes. A message that became a turn changes id on the way, so
   * the entry it was is dropped by the outbox id they share.
   */
  const [known, setKnown] = useState<Map<string, KuruItem>>(() => new Map());
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setKnown(new Map());
    setMore(false);
  }, [profile.id]);
  useEffect(() => {
    if (!conversation) return;
    const items = conversation.items;
    const since = items[0]?.at ?? Infinity;
    const linked = new Set(items.map((item) => (item.kind === "you" ? item.outboxId : null)).filter((id): id is string => id !== null));
    setKnown((prev) => {
      const next = new Map<string, KuruItem>();
      for (const [id, item] of prev) {
        if (item.at >= since) continue;
        if (item.kind === "you" && item.outboxId && linked.has(item.outboxId)) continue;
        next.set(id, item);
      }
      for (const item of items) next.set(item.id, item);
      return next;
    });
    setMore((was) => was || conversation.more);
  }, [conversation]);

  const items = [...known.values()].sort((a, b) => a.at - b.at);
  const first = items[0]?.at ?? null;

  const earlier = () => {
    if (loading) return;
    setLoading(true);
    api
      .fetchKuru(profile.id, first)
      .then((page) => {
        // Kept where the eye is: the list grows above, and the scroll
        // position is put back by the layout effect below.
        anchor.current = list.current ? { height: list.current.scrollHeight, top: list.current.scrollTop } : null;
        setKnown((prev) => {
          const next = new Map(prev);
          for (const item of page.items) if (!next.has(item.id)) next.set(item.id, item);
          return next;
        });
        setMore(page.more);
      })
      .catch(() => setMore(false))
      .finally(() => setLoading(false));
  };
  const anchor = useRef<{ height: number; top: number } | null>(null);

  /**
   * Where the list sits. Opened, it is at the foot, or at the reply the pill
   * was showing; after that it follows new items only while it was already
   * at the foot, and a page prepended keeps what was on screen on screen.
   */
  const [marked, setMarked] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (focus) {
      const row = el.querySelector<HTMLElement>(`[data-utterance="${CSS.escape(focus)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        setMarked(focus);
        const timer = setTimeout(() => setMarked(null), FOCUS_MS);
        return () => clearTimeout(timer);
      }
    }
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    return undefined;
  }, [asked, focus]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [items.length, live, working, outgoing.length, ui.phase]);
  const onScroll = () => {
    const el = list.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  /**
   * Seen: a reply in view for `KURU_SEEN_MS` while the page is visible stops
   * counting as unheard. Observed rather than assumed from the drawer being
   * open, because the whole point is that a glance at the drawer is not
   * reading the reply at the top of a long list.
   */
  const unheard = items.filter((item): item is KuruReply => item.kind === "kuru" && item.fate === "unheard" && item.utterance !== null).map((item) => item.utterance!);
  const unheardKey = unheard.join("\n");
  useEffect(() => {
    const el = list.current;
    if (!el || !unheard.length) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let pending: string[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      flush = null;
      if (pending.length) api.kuruSeen(profile.id, pending);
      pending = [];
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.utterance;
          if (!id) continue;
          const timer = timers.get(id);
          if (entry.isIntersecting && document.visibilityState === "visible") {
            if (timer) continue;
            timers.set(
              id,
              setTimeout(() => {
                timers.delete(id);
                observer.unobserve(entry.target);
                pending.push(id);
                flush ??= setTimeout(send, SEEN_BATCH_MS);
              }, KURU_SEEN_MS),
            );
          } else if (timer) {
            clearTimeout(timer);
            timers.delete(id);
          }
        }
      },
      { root: el, threshold: 0.6 },
    );
    for (const id of unheard) {
      const row = el.querySelector(`[data-utterance="${CSS.escape(id)}"]`);
      if (row) observer.observe(row);
    }
    return () => {
      observer.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
      if (flush) clearTimeout(flush);
      send();
    };
    // The ids are the dependency, as one string: a new unheard reply starts
    // watching, and a re-render that changed nothing about them does not.
  }, [unheardKey, profile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * On a phone the drawer is a sheet over the whole screen, so a click
   * outside only reaches something drawn above it — the chip, a menu, a
   * dialog — and still means "go there instead". On a desktop it narrows
   * `.stage` rather than covering it, so a click outside is just a click
   * into the layout (a terminal, a card) and must not close the drawer; only
   * its own close button, the chip, or the keyboard does. Capture phase, so
   * a terminal's own handler taking the press cannot keep the drawer up.
   */
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!sheet) return;
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (root.current?.contains(target) || target.closest(".sb-kuru, .voice-pill, .scrim, .menu-backdrop, .menu")) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [sheet, onClose]);

  /** A card code in a reply, resolved against the profile's boards. Not a card is not a link. */
  const cardOf = useCallback(
    (code: string): { workspaceId: string | null; cardId: string } | null => {
      for (const workspace of profile.workspaces) {
        if (!workspace.board) continue;
        const prefix = cardCode(workspace.name, 0).slice(0, -1);
        if (!prefix.endsWith("-") || !code.startsWith(prefix)) continue;
        const number = Number(code.slice(prefix.length));
        const card = workspace.board.cards.find((c) => c.number === number);
        if (card) return { workspaceId: workspace.id, cardId: card.id };
      }
      return null;
    },
    [profile.workspaces],
  );

  /**
   * A path in a reply was opened. On a phone the drawer is a sheet over the
   * pane the file just landed in, so it gets out of the way, as the file tree
   * does; on the desktop it stays, beside what it opened.
   */
  const onFile = useCallback(() => {
    if (sheet) onClose();
  }, [sheet, onClose]);

  // This page's own clips, before the server has them, and the one being recorded.
  const saving = outgoing.filter((clip) => clip.profileId === profile.id && !known.has(clip.id));
  const recording = ui.phase === "listening" && !voiceIsRemote();

  return (
    <aside className={`kuru-drawer ${sheet ? "kuru-sheet" : ""}`} ref={root} role="dialog" aria-label="Kuru">
      {/* The chips stand where the title was: Kuru's chip already says what
          the title and its state word did — the mark, the name, and "asking"
          or "off" — and a header carrying both would say Kuru twice. The
          Terminal button went on 2026-10-18; the terminal is still a press
          away from the live line over the composer while Kuru is asking or
          off, which is when it was ever wanted. */}
      <header className="kuru-head">
        {chips}
        <span className="kuru-head-spacer" />
        {voice && <SpeakSwitch settings={voice.settings} />}
        {telegram && <TelegramSwitch status={telegram} />}
        <button className="sidebar-close kuru-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>

      <ol className="kuru-list" ref={list} onScroll={onScroll}>
        {more && (
          <li className="kuru-earlier">
            <button className="kuru-head-btn" onClick={earlier} disabled={loading}>
              {loading ? "Loading…" : "Show earlier"}
            </button>
          </li>
        )}
        {items.map((item) =>
          item.kind === "session" ? (
            <li key={item.id} className="kuru-mark">
              <span>New conversation{item.launcher ? ` · ${item.launcher}` : ""}</span>
              <time dateTime={new Date(item.at).toISOString()}>{dayAt(item.at)}</time>
            </li>
          ) : item.kind === "you" ? (
            <You key={item.id} item={item} state={item.state} note={item.note} />
          ) : item.kind === "notice" ? (
            <Notice key={item.id} item={item} cardOf={cardOf} onCard={onCard} />
          ) : (
            <Reply
              key={item.id}
              item={item}
              // Not `marked === item.utterance` alone: with nothing marked that
              // is null === null for every reply never spoken, and each of them
              // wore the accent of the one just scrolled to, for good.
              marked={marked !== null && marked === item.utterance}
              replaying={replayingId === item.id}
              onReplay={onReplay}
              cardOf={cardOf}
              onCard={onCard}
              onFile={onFile}
            />
          ),
        )}
        {saving.map((clip) => (
          <You
            key={clip.id}
            item={{ kind: "you", id: clip.id, at: clip.at, text: null, via: "voice", ms: clip.ms, state: "queued", typedAt: null, note: null, outboxId: null }}
            state="saving"
            note={clip.error ? `Not with the server yet (${clip.error}). Kept on this device and sent again until it is.` : null}
          />
        ))}
        {recording && (
          <li className="kuru-item kuru-you kuru-you-recording">
            <span className="kuru-meta">
              <MicIcon />
              <span className="kuru-state kuru-state-recording">{STATE_WORD.recording}</span>
            </span>
          </li>
        )}
      </ol>

      <Live live={live} working={working} profileId={profile.id} mascot={mascot} onTerminal={onTerminal} />

      <Composer profileId={profile.id} onEditing={onEditing} talking={ui.phase === "listening"} />

      {/* The edge you drag, on the sidebar's and the tree's terms: last in the
          tree and absolutely positioned, so it sits over the border rather
          than taking a column of its own. Only where there is a column to
          resize — a phone's sheet has no edge beside the panes to grab. */}
      {!sheet && <Grip onResize={onResize} onReset={onResetWidth} />}
    </aside>
  );
}

/**
 * What Kuru is doing now, over the composer: thinking, with Stop; asking,
 * with the way to its terminal; not running, with Start. Nothing between
 * turns, since quiet is the ordinary state and a line saying so is noise, and
 * nothing while a reply is only being said, which the reply's own row shows.
 * Thinking is `working` rather than `live`'s word, so a line said mid-turn
 * does not take Stop away for as long as it is being said.
 *
 * Stop is pressed once: "Stopping…" until the turn ends, or until
 * `STOPPING_MS` says the Escape did not reach it — the server sends no
 * second one meanwhile, since two Escapes together are Claude Code's rewind.
 * It does not take the keyboard from the composer, so a message being
 * written goes on being written.
 */
function Live({ live, working, profileId, mascot, onTerminal }: { live: KuruLive; working: boolean; profileId: string; mascot: MascotConfig; onTerminal: () => void }) {
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!working) setStopping(false);
  }, [working]);
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOPPING_MS);
    return () => clearTimeout(timer);
  }, [stopping]);
  if (working) {
    return (
      <div className="kuru-live kuru-live-thinking" role="status">
        <span className="status status-working">
          <Mascot config={mascot} clip={mascot.working} />
        </span>
        <span className="kuru-live-word">{stopping ? "Stopping…" : "Thinking…"}</span>
        <button
          type="button"
          className="kuru-head-btn kuru-stop"
          disabled={stopping}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setStopping(true);
            api.kuruStop(profileId);
          }}
          title="Stop Kuru's turn, as Esc in its terminal would"
          aria-label="Stop Kuru"
        >
          <Icon name="stop" />
          <span>Stop</span>
        </button>
      </div>
    );
  }
  if (live === "asking") {
    return (
      <div className="kuru-live kuru-live-asking" role="status">
        <span className="kuru-dot kuru-dot-asking" />
        <span className="kuru-live-word">asking something in its terminal</span>
        <button className="kuru-head-btn" onClick={onTerminal}>
          Open terminal
        </button>
      </div>
    );
  }
  if (live === "off") {
    return (
      <div className="kuru-live kuru-live-off" role="status">
        <span className="kuru-dot kuru-dot-off" />
        <span className="kuru-live-word">not running</span>
        <button className="kuru-head-btn" onClick={onTerminal}>
          Start
        </button>
      </div>
    );
  }
  return null;
}

/**
 * The drawer's left edge, as something to take hold of — `FileTree.tsx`'s
 * `Grip` mirrored, because this column grows leftwards too, so its width is
 * measured from the right edge of the box rather than from the left. Shared
 * in spirit with `NeedsDrawer.tsx`'s copy of the same handle: the two drawers
 * never hold the slot at once, and `App.tsx` resizes both from one width.
 */
function Grip({ onResize, onReset }: { onResize: (px: number) => void; onReset: () => void }) {
  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    onResize(box.right - event.clientX);
  };
  const release = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return (
    <div
      className="kuru-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the drawer"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={onReset}
    />
  );
}

/**
 * Settings → Voice's "Speak replies", in the header of the conversation it
 * governs. The glyph is the state — the speaker while replies are read aloud,
 * the speaker struck through while they are only on screen — so the button
 * does not also wear the accent ink the Telegram switch wears when on: on is
 * this switch's ordinary position, and a colour worn all the time says
 * nothing. Its name stays the same both ways and `aria-pressed` says which,
 * as a toggle's should. Muting asks the voice client what it is doing at the
 * moment of the click — this page, or the pill when the pill is the mouth —
 * and stops a reply mid-sentence through `dismissVoice`, the ✕ itself, so it
 * lands unheard exactly as it would from there.
 */
function SpeakSwitch({ settings }: { settings: VoiceSettings }) {
  const on = settings.speak;
  return (
    <button
      type="button"
      className="kuru-head-btn kuru-head-icon"
      aria-pressed={on}
      aria-label="Speak the replies"
      title={on ? "Replies are read aloud. Click to mute them (Settings → Voice → Speak replies)" : "Replies are muted. Click to read them aloud (Settings → Voice → Speak replies)"}
      onClick={() => {
        if (on && voiceNow().phase === "speaking") dismissVoice();
        api.setVoice({ ...settings, speak: !on });
      }}
    >
      {on ? <SpeakerIcon /> : <SpeakerOffIcon />}
    </button>
  );
}

/**
 * The Telegram channel's switch, beside the speaker: the same switch as
 * Settings → Channels, here because the drawer is where you notice you are
 * leaving the Mac. Drawn only once the channel is set up — a token and an
 * account — since a switch that can only refuse is not a switch. Its ink
 * says on; a link that is failing says so in the warning ink and the title.
 * The plane alone since 2026-10-18, on the speaker's terms: the words "on"
 * and "off" were the widest thing in the header, the ink already says which,
 * and the title and `aria-pressed` say it in words.
 */
function TelegramSwitch({ status }: { status: TelegramStatus }) {
  const bot = status.bot ? `@${status.bot.username}` : "the bot";
  const title = status.error
    ? `Telegram: ${status.error}`
    : status.enabled
      ? `Kuru listens to Telegram: what you write to ${bot} comes here, and every reply also goes there. Click to turn it off.`
      : `Telegram is off. Click to let ${bot} reach Kuru, and send Kuru's replies there.`;
  return (
    <button
      className={`kuru-head-btn kuru-head-icon ${status.enabled ? (status.error ? "kuru-head-btn-warn" : "kuru-head-btn-on") : ""}`}
      aria-pressed={status.enabled}
      aria-label="Telegram"
      title={title}
      onClick={() => void api.setChannel("telegram", { enabled: !status.enabled }).catch(() => {})}
    >
      <PlaneIcon />
    </button>
  );
}

/** One of your messages. The state is passed beside the item so this page's `saving` can wear the row the server's states do. */
function You({ item, state, note }: { item: YouItem; state: RowState; note: string | null }) {
  const word = state === "queued" ? (item.typedAt !== null ? "Sent" : STATE_WORD.queued) : STATE_WORD[state];
  const channel = isChannelKind(item.via) ? item.via : null;
  return (
    <li className={`kuru-item kuru-you kuru-you-${state}`}>
      <span className="kuru-meta">
        {item.via === "voice" ? (
          <MicIcon />
        ) : channel ? (
          <span className="kuru-via" title={`From ${CHANNEL_NAMES[channel]}`}>
            <PlaneIcon />
            <span>{CHANNEL_NAMES[channel]}</span>
          </span>
        ) : (
          <KeysIcon />
        )}
        <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
        {item.via === "voice" && item.ms > 0 && <span className="kuru-length">{clipLength(item.ms)}</span>}
        {word && <span className={`kuru-state kuru-state-${state}`}>{word}</span>}
      </span>
      {item.text ? <p className="kuru-text">{item.text}</p> : <p className="kuru-text kuru-pending">Not in words yet — the audio is kept.</p>}
      {note && <p className="kuru-note">{note}</p>}
      {state === "failed" && item.outboxId && (
        <span className="kuru-actions">
          <button className="kuru-head-btn" onClick={() => api.resendVoice(item.outboxId!)}>
            {item.text ? "Resend" : "Listen again"}
          </button>
          <button className="kuru-head-btn" onClick={() => api.discardVoice(item.outboxId!)}>
            Discard
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * One of Kuru's replies, with its fate beside it and a door onto every card
 * it names. The speaker is the one control for Play and Stop both: it plays
 * this reply again while idle, and stops whatever is audible — this replay,
 * or Kuru saying it for the first time — while `active`.
 */
function Reply({
  item,
  marked,
  replaying,
  onReplay,
  cardOf,
  onCard,
  onFile,
}: {
  item: KuruReply;
  marked: boolean;
  replaying: boolean;
  onReplay: (item: KuruReply) => void;
  cardOf: CardOf;
  onCard: (workspaceId: string | null, cardId: string) => void;
  /** A path in the reply was opened. */
  onFile: () => void;
}) {
  const active = replaying || item.fate === "speaking";
  return (
    <li
      className={`kuru-item kuru-reply ${item.aside ? "kuru-aside" : ""} ${item.fate ? `kuru-fate-${item.fate}` : ""} ${marked ? "kuru-marked" : ""}`}
      data-utterance={item.utterance ?? undefined}
    >
      <span className="kuru-meta">
        {item.utterance ? (
          <button
            type="button"
            className={`kuru-speaker ${active ? "kuru-speaker-playing" : ""}`}
            onClick={() => onReplay(item)}
            title={active ? "Stop (Esc)" : "Play again"}
            aria-label={active ? "Stop" : "Play this reply again"}
            aria-pressed={active}
          >
            {active ? <Icon name="stop" /> : <SpeakerIcon />}
          </button>
        ) : (
          <SpeakerIcon />
        )}
        <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
        {active ? (
          <span className="kuru-state kuru-state-speaking">Speaking</span>
        ) : item.fate === "unheard" ? (
          <span className="kuru-state kuru-state-unheard">Unheard</span>
        ) : null}
      </span>
      <p className="kuru-text">
        {/* Paths first, each a link when the server found its file, then card codes in
            the words between: a path such as docs/KUR-12.md is a file, not a card. */}
        {(item.files?.length ? splitMentions(item.text) : [{ text: item.text }]).map((part, i) => {
          if ("mention" in part) {
            const file = item.files?.find((f) => f.text === part.mention.text);
            if (file) return <MadeInline key={i} file={file} label={part.mention.text} onOpened={onFile} />;
          }
          return <CardWords key={i} text={"mention" in part ? part.mention.text : part.text} cardOf={cardOf} onCard={onCard} />;
        })}
      </p>
    </li>
  );
}

type CardOf = (code: string) => { workspaceId: string | null; cardId: string } | null;

/** Words with every card code in them a door onto the board — one that is not a card stays a word. */
function CardWords({ text, cardOf, onCard }: { text: string; cardOf: CardOf; onCard: (workspaceId: string | null, cardId: string) => void }) {
  return (
    <>
      {splitCardCodes(text).map((bit, j) => {
        if ("text" in bit) return <Fragment key={j}>{bit.text}</Fragment>;
        const card = cardOf(bit.code);
        return card ? (
          <button key={j} className="kuru-card" onClick={() => onCard(card.workspaceId, card.cardId)} title="Open the board at this card">
            {bit.code}
          </button>
        ) : (
          <Fragment key={j}>{bit.code}</Fragment>
        );
      })}
    </>
  );
}

/**
 * Something Kuru was told that neither of you said — kururu's notice that an
 * agent finished or blocked, a background task reporting back — as one quiet
 * line rather than a bubble, since a bubble is a side of the conversation and
 * this is neither. The agent's name is what a narrow drawer cuts short, never
 * what happened to it; a blocked one says so in the blocked ink, because that
 * one may be waiting on you. A tap opens the whole message under the line —
 * the agent's reply, its card a door as it is in a reply — and closes it
 * again; nothing about it is unread or needs clearing, so it keeps no state
 * past this row's.
 */
function Notice({ item, cardOf, onCard }: { item: NoticeItem; cardOf: CardOf; onCard: (workspaceId: string | null, cardId: string) => void }) {
  const [open, setOpen] = useState(false);
  const agent = item.agent;
  return (
    <li className={`kuru-notice ${item.event === "blocked" ? "kuru-notice-blocked" : ""}`}>
      <button type="button" className="kuru-notice-line" aria-expanded={open} onClick={() => setOpen((was) => !was)} title={open ? "Hide the message" : "Show the whole message"}>
        <Icon name="caret" />
        <span className="kuru-notice-from">{item.from}</span>
        <span aria-hidden="true">·</span>
        {agent && <span className="kuru-notice-cut">{agent.name ? `"${agent.name}"` : agent.program}</span>}
        {agent?.workspace && <span className="kuru-notice-where">in {agent.workspace}</span>}
        <span className={`kuru-notice-what ${agent ? "" : "kuru-notice-cut"}`}>{item.what}</span>
        <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
      </button>
      {open && (
        <p className="kuru-notice-text">
          <CardWords text={item.text} cardOf={cardOf} onCard={onCard} />
        </p>
      )}
    </li>
  );
}

/** Where a draft not yet sent waits out a closed drawer, one profile at a time. */
const DRAFT_KEY = "kururu.kuru.draft:";

function readDraft(profileId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY + profileId) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(profileId: string, text: string) {
  try {
    if (text) localStorage.setItem(DRAFT_KEY + profileId, text);
    else localStorage.removeItem(DRAFT_KEY + profileId);
  } catch {
    // Not remembered past this window; the draft still sends.
  }
}

/**
 * Typing to Kuru. Enter sends and Shift+Enter is a new line, as every chat
 * box has agreed; Escape gives the keyboard back to the panes. The send and
 * the mic are inside the box, at its foot: the mic held records, tapped
 * toggles. What is typed
 * and not yet sent survives closing the drawer and reloading the page — a
 * thought half-written must not vanish because the drawer did — and the field
 * grows with it up to `.kuru-field`'s `max-height`, so writing more than one
 * line does not hide the lines above it.
 */
function Composer({ profileId, onEditing, talking }: { profileId: string; onEditing: (editing: boolean) => void; talking: boolean }) {
  const [text, setText] = useState(() => readDraft(profileId));
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText(readDraft(profileId));
  }, [profileId]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const send = () => {
    const words = text.trim();
    if (!words) return;
    api.kuruSay(profileId, words);
    setText("");
    writeDraft(profileId, "");
  };
  // Told once each way, and told off on unmount: a drawer closed with the
  // cursor still in the box must not leave the prefix believing a field has
  // the keyboard.
  useEffect(() => () => onEditing(false), [onEditing]);
  return (
    <form
      className="kuru-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="kuru-box">
        <textarea
          ref={field}
          className="kuru-field"
          rows={1}
          value={text}
          placeholder="Say something to Kuru"
          aria-label="A message for Kuru"
          onChange={(event) => {
            setText(event.target.value);
            writeDraft(profileId, event.target.value);
          }}
          onFocus={() => onEditing(true)}
          onBlur={() => onEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              field.current?.blur();
            }
          }}
        />
        <button type="submit" className="kuru-send" disabled={!text.trim()} title="Send (Enter)" aria-label="Send">
          <Icon name="run" />
        </button>
        <button
          type="button"
          className={`kuru-mic ${talking ? "kuru-mic-listening" : ""}`}
          onPointerDown={(event) => {
            event.preventDefault();
            talkDown();
          }}
          onPointerUp={talkUp}
          onPointerCancel={talkUp}
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          title="Hold to talk to Kuru, tap to toggle"
          aria-label="Talk to Kuru"
          aria-pressed={talking}
        >
          <MicIcon />
        </button>
      </div>
    </form>
  );
}

/** The time a thing was said: the clock today, and the day before that. */
function saidAt(at: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function dayAt(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A keyboard, for a message that was typed rather than spoken — the pair of
 * the mic, drawn here for `VoiceIcons.tsx`'s reason: a picture of a physical
 * object that means the same thing in any chrome.
 */
function KeysIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}
