import type { View } from "../App";

interface Props {
  view: View;
  onView: (view: View) => void;
  onMenu: () => void;
  sidebarOpen: boolean;
  session: string;
  online: boolean;
}

/** Sidebar on the left, code/preview on the right — the two toggles in the sketch. */
export function TopBar({ view, onView, onMenu, sidebarOpen, session, online }: Props) {
  return (
    <header className="topbar">
      <button
        className="icon-btn"
        onClick={onMenu}
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        aria-expanded={sidebarOpen}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <div className="topbar-title">
        <span className={`dot ${online ? "dot-on" : "dot-off"}`} aria-hidden="true" />
        <span className="session">{session}</span>
      </div>

      <div className="segmented" role="group" aria-label="View">
        <button
          className={view === "code" ? "seg seg-on" : "seg"}
          onClick={() => onView("code")}
          aria-pressed={view === "code"}
        >
          Code
        </button>
        <button
          className={view === "preview" ? "seg seg-on" : "seg"}
          onClick={() => onView("preview")}
          aria-pressed={view === "preview"}
        >
          Preview
        </button>
      </div>
    </header>
  );
}
