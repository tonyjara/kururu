/**
 * A browser tab's marks, as kururu draws them: the tray under the page, and
 * the comment's popover over it.
 *
 * The marks are made in the page (`desktop/markscript.js`) and held in main
 * (`desktop/marks.js`); what is here is everything a person writes, which is
 * why it is kururu's own DOM and not the page's. The **popover** opens at a
 * new pin, and over it the page is a still of itself — the popover is an
 * overlay like any other, so `overlays.ts` swaps the view out from under it —
 * so the page holds still while the comment is written, and the words never
 * pass through the page's process. The **tray** is a strip under the tab,
 * never under the page: the tools, a row per mark with its comment, and
 * Send, which puts the set into Kuru's box unsent, one line per mark, the
 * way a quote goes in.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { markLabel } from "../../../shared/marks";
import type { BrowserMarkSummary, BrowserMarking, DesktopBrowser } from "../desktop";
import { insertInKuru } from "../kuru";
import * as api from "../session";
import { dictate, dictateCancel, dictateStop, useDictation } from "../voice";
import { ChipField, type ChipFieldHandle } from "./ChipField";
import { Icon } from "./Icon";
import { GoMark, SayMark } from "./Quote";

const NO_FILES: readonly string[] = [];
/** Room between the pin and its popover, and between the popover and the window's edge. */
const POP_GAP = 10;

type Opened = { n: number; left: number; top: number; fresh: boolean };

/** What the tray's row and the popover call a mark. */
function labelOf(mark: BrowserMarkSummary): string {
  return markLabel(mark);
}

export function MarkTray({
  bridge,
  tabId,
  marking,
  stub,
  onCommenting,
}: {
  bridge: DesktopBrowser;
  tabId: string;
  marking: BrowserMarking;
  stub: RefObject<HTMLDivElement | null>;
  /** The popover is up: the still under it is to stay as it is. */
  onCommenting: (open: boolean) => void;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const mark = bridge.mark;
  const marks = marking.marks;

  // A pick in the page: its popover, at its pin.
  useEffect(() => {
    if (!bridge.onMarkMade) return;
    return bridge.onMarkMade((id, n, at) => {
      if (id !== tabId) return;
      const box = stub.current?.getBoundingClientRect();
      setOpened({ n, left: (box?.left ?? 0) + at.x, top: (box?.top ?? 0) + at.y, fresh: true });
    });
  }, [bridge, tabId, stub]);

  useEffect(() => onCommenting(opened !== null), [opened, onCommenting]);

  // A mark the popover was for that is gone — sent, cleared, dropped from the page's side.
  useEffect(() => {
    if (opened && !marks.some((m) => m.n === opened.n)) setOpened(null);
  }, [marks, opened]);

  if (!mark) return null;
  const on = marking.on;
  const tool = (name: "element" | "region" | "pen", shape?: "free" | "arrow" | "ellipse") => void mark(tabId, "tool", name, shape ?? marking.shape);
  const toolClass = (name: string) => `mark-tool ${on && marking.tool === name ? "mark-tool-on" : ""}`;

  const send = async () => {
    if (sending || marks.length === 0) return;
    setSending(true);
    setFailed(null);
    try {
      const body = (await mark(tabId, "bundle")) as { error?: unknown } | null;
      if (!body || typeof body !== "object") throw new Error("The page did not answer.");
      if (typeof body.error === "string") throw new Error(body.error);
      const kept = await api.sendMarks(body);
      insertInKuru(kept.lines.join("\n"), true);
      await mark(tabId, "clear");
    } catch (err) {
      setFailed(`Not sent: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  const close = (backToPage: boolean) => {
    setOpened(null);
    if (backToPage && on) void mark(tabId, "focus");
  };

  const openedMark = opened ? marks.find((m) => m.n === opened.n) ?? null : null;

  return (
    <div className="mark-tray">
      <div className="mark-tools" role="toolbar" aria-label="Marking">
        <button className={toolClass("element")} onClick={() => tool("element")} title="Click an element to mark it; shift-click to gather several into one mark; ↑ and ↓ walk to its parent and back">
          Element
        </button>
        <button className={toolClass("region")} onClick={() => tool("region")} title="Drag a box over an area">
          Area
        </button>
        <button className={toolClass("pen")} onClick={() => tool("pen")} title="Draw on the page">
          Pen
        </button>
        {on && marking.tool === "pen" && (
          <span className="mark-shapes">
            {(["free", "arrow", "ellipse"] as const).map((shape) => (
              <button key={shape} className={`mark-shape ${marking.shape === shape ? "mark-tool-on" : ""}`} onClick={() => tool("pen", shape)}>
                {shape === "free" ? "Free" : shape === "arrow" ? "Arrow" : "Circle"}
              </button>
            ))}
          </span>
        )}
        <button
          className={`mark-tool ${marking.holding ? "mark-tool-on" : ""}`}
          onClick={() => void mark(tabId, "hold")}
          title="Hold the hover state of what is under the pointer, for a menu CSS opens on hover (⌘⇧H in the page)"
          aria-pressed={marking.holding}
        >
          Hold hover
        </button>
        <button className="mark-tool" onClick={() => void mark(tabId, "selection")} title="Mark the text selected on the page (⌘⇧M in the page, with a selection)">
          Mark selection
        </button>
        <span className="mark-spacer" />
        <span className="mark-count">
          {marks.length}/{marking.max}
        </span>
        <button className="mark-tool" disabled={marks.length === 0 && !on} onClick={() => void mark(tabId, "clear")} title="Take every mark off this page">
          Clear
        </button>
        <button
          className="mark-send"
          disabled={marks.length === 0 || sending}
          onClick={() => void send()}
          title="Put these marks into Kuru's box, unsent. Each one's picture, and the page as it is now, go to Kuru's model with the message."
        >
          {sending ? "Sending…" : "Send to Kuru"}
        </button>
      </div>
      {(marking.note || failed) && <div className="mark-note">{failed ?? marking.note}</div>}
      {marks.length > 0 && (
        <ol className="mark-list">
          {marks.map((m) => (
            <li key={m.n} className="mark-row">
              <button
                className="mark-row-open"
                onClick={(event) => {
                  const r = event.currentTarget.getBoundingClientRect();
                  setOpened({ n: m.n, left: r.left + 24, top: r.top, fresh: false });
                }}
                title="Write or change this mark's comment"
              >
                <span className={`mark-num ${m.lost ? "mark-num-lost" : ""}`}>{m.n}</span>
                <span className="mark-label">{labelOf(m)}</span>
                {m.lost && <span className="mark-lost">not on the page now</span>}
                <span className={m.comment ? "mark-comment" : "mark-comment mark-comment-none"}>{m.comment || "add a comment"}</span>
              </button>
              <button className="mark-row-drop" onClick={() => void mark(tabId, "drop", m.n)} title="Remove this mark" aria-label={`Remove mark ${m.n}`}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {opened && openedMark && (
        <MarkComment
          key={`${opened.n}-${opened.left}-${opened.top}`}
          bridge={bridge}
          tabId={tabId}
          mark={openedMark}
          place={opened}
          onKeep={(text) => {
            void mark(tabId, "comment", opened.n, text);
            close(true);
          }}
          onDrop={() => {
            void mark(tabId, "drop", opened.n);
            close(true);
          }}
          onClose={() => close(true)}
        />
      )}
    </div>
  );
}

/**
 * The comment on one mark: what it is, its crop, and the field — the box's
 * own `ChipField` with the quote popover's hold-to-dictate mic. Enter keeps
 * it; Esc drops a mark just made (it was a pick the user did not mean) and
 * only closes one opened from the tray.
 */
function MarkComment({
  bridge,
  tabId,
  mark,
  place,
  onKeep,
  onDrop,
  onClose,
}: {
  bridge: DesktopBrowser;
  tabId: string;
  mark: BrowserMarkSummary;
  place: Opened;
  onKeep: (text: string) => void;
  onDrop: () => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(mark.comment);
  const [crop, setCrop] = useState<string | null>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<ChipFieldHandle>(null);
  const speaking = useRef(false);
  const commentNow = useRef(comment);
  commentNow.current = comment;
  const dictation = useDictation();

  useEffect(() => {
    if (!mark.hasCrop || !bridge.mark) return;
    let gone = false;
    void bridge.mark(tabId, "crop", mark.n).then((url) => !gone && typeof url === "string" && setCrop(url));
    return () => {
      gone = true;
    };
  }, [bridge, tabId, mark.n, mark.hasCrop]);

  // Beside the pin, kept inside the window, and above it when there is no room below.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      const left = Math.max(POP_GAP, Math.min(place.left + POP_GAP + 8, window.innerWidth - width - POP_GAP));
      const below = place.top - 12;
      const top = below + height <= window.innerHeight - POP_GAP ? Math.max(POP_GAP, below) : Math.max(POP_GAP, window.innerHeight - height - POP_GAP);
      setSpot((was) => (was && was.left === left && was.top === top ? was : { left, top }));
    };
    fit();
    const sized = new ResizeObserver(fit);
    sized.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      sized.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [place.left, place.top]);

  useEffect(() => {
    // A frame later, so the click that opened it from the tray is over.
    const id = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Esc before anything else of the window's hears it — the prefix, a drawer's close.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (speaking.current) {
        speaking.current = false;
        dictateCancel();
      }
      if (place.fresh && !commentNow.current.trim()) onDrop();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [place.fresh, onDrop, onClose]);

  useEffect(
    () => () => {
      if (speaking.current) dictateCancel();
    },
    [],
  );

  const speak = () => {
    if (speaking.current) return;
    setSaid(null);
    speaking.current = true;
    const stop = () => {
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      dictateStop();
    };
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    void dictate().then((outcome) => {
      if (!speaking.current) return;
      speaking.current = false;
      stop();
      if (outcome.ok) {
        onKeep([commentNow.current.trim(), outcome.text].filter(Boolean).join(" "));
        return;
      }
      if (outcome.why) setSaid(outcome.why);
      field.current?.focus();
    });
  };
  const phase = speaking.current ? dictation.phase : "idle";

  return createPortal(
    <div
      ref={box}
      className="mark-pop"
      role="dialog"
      aria-label={`Comment on mark ${mark.n}`}
      data-overlay="mark"
      style={spot ? { left: spot.left, top: spot.top } : { visibility: "hidden" }}
    >
      <div className="mark-pop-head">
        <span className="mark-num">{mark.n}</span>
        <span className="mark-pop-label">{labelOf(mark)}</span>
      </div>
      {crop && <img className="mark-pop-crop" src={crop} alt="" />}
      <div className="mark-pop-write">
        <ChipField
          ref={field}
          className="mark-pop-field"
          value={comment}
          files={NO_FILES}
          bold={null}
          placeholder="What about it? (Enter keeps it)"
          ariaLabel={`Your comment on mark ${mark.n}`}
          enterKeyHint="done"
          onChange={(next) => {
            setComment(next);
            if (said) setSaid(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!speaking.current) onKeep(comment);
            }
          }}
          onEnter={() => {
            if (!speaking.current) onKeep(comment);
          }}
        />
        <SayMark phase={phase} level={dictation.level} onPress={speak} />
        <button type="button" className="quote-pop-go" onMouseDown={(event) => event.preventDefault()} onClick={() => !speaking.current && onKeep(comment)} title="Keep this comment (Enter)" aria-label="Keep the comment">
          <GoMark />
        </button>
      </div>
      {(phase !== "idle" || said) && (
        <p className="mark-pop-say" role="status">
          {phase === "listening" ? "Listening… let go when you are done." : phase === "hearing" ? "Hearing…" : said}
        </p>
      )}
      <p className="mark-pop-hint">{place.fresh ? "Esc drops this mark." : "Esc closes; the comment stays as it was."}</p>
    </div>,
    document.body,
  );
}
