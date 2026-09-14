import { useCallback, useEffect, useMemo, useState } from "react";
import { useKururu, watchScreen } from "./session";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Preview } from "./components/Preview";
import { CodeView } from "./components/CodeView";
import { AgentPanel } from "./components/AgentPanel";

export type View = "preview" | "code";
export interface OpenFile {
  root: string;
  path: string;
}

/**
 * The layout: a bar, one main slot that toggles between the preview and the
 * code, and an agent panel pinned to the bottom.
 *
 * The agent panel is a split, not a sheet. You talk to an agent *about* what is
 * on screen above it — "this wraps at 390px" — so covering the thing you are
 * describing would defeat the point. It resizes to three snap points instead,
 * and the smallest still shows the tab strip.
 */
export function App() {
  const { snapshot, devServers, connected, daemon } = useKururu();

  // Open by default where it is a column, closed where it is an overlay.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
  const [view, setView] = useState<View>("preview");
  const [surfaceId, setSurfaceId] = useState<string | null>(null);
  const [devPort, setDevPort] = useState<number | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);

  const agents = snapshot?.agents ?? [];

  // Follow the daemon when we have no choice of our own: first agent, or the
  // only dev server. Never override a choice the user has made.
  useEffect(() => {
    if (surfaceId && agents.some((a) => a.surfaceId === surfaceId)) return;
    setSurfaceId(agents[0]?.surfaceId ?? null);
  }, [agents, surfaceId]);

  useEffect(() => {
    if (devPort !== null && devServers.some((d) => d.port === devPort)) return;
    setDevPort(devServers[0]?.port ?? null);
  }, [devServers, devPort]);

  // The server only polls screens somebody is looking at.
  useEffect(() => {
    watchScreen(surfaceId);
  }, [surfaceId]);

  const dev = useMemo(
    () => devServers.find((d) => d.port === devPort) ?? null,
    [devServers, devPort],
  );

  const openFile = useCallback((next: OpenFile) => {
    setFile(next);
    setView("code");
    setSidebarOpen(false);
  }, []);

  return (
    <div className={sidebarOpen ? "app" : "app app-nosidebar"}>
      <TopBar
        view={view}
        onView={setView}
        onMenu={() => setSidebarOpen((open) => !open)}
        sidebarOpen={sidebarOpen}
        session={snapshot?.session ?? "—"}
        online={connected && daemon}
      />

      <main className="main">
        {/* Both stay mounted: reloading the preview iframe would lose whatever
            state the app under test is in, which is usually the thing you were
            looking at. Same reason ghosttown keeps its surfaces mounted. */}
        <div className="slot" hidden={view !== "preview"}>
          <Preview dev={dev} />
        </div>
        <div className="slot" hidden={view !== "code"}>
          <CodeView file={file} />
        </div>
      </main>

      <AgentPanel agents={agents} surfaceId={surfaceId} onSelect={setSurfaceId} />

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        devServers={devServers}
        devPort={devPort}
        onDevPort={(port) => {
          setDevPort(port);
          setView("preview");
          setSidebarOpen(false);
        }}
        onOpenFile={openFile}
      />
    </div>
  );
}
