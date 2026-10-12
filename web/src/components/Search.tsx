/**
 * The search field over the profile's boards and conversations, and the
 * list of deleted cards behind it.
 *
 * It lives in the profile board's sheet because that is where every board
 * in the profile is already seen from, and "find the card about Y" is a
 * question about all of them. The answer comes from the server's database
 * (`/api/search`) — the window holds no index — and a card hit is a door:
 * clicking it hands the card back to the sheet by workspace and id, and the
 * sheet takes you to it — its own board for one of its cards, the
 * workspace's board in its pane for the rest. A turn hit opens the words
 * in place, since there is nowhere else they are drawn yet.
 *
 * The deleted list is the other half of "never lost": a card deleted by
 * hand is marked and kept, and this is where it comes back from.
 */
import { useEffect, useRef, useState } from "react";
import { CHANNEL_NAMES, isChannelKind } from "../../../shared/channels";
import { COLUMN_LABELS } from "../../../shared/board";
import type { SearchHit } from "../../../shared/store";
import * as api from "../session";

const TYPING_MS = 200;

export function BoardSearch({
  profileId,
  onPickCard,
}: {
  profileId: string;
  /** A card hit, clicked: its workspace, or null for the profile's own board, and the card. */
  onPickCard: (workspaceId: string | null, cardId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleted, setDeleted] = useState<api.DeletedCardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Asked a moment after the last keystroke, never on each: a search is a
  // request to the server and typing a word is six of them.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setHits(null);
      return;
    }
    timer.current = setTimeout(() => {
      api
        .search(profileId, query)
        .then((found) => {
          setHits(found);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, TYPING_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, profileId]);

  const loadDeleted = () => {
    api
      .deletedCards(profileId)
      .then(setDeleted)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const restore = (cardId: string) => {
    api
      .restoreCard(cardId)
      .then(loadDeleted)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="board-search">
      <div className="board-search-row">
        <input
          className="set-text board-search-field"
          type="search"
          value={query}
          placeholder="Search cards and conversations"
          aria-label="Search cards and conversations"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
        />
        <button
          className={`set-choice ${showDeleted ? "set-choice-on" : ""}`}
          onClick={() => {
            const next = !showDeleted;
            setShowDeleted(next);
            if (next) loadDeleted();
          }}
        >
          Deleted cards
        </button>
      </div>
      {error && <p className="set-warn">{error}</p>}
      {hits && (
        <ol className="search-hits" aria-label="Search results">
          {hits.length === 0 && <li className="search-none">Nothing matches.</li>}
          {hits.map((hit, i) =>
            hit.kind === "card" ? (
              <li key={`c${hit.id}`} className="search-hit">
                <button
                  className="search-hit-btn"
                  onClick={() => {
                    onPickCard(hit.workspaceId ?? null, hit.id);
                    setQuery("");
                  }}
                  title={hit.workspaceName ? `Go to this card on ${hit.workspaceName}'s board` : "Open this card"}
                >
                  <span className="search-hit-kind">card</span>
                  <span className="search-hit-title">
                    {hit.title}
                    {hit.deleted ? " (deleted)" : ""}
                  </span>
                  <span className="search-hit-where">
                    {hit.workspaceName ?? "profile board"} · {laneName(hit.column)}
                    {hit.movedAt ? ` · moved ${when(hit.movedAt)}` : ""}
                  </span>
                  <span className="search-hit-snip">{hit.snippet}</span>
                </button>
              </li>
            ) : (
              <li key={`t${hit.id}`} className="search-hit">
                <button className="search-hit-btn" onClick={() => setOpen(open === i ? null : i)} title="Show the whole turn">
                  <span className="search-hit-kind">{hit.role === "you" ? (hit.via === "voice" ? "you, spoken" : isChannelKind(hit.via) ? `you, on ${CHANNEL_NAMES[hit.via]}` : "you") : hit.role === "kuru" ? "Kuru" : "an agent"}</span>
                  <span className="search-hit-where">{when(hit.at)}</span>
                  <span className="search-hit-snip">{open === i ? hit.text : hit.snippet}</span>
                </button>
              </li>
            ),
          )}
        </ol>
      )}
      {showDeleted && deleted && (
        <ol className="search-hits" aria-label="Deleted cards">
          {deleted.length === 0 && <li className="search-none">No deleted cards.</li>}
          {deleted.map((card) => (
            <li key={card.id} className="search-hit search-hit-deleted">
              <span className="search-hit-title">{card.title}</span>
              <span className="search-hit-where">
                {card.workspaceName ?? "profile board"} · was in {laneName(card.column)} · deleted {when(card.deletedAt)}
              </span>
              <button className="set-choice" onClick={() => restore(card.id)}>
                Restore
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function laneName(column: string): string {
  return (COLUMN_LABELS as Record<string, string>)[column] ?? column;
}

function when(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString();
}
