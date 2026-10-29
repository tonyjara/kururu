/**
 * The cards popped out as notes, floating over the window: dragged by the
 * title bar, resized from any edge or corner, folded to the bar, closed.
 *
 * It exists because a card is what the work is read from, and the board it
 * is on goes away the moment the person turns to the agent it is about —
 * see `notes.ts`, which holds where each note is and why it is kept on this
 * device. Here is only the drawing of them, and the gestures.
 *
 * **The card is the snapshot's, drawn again, never a copy.** A note looks
 * its card up by id in the active profile on every render (`locateCard`),
 * so an edit from the board, from Kuru or from an agent's run is in the
 * note on the next message, the run line is the same live dot the board
 * draws, and a card sent from the profile's board to a workspace keeps its
 * note. The body is rendered markdown, by the server (`/api/card-markdown`),
 * for the reader's reason: the phone is sent markup, not a parser.
 *
 * **Editing is the board's own composer.** The same fields and keys a
 * double-click on the card opens — Enter saves the title, ⌘/ctrl+Enter the
 * body, Escape cancels — through the same verbs, so a note never becomes a
 * second editor with its own idea of what a card is.
 *
 * **Over the profile's sheet, under every other sheet.** The layer is the
 * scrims' height and is drawn after the profile's board and before Settings,
 * the databases and a dialog (`App.tsx`), so equal heights fall to document
 * order: a card popped out of the profile's board is in front of it at once,
 * and a question kururu asks is never under a note. Inside the layer each
 * note's height is its place in the stack, so a click brings one forward
 * without moving any element in the document — a node moved mid-press loses
 * the pointer it captured and the field it had focused.
 *
 * **The keyboard stays where it was.** A press on a note's bar or buttons
 * takes no focus, as in the drawers, so a terminal being typed into is still
 * being typed into after a note is moved; the editor says it has the keys
 * (`onEditing`) while a field in it is focused, as Kuru's composer does.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { boardLanes, canResume, cardCode, COLUMN_LABELS, NEEDS_COLUMN, type BoardColumn, type Card } from "../../../shared/board";
import { mascotFor, type AgentSnapshot, type MascotSet, type Profile, type Workspace } from "../../../shared/model";
import { colorValue } from "../colors";
import { drawDiagrams } from "../mermaid";
import {
  change,
  EDGES,
  fitNote,
  locateCard,
  moveBox,
  notesProfile,
  raise,
  resizeBox,
  updateNotes,
  useNotes,
  windowRoom,
  type Box,
  type Edge,
  type Note,
  type Room,
} from "../notes";
import * as api from "../session";
import { CardWhen, Composer, dropDraft, endedAgo, RunLine, showCardNext, TreeLine } from "./Board";
import { Icon } from "./Icon";
import { MadeLinks } from "./MadeLinks";
import { NeedsByMark } from "./ProfileBoard";
import { Status } from "./Status";

const EDGE_NAMES: Record<Edge, string> = {
  n: "top edge",
  s: "bottom edge",
  e: "right edge",
  w: "left edge",
  ne: "top right corner",
  nw: "top left corner",
  se: "bottom right corner",
  sw: "bottom left corner",
};

export function Notes({
  profile,
  agents,
  mascots,
  onEditing,
  onProfileCard,
}: {
  profile: Profile;
  agents: AgentSnapshot[];
  mascots: MascotSet;
  /** A note's editor has the keyboard, so the prefix and the panes must leave it alone. */
  onEditing: (editing: boolean) => void;
  /** Show a card of the profile's own board on its sheet, lit — the way back from its note to the board. */
  onProfileCard: (cardId: string) => void;
}) {
  const notes = useNotes(profile.key);
  // So a card's menu, which knows its board and not whose it is, pops the
  // note out for the profile on screen.
  useEffect(() => {
    notesProfile(profile.key);
    return () => notesProfile(null);
  }, [profile.key]);
  const room = useRoom();
  const open = notes.filter((note) => note.open);
  if (open.length === 0) return null;
  // Drawn in one fixed order and stacked by `z-index`, so that bringing one
  // forward moves nothing in the document — see the header.
  const drawn = [...open].sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  return (
    <div className="notes">
      {drawn.map((note) => (
        <NoteView
          key={note.cardId}
          note={note}
          stack={open.indexOf(note) + 1}
          front={open[open.length - 1] === note}
          room={room}
          profile={profile}
          agents={agents}
          mascots={mascots}
          onEditing={onEditing}
          onProfileCard={onProfileCard}
        />
      ))}
    </div>
  );
}

/**
 * The window's size, followed. Once a frame at most while a window is being
 * dragged wider, since every note is fitted into it on each.
 */
function useRoom(): Room {
  const [room, setRoom] = useState(windowRoom);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRoom(windowRoom()));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, []);
  return room;
}

/** A drag in progress: which pointer, where it went down, the box as drawn then, and which handle — null for the title bar. */
interface Gesture {
  pointer: number;
  x: number;
  y: number;
  start: Box;
  edge: Edge | null;
}

function NoteView({
  note,
  stack,
  front,
  room,
  profile,
  agents,
  mascots,
  onEditing,
  onProfileCard,
}: {
  note: Note;
  /** Its place in the stack, from 1 at the back. */
  stack: number;
  front: boolean;
  room: Room;
  profile: Profile;
  agents: AgentSnapshot[];
  mascots: MascotSet;
  onEditing: (editing: boolean) => void;
  onProfileCard: (cardId: string) => void;
}) {
  const update = (fn: (note: Note) => Note) => updateNotes(profile.key, (notes) => change(notes, note.cardId, fn));
  const close = () => {
    dropDraft(draftKey(note.cardId));
    update((was) => ({ ...was, open: false }));
  };
  const fold = () => update((was) => ({ ...was, collapsed: !was.collapsed }));

  /**
   * The box while a drag is under way, drawn without writing anything; the
   * store is written once, when the pointer comes up. Held in a ref beside
   * the state because the pointer's last event and its release can arrive
   * before the render that would have put the last box in state.
   */
  const [live, setLive] = useState<Box | null>(null);
  const latest = useRef<Box | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const box = live ?? fitNote(note, room, note.collapsed);

  const begin = (edge: Edge | null) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // A press on one of the bar's buttons is that button's.
    if (edge === null && (event.target as Element).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: fitNote(note, room, note.collapsed),
      edge,
    };
  };
  const follow = (event: React.PointerEvent<HTMLElement>) => {
    const now = gesture.current;
    if (!now || now.pointer !== event.pointerId) return;
    const dx = event.clientX - now.x;
    const dy = event.clientY - now.y;
    const next = now.edge ? resizeBox(now.start, now.edge, dx, dy, room) : moveBox(now.start, dx, dy, room, note.collapsed);
    latest.current = next;
    setLive(next);
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    const now = gesture.current;
    if (!now || now.pointer !== event.pointerId) return;
    gesture.current = null;
    const next = latest.current;
    latest.current = null;
    setLive(null);
    if (next) update((was) => ({ ...was, ...next }));
  };
  const drag = { onPointerMove: follow, onPointerUp: end, onPointerCancel: end };

  const located = locateCard(profile, note.cardId);
  const [editing, setEditing] = useState(false);
  const stopEditing = () => {
    dropDraft(draftKey(note.cardId));
    setEditing(false);
    onEditing(false);
  };
  // An editor taken away with the keyboard in it — the note closed, the card
  // gone — must not leave the prefix believing a field still has the keys.
  useEffect(() => {
    if (!editing) return;
    return () => onEditing(false);
  }, [editing, onEditing]);
  const card = located?.card ?? null;
  const workspace = located?.workspace ?? null;
  const gone = card === null;
  useEffect(() => {
    if (gone) setEditing(false);
  }, [gone]);

  const lane = card && !workspace ? boardLanes(profile.board).find((one) => one.id === card.column) : undefined;
  const tag = lane?.color ? colorValue(lane.color) : null;
  const agent = card?.run?.agentId ? agents.find((a) => a.id === card.run?.agentId) : undefined;
  const mascot = mascotFor(mascots, workspace?.mascotId ?? null);
  const code = card ? cardCode(workspace ? workspace.name : profile.name, card.number) : "";

  /** The card on its board: a workspace's in its pane, the profile's on its sheet — lit there, as a search hit is. */
  const showOnBoard = () => {
    if (!card) return;
    if (workspace) {
      showCardNext(workspace.id, card.id);
      api.openBoard(undefined, false, workspace.id);
    } else onProfileCard(card.id);
  };

  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  const style = {
    left: box.x,
    top: box.y,
    width: box.w,
    ...(note.collapsed ? {} : { height: box.h }),
    zIndex: stack,
    ...(tag ? { "--tag": tag } : {}),
  } as React.CSSProperties;

  return (
    <section
      className={[
        "note",
        note.collapsed ? "note-shut" : "",
        front ? "note-front" : "",
        live ? "note-moving" : "",
        tag ? "note-tagged" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      role="dialog"
      aria-label={card ? `Note: ${card.title}` : "Note"}
      data-note={note.cardId}
      onPointerDownCapture={() => updateNotes(profile.key, (notes) => raise(notes, note.cardId))}
    >
      <header
        className="note-head"
        onPointerDown={begin(null)}
        {...drag}
        onMouseDown={keepFocus}
        onDoubleClick={(event) => {
          if (!(event.target as Element).closest("button")) fold();
        }}
        title="Drag to move · double-click to fold"
      >
        {card ? (
          <>
            {agent && <Status agent={agent} mascot={mascot} />}
            <span className="note-code">{code}</span>
            <span className="note-title">{card.title}</span>
          </>
        ) : (
          <span className="note-title note-title-gone">Card gone</span>
        )}
        <span className="note-actions">
          {card && !note.collapsed && !editing && (
            <button className="board-icon-btn" title="Edit this card" aria-label="Edit" onClick={() => setEditing(true)}>
              <Icon name="edit" />
            </button>
          )}
          {card && (
            <button
              className="board-icon-btn"
              title={workspace ? `Show it on ${workspace.name}'s board` : "Show it on your board"}
              aria-label="Show on its board"
              onClick={showOnBoard}
            >
              <Icon name="board" />
            </button>
          )}
          <button
            className="board-icon-btn"
            title={note.collapsed ? "Unfold" : "Fold to the title bar"}
            aria-label={note.collapsed ? "Unfold" : "Fold"}
            aria-expanded={!note.collapsed}
            onClick={fold}
          >
            <Icon name={note.collapsed ? "unfold" : "fold"} />
          </button>
          <button className="board-icon-btn" title="Close the note — the card stays on its board" aria-label="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </span>
      </header>

      {!note.collapsed &&
        (card ? (
          <>
            <div className="note-meta">
              {lane ? (
                <>
                  <span className="board-col-dot" aria-hidden="true" />
                  <span>{lane.name}</span>
                </>
              ) : (
                <span>{COLUMN_LABELS[card.column as BoardColumn] ?? card.column}</span>
              )}
              <span className="note-where">· {workspace ? workspace.name : "your board"}</span>
              {card.column === NEEDS_COLUMN && card.needsBy && <NeedsByMark by={card.needsBy} />}
              {card.dates && <CardWhen dates={card.dates} />}
            </div>
            {editing ? (
              <div
                className="note-body note-editing"
                onFocus={() => onEditing(true)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onEditing(false);
                }}
              >
                <NoteEditor card={card} workspace={workspace} profile={profile} onDone={stopEditing} />
              </div>
            ) : (
              <NoteBody card={card} onEdit={() => setEditing(true)} />
            )}
            <NoteFoot card={card} workspace={workspace} agent={agent} mascot={mascot} agents={agents} />
          </>
        ) : (
          <div className="note-body">
            <p className="note-empty">
              This card is no longer on any board in {profile.name} — deleted, or moved with its workspace to another
              machine. The note can go.
            </p>
          </div>
        ))}

      {!note.collapsed &&
        EDGES.map((edge) => (
          <span
            key={edge}
            className={`note-edge note-edge-${edge}`}
            aria-hidden="true"
            title={`Resize from the ${EDGE_NAMES[edge]}`}
            onPointerDown={begin(edge)}
            {...drag}
            onMouseDown={keepFocus}
          />
        ))}
    </section>
  );
}

/** Where a note's editor keeps its half-typed text in `Board.tsx`'s drafts, apart from the board's own editor of the same card. */
function draftKey(cardId: string): string {
  return `note\0${cardId}`;
}

/**
 * The card's body as the server rendered it, refetched whenever its text
 * changes. The last render stays while the next is in flight, as the
 * reader's does: an edit is nearly the same text, and a blank between the
 * two would be a flash on every save. A card with no body says so, and the
 * saying is the way to write one.
 */
function NoteBody({ card, onEdit }: { card: Card; onEdit: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!card.body.trim()) {
      setHtml(null);
      setError(null);
      return;
    }
    const abort = new AbortController();
    void fetch(`/api/card-markdown?${new URLSearchParams({ card: card.id })}`, { signal: abort.signal })
      .then((response) => response.json())
      .then((answer: { html?: string; error?: string }) => {
        if (abort.signal.aborted) return;
        if (typeof answer.html === "string") {
          setHtml(answer.html);
          setError(null);
        } else setError(answer.error ?? "could not draw this card");
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("could not draw this card");
      });
    return () => abort.abort();
  }, [card.id, card.body]);
  // Mermaid fences come back as source and are laid out here, as in the reader.
  useLayoutEffect(() => {
    const node = article.current;
    if (!node || !html) return;
    const abort = new AbortController();
    void drawDiagrams(node, abort.signal);
    return () => abort.abort();
  }, [html]);

  if (!card.body.trim()) {
    return (
      <div className="note-body">
        <button type="button" className="note-empty note-empty-btn" onClick={onEdit}>
          No details yet — write some
        </button>
      </div>
    );
  }
  return (
    <div className="note-body" onDoubleClick={onEdit}>
      {html === null ? (
        // The text as it is, until its markup arrives — or for good, if it cannot.
        <p className="note-plain">{card.body}</p>
      ) : (
        <article ref={article} className="md note-md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {error && html === null && <p className="note-error">{error}</p>}
    </div>
  );
}

/**
 * The card's own editor, in the note: the board's composer with the fields
 * the board would offer — dates on a card that has them or on the profile's
 * board, which has the timeline; the worktree box on a workspace's card that
 * has no worktree yet.
 */
function NoteEditor({
  card,
  workspace,
  profile,
  onDone,
}: {
  card: Card;
  workspace: Workspace | null;
  profile: Profile;
  onDone: () => void;
}) {
  return (
    <Composer
      draft={draftKey(card.id)}
      title={card.title}
      body={card.body}
      isolate={card.isolate}
      offerIsolate={workspace !== null && !card.worktree}
      dates={card.dates}
      offerDates={workspace === null || card.dates !== null}
      bodyHint={workspace ? undefined : "Details"}
      fill
      submit="Save"
      onSubmit={(title, body, isolate, dates) => {
        if (workspace) api.editCard(workspace.id, card.id, { title, body, isolate, ...(card.dates ? { dates } : {}) });
        else api.editProfileCard(profile.id, card.id, { title, body, dates });
        onDone();
      }}
      onCancel={onDone}
    />
  );
}

/**
 * Under the body: the branch, the run and what its agent made — the lines
 * the board draws under the card, with the same components, so "open" goes
 * to the same terminal and "resume" wakes the same conversation.
 */
function NoteFoot({
  card,
  workspace,
  agent,
  mascot,
  agents,
}: {
  card: Card;
  workspace: Workspace | null;
  agent: AgentSnapshot | undefined;
  mascot: ReturnType<typeof mascotFor>;
  agents: AgentSnapshot[];
}) {
  const [error, setError] = useState<string | null>(null);
  if (!card.worktree && !card.run && !card.made?.length && !error) return null;
  const open = card.run?.agentId != null && agents.some((a) => a.id === card.run?.agentId && !a.exited);
  const resume =
    workspace && canResume(card.run, open)
      ? () => {
          setError(null);
          api.resumeCard(workspace.id, card.id).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }
      : undefined;
  return (
    <div className="note-foot">
      {card.worktree && <TreeLine worktree={card.worktree} />}
      {card.run && (
        <RunLine
          run={card.run}
          agent={agent}
          mascot={mascot}
          ended={endedAgo(card.run)}
          onReveal={(agentId) => api.revealAgent(agentId)}
          onResume={resume}
        />
      )}
      {card.made?.length ? <MadeLinks className="board-made" files={card.made} workspaceId={workspace?.id ?? null} /> : null}
      {error && <p className="board-card-error">{error}</p>}
    </div>
  );
}
