import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSnapshot, ContextUsage } from "../../../shared/ghosttown";
import { sendText, useKururu } from "../session";

interface Props {
  agents: AgentSnapshot[];
  surfaceId: string | null;
  onSelect: (surfaceId: string) => void;
}

/**
 * Heights the panel settles on. The smallest still shows the tab strip, so
 * "collapsed" never means "I cannot see which agents exist" — the strip is how
 * you notice one has gone from working to blocked.
 */
const PEEK = 46;
function snapPoints(): number[] {
  const h = window.innerHeight;
  return [PEEK, Math.round(h * 0.45), Math.round(h * 0.8)];
}

export function AgentPanel({ agents, surfaceId, onSelect }: Props) {
  const { screens, daemon } = useKururu();
  const [height, setHeight] = useState(() => Math.round(window.innerHeight * 0.45));
  const [draft, setDraft] = useState("");
  const dragging = useRef<{ startY: number; startHeight: number } | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  const screen = surfaceId ? (screens[surfaceId] ?? "") : "";

  // A terminal is read from the bottom: new output is at the end.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [screen]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = { startY: event.clientY, startHeight: height };
    },
    [height],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    const next = drag.startHeight - (event.clientY - drag.startY);
    setHeight(Math.max(PEEK, Math.min(window.innerHeight * 0.9, next)));
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = null;
    // Settle on the nearest snap point rather than wherever the finger stopped.
    setHeight((current) =>
      snapPoints().reduce((best, point) =>
        Math.abs(point - current) < Math.abs(best - current) ? point : best,
      ),
    );
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || !surfaceId) return;
      setDraft("");
      // A trailing newline is what makes it a submitted turn rather than a
      // line sitting in the agent's prompt waiting for one.
      void sendText(surfaceId, text + "\n").catch(() => setDraft(text));
    },
    [draft, surfaceId],
  );

  const expanded = height > PEEK + 20;

  return (
    <section className="agent-panel" style={{ height }}>
      <div
        className="grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="separator"
        aria-label="Resize agent panel"
      >
        <span className="grip-bar" />
      </div>

      <div className="tabs" role="tablist">
        {agents.length === 0 && (
          <span className="tabs-empty">{daemon ? "No agents yet" : "Daemon offline"}</span>
        )}
        {agents.map((agent) => (
          <button
            key={agent.surfaceId}
            role="tab"
            aria-selected={agent.surfaceId === surfaceId}
            className={`tab ${agent.surfaceId === surfaceId ? "tab-on" : ""}`}
            onClick={() => onSelect(agent.surfaceId)}
          >
            <span className={`status status-${agent.status}`} aria-hidden="true" />
            <span className="tab-label">{agent.agent ?? agent.title}</span>
            {agent.unread && <span className="unread" aria-label="unread" />}
            {agent.contextUsage && <ContextRing usage={agent.contextUsage} />}
          </button>
        ))}
      </div>

      {expanded && (
        <>
          <pre className="agent-screen" ref={bodyRef}>
            {screen || (surfaceId ? "…" : "Select an agent")}
          </pre>
          <form className="agent-input" onSubmit={submit}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={surfaceId ? "Say something to this agent…" : "No agent selected"}
              disabled={!surfaceId}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="submit" disabled={!surfaceId || !draft.trim()}>
              Send
            </button>
          </form>
        </>
      )}
    </section>
  );
}

/** How full the window is, as a ring. The number matters less than the trend. */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const percent = Math.min(100, Math.round((usage.used / usage.window) * 100));
  const circumference = 2 * Math.PI * 5;
  return (
    <svg className="ring" width="14" height="14" viewBox="0 0 14 14" aria-label={`${percent}% of context used`}>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <circle
        cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2"
        strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
        transform="rotate(-90 7 7)"
        strokeLinecap="round"
      />
    </svg>
  );
}
