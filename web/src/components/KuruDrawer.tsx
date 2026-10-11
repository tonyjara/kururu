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
 * the full text; a heard one shows nothing else, an unheard one says so with a
 * Play of its own, the one being said says Speaking with Stop, and a line said
 * mid-turn through the `say` tool is drawn smaller. A live row at the foot
 * says what Kuru is doing now, and a composer under it types to Kuru through
 * the same outbox a clip goes through — so the phone talks to Kuru today,
 * since playback works over plain http and only the microphone needs the
 * secure context.
 *
 * **A panel over the panes, not a column.** A column would resize every pty
 * on open and close; a drawer costs nothing and the terminals stay readable,
 * which matters because you read Kuru's answer while watching the agent it
 * talks about. It does not dim them for the same reason. A click outside
 * closes it and lands where you clicked. On a narrow window it is a
 * full-screen sheet with the usual close button, one sheet at a time, like
 * the board and the databases.
 *
 * **Unheard means neither heard nor seen.** A reply stops counting when it is
 * played to its end, or when it has been in view in the open drawer for
 * `KURU_SEEN_MS`. The count's job is to bring you here; once you are here it
 * has done it, and a count that survived reading would teach you to ignore
 * it. "Mark all heard" stays for when you will not scroll, and Play says them
 * aloud as before.
 *
 * What it draws is the server's `kuru` message (`shared/kuru.ts`), already
 * merged: nothing in here decides what a message's state is or whether a
 * reply was heard. What it adds is this page's own two states for a clip the
 * server does not have yet — recording, and saving — from the voice module.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cardCode } from "../../../shared/board";
import { KURU_SEEN_MS, clipLength, splitCardCodes, type KuruConversation, type KuruItem, type KuruReply, type YouItem } from "../../../shared/kuru";
import type { AgentSnapshot, MascotConfig, Profile } from "../../../shared/model";
import type { OutboxState } from "../../../shared/voice";
import { kuruLive, type KuruLive } from "../kuru";
import * as api from "../session";
import { useKururu } from "../session";
import { dismissVoice, talkDown, talkUp, useOutgoing, useVoiceUi, voiceIsRemote } from "../voice";
import { Icon } from "./Icon";
import { Mascot } from "./Status";
import { MicIcon, SpeakerIcon } from "./VoiceIcons";

/** How close to the foot the list has to be for a new item to keep it there. Reading something older must not be yanked away. */
const STICK_PX = 48;
/** How long a reply just scrolled to stays marked, so the eye finds it. */
const FOCUS_MS = 1800;
/** Seen reports are gathered for a moment so a screenful read at once is one message. */
const SEEN_BATCH_MS = 300;

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
  onEditing,
  onCard,
  onTerminal,
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
  /** The composer has the keyboard, so the prefix and the panes must leave it alone. */
  onEditing: (editing: boolean) => void;
  /** A card named in a reply was clicked: the profile board, at that card. */
  onCard: (workspaceId: string | null, cardId: string) => void;
  /** Take me to Kuru's terminal — started, resumed or revealed. */
  onTerminal: () => void;
}) {
  const { kuru } = useKururu();
  const conversation = kuru.find((c) => c.profileId === profile.id) ?? null;
  const outgoing = useOutgoing();
  const ui = useVoiceUi();
  const live = kuruLive(profile, agents, conversation, ui.phase === "speaking");
  const list = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);

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
  }, [items.length, live, outgoing.length, ui.phase]);
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
   * A click outside closes the drawer and lands where it was aimed — no
   * scrim, since the terminals behind are the point. The chip is the one
   * exception: it toggles the drawer itself, and closing here first would
   * reopen it. Capture phase, so a terminal's own handler taking the press
   * cannot keep the drawer up.
   */
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (sheet) return;
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

  // This page's own clips, before the server has them, and the one being recorded.
  const saving = outgoing.filter((clip) => clip.profileId === profile.id && !known.has(clip.id));
  const recording = ui.phase === "listening" && !voiceIsRemote();
  const count = conversation?.unheard ?? 0;

  return (
    <aside className={`kuru-drawer ${sheet ? "kuru-sheet" : ""}`} ref={root} role="dialog" aria-label="Kuru">
      <header className="kuru-head">
        <span className="kuru-head-mark" aria-hidden="true">
          {live === "thinking" ? (
            <span className="status status-working">
              <Mascot config={mascot} clip={mascot.working} />
            </span>
          ) : live === "speaking" ? (
            <SpeakerIcon />
          ) : (
            <span className={`kuru-dot kuru-dot-${live}`} />
          )}
        </span>
        <h2 className="dialog-title">Kuru</h2>
        <span className={`kuru-head-state kuru-head-state-${live}`} role="status">
          {liveWord(live)}
        </span>
        <span className="kuru-head-spacer" />
        {count > 0 && (
          <button className="kuru-head-btn" onClick={() => api.playMissed(profile.id)} title="Say every unheard reply again, oldest first">
            <Icon name="play" />
            <span>Play unheard ({count})</span>
          </button>
        )}
        {count > 0 && (
          <button className="kuru-head-btn" onClick={() => api.clearMissed(profile.id)} title="Take every unheard reply off the count without hearing it">
            Mark all heard
          </button>
        )}
        <button className="kuru-head-btn" onClick={onTerminal} title={live === "off" ? "Start Kuru's session, in a terminal beside the board" : "Go to Kuru's terminal (C-a a opens this drawer)"}>
          Terminal
        </button>
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
          ) : (
            <Reply key={item.id} item={item} marked={marked === item.utterance} profileId={profile.id} cardOf={cardOf} onCard={onCard} />
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
        {live !== "quiet" && live !== "speaking" && (
          <li className={`kuru-live kuru-live-${live}`} role="status">
            {live === "thinking" && (
              <>
                <span className="status status-working">
                  <Mascot config={mascot} clip={mascot.working} />
                </span>
                <span>thinking…</span>
              </>
            )}
            {live === "asking" && (
              <>
                <span className="kuru-dot kuru-dot-asking" />
                <span>asking something in its terminal</span>
                <button className="kuru-head-btn" onClick={onTerminal}>
                  Open terminal
                </button>
              </>
            )}
            {live === "off" && (
              <>
                <span className="kuru-dot kuru-dot-off" />
                <span>not running</span>
                <button className="kuru-head-btn" onClick={onTerminal}>
                  Start
                </button>
              </>
            )}
          </li>
        )}
      </ol>

      <Composer profileId={profile.id} onEditing={onEditing} talking={ui.phase === "listening"} />
    </aside>
  );
}

/** One of your messages. The state is passed beside the item so this page's `saving` can wear the row the server's states do. */
function You({ item, state, note }: { item: YouItem; state: RowState; note: string | null }) {
  const word = state === "queued" ? (item.typedAt !== null ? "Sent" : STATE_WORD.queued) : STATE_WORD[state];
  return (
    <li className={`kuru-item kuru-you kuru-you-${state}`}>
      <span className="kuru-meta">
        {item.via === "voice" ? <MicIcon /> : <KeysIcon />}
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

/** One of Kuru's replies, with its fate beside it and a door onto every card it names. */
function Reply({
  item,
  marked,
  profileId,
  cardOf,
  onCard,
}: {
  item: KuruReply;
  marked: boolean;
  profileId: string;
  cardOf: (code: string) => { workspaceId: string | null; cardId: string } | null;
  onCard: (workspaceId: string | null, cardId: string) => void;
}) {
  return (
    <li
      className={`kuru-item kuru-reply ${item.aside ? "kuru-aside" : ""} ${item.fate ? `kuru-fate-${item.fate}` : ""} ${marked ? "kuru-marked" : ""}`}
      data-utterance={item.utterance ?? undefined}
    >
      <span className="kuru-meta">
        <SpeakerIcon />
        <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
        {item.fate === "unheard" && <span className="kuru-state kuru-state-unheard">Unheard</span>}
        {item.fate === "speaking" && <span className="kuru-state kuru-state-speaking">Speaking</span>}
      </span>
      <p className="kuru-text">
        {splitCardCodes(item.text).map((part, i) => {
          if ("text" in part) return part.text;
          const card = cardOf(part.code);
          return card ? (
            <button key={i} className="kuru-card" onClick={() => onCard(card.workspaceId, card.cardId)} title="Open the board at this card">
              {part.code}
            </button>
          ) : (
            part.code
          );
        })}
      </p>
      {item.fate === "unheard" && item.utterance && (
        <span className="kuru-actions">
          <button className="kuru-head-btn" onClick={() => api.kuruReplay(profileId, item.utterance!)} title="Say this reply again">
            <Icon name="play" />
            <span>Play</span>
          </button>
        </span>
      )}
      {item.fate === "speaking" && (
        <span className="kuru-actions">
          <button className="kuru-head-btn" onClick={dismissVoice} title="Stop Kuru">
            Stop
          </button>
        </span>
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
 * box has agreed; Escape gives the keyboard back to the panes. The mic beside
 * it is the status bar's: held, it records; tapped, it toggles. What is typed
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
    </form>
  );
}

function liveWord(live: KuruLive): string {
  switch (live) {
    case "off":
      return "off";
    case "thinking":
      return "thinking";
    case "asking":
      return "asking";
    case "speaking":
      return "speaking";
    default:
      return "";
  }
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
