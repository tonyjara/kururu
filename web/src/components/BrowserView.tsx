/**
 * A browser tab's body: its chrome, and the box its page is laid over.
 *
 * The page is not in here. It is a native view the main process owns and
 * pools by tab id (`desktop/browser.js`), placed over the empty `browser-stub`
 * below and moved — never rebuilt — when the tab goes to another pane or
 * another workspace. What this component does is say where that box is,
 * whether the tab is on screen, and what the chrome's buttons pressed; and
 * swap the page for a still of itself while one of kururu's own overlays is
 * over it (`overlays.ts`), since a native view is drawn above the whole of
 * the window's DOM and would otherwise cover the menu that was opened on it.
 *
 * Everywhere without the bridge — the phone, a browser, another node's
 * window — the tab is a placeholder: its title, its address, and where it is
 * open, because the layout is shared and the page is not.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { browserLabel, browserUrl } from "../../../shared/browser";
import type { WebTabState } from "../../../shared/layout";
import { useBrowserState } from "../browser";
import { desktop, type BrowserBox, type BrowserDownload, type DesktopBrowser } from "../desktop";
import { watchCover } from "../overlays";
import * as api from "../session";
import { Icon } from "./Icon";

/** How often a still is taken again while the page is covered, so a page that moves under a menu does not freeze. */
const STILL_MS = 1000;
/** How often the box is read again, for a pane that moved without changing size (the sidebar opening beside it). */
const PLACE_MS = 300;

/** Asked of a tab's address field from outside it: ⌘L in its page, or a fresh empty tab. */
export const FOCUS_ADDRESS = "kururu-browser-address";

export function BrowserView({
  tabId,
  page,
  remoteName,
}: {
  tabId: string;
  page: WebTabState;
  /** The node whose window the page is in, for a browser tab of another node's workspace. */
  remoteName: string | null;
}) {
  const bridge = desktop()?.browser ?? null;
  if (!bridge || remoteName !== null) return <BrowserAway page={page} where={remoteName} />;
  return <LiveBrowser bridge={bridge} tabId={tabId} page={page} />;
}

/** The phone's, a browser's, and another node's tab: what it is, and where it is open. */
function BrowserAway({ page, where }: { page: WebTabState; where: string | null }) {
  return (
    <div className="browser-away">
      <span className="browser-away-title">{browserLabel(page)}</span>
      <span className="browser-away-url">{page.url}</span>
      <span className="browser-away-note">
        {where ? `Open in kururu on ${where}: the page is drawn in that computer's window.` : "Open on the Mac: the page is drawn in kururu's window there."}
      </span>
    </div>
  );
}

function boxOf(el: HTMLElement): BrowserBox {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function sameBox(a: BrowserBox | null, b: BrowserBox): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function LiveBrowser({ bridge, tabId, page }: { bridge: DesktopBrowser; tabId: string; page: WebTabState }) {
  const live = useBrowserState(tabId);
  const stubRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [covered, setCovered] = useState(false);
  const coveredRef = useRef(false);
  const [still, setStill] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const placed = useRef<BrowserBox | null>(null);
  // The address the page was opened at, for its first show; what the tab says
  // afterwards is a report of where it went, and showing it again must not
  // send the page back there.
  const urlRef = useRef(page.url);
  urlRef.current = page.url;

  // Off the screen when this tab stops being the one drawn: another tab
  // selected, the pane closed, the workspace switched. The page is kept.
  useEffect(() => () => bridge.hide(tabId), [bridge, tabId]);

  // On the screen whenever it is not covered, and again for every navigation
  // asked for — main loads `url` when `nav` is past the one it last loaded.
  useEffect(() => {
    const stub = stubRef.current;
    if (covered || !stub) return;
    let gone = false;
    const box = boxOf(stub);
    placed.current = box;
    void bridge.show(tabId, urlRef.current, page.nav, box).then(() => {
      // The still goes a frame after the page is back, so there is no frame
      // of nothing between them.
      if (!gone) requestAnimationFrame(() => !coveredRef.current && setStill(null));
    });
    return () => {
      gone = true;
    };
  }, [bridge, tabId, page.nav, covered]);

  // Covered by something of kururu's: a still, then the page hidden under it.
  useEffect(() => {
    const stub = stubRef.current;
    if (!stub) return;
    return watchCover(stub, (now) => {
      coveredRef.current = now;
      if (now) {
        void bridge.still(tabId).then((picture) => {
          if (!coveredRef.current) return;
          if (picture) setStill(picture);
          requestAnimationFrame(() => coveredRef.current && bridge.hide(tabId));
        });
      }
      setCovered(now);
    });
  }, [bridge, tabId]);

  // A covered page can still be moving — a video, a build's overlay — so its still is taken again.
  useEffect(() => {
    if (!covered) return;
    const timer = setInterval(() => {
      void bridge.still(tabId).then((picture) => picture && coveredRef.current && setStill(picture));
    }, STILL_MS);
    return () => clearInterval(timer);
  }, [bridge, tabId, covered]);

  // Where the box is: on a resize, on the window's, and on a slow beat for a
  // box that moved without changing size.
  useEffect(() => {
    const stub = stubRef.current;
    if (!stub) return;
    const place = () => {
      if (coveredRef.current) return;
      const box = boxOf(stub);
      if (sameBox(placed.current, box)) return;
      placed.current = box;
      bridge.place(tabId, box);
    };
    const observer = new ResizeObserver(place);
    observer.observe(stub);
    window.addEventListener("resize", place);
    const beat = setInterval(place, PLACE_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      clearInterval(beat);
    };
  }, [bridge, tabId]);

  // ⌘L in the page, or an empty tab just opened: the address field.
  useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tabId) return;
      addressRef.current?.focus();
      addressRef.current?.select();
    };
    window.addEventListener(FOCUS_ADDRESS, focus);
    return () => window.removeEventListener(FOCUS_ADDRESS, focus);
  }, [tabId]);
  useEffect(() => {
    if (page.url === "about:blank" && page.nav === 0) addressRef.current?.focus();
  }, [tabId, page.url, page.nav]);

  const go = (event: FormEvent) => {
    event.preventDefault();
    const url = browserUrl(typed ?? "");
    if (!url) {
      setRefused("Not an address: http and https only.");
      return;
    }
    setRefused(null);
    setTyped(null);
    api.navigateBrowser(tabId, url);
    bridge.go(tabId, "focus");
  };

  const shown = live?.url && live.url !== "" ? live.url : page.url;
  const loading = live?.loading === true;
  const zoom = live?.zoom ?? 1;
  const downloads = live?.downloads ?? [];
  const error = refused ?? live?.error ?? null;

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="browser-btn browser-back" disabled={!live?.canBack} onClick={() => bridge.go(tabId, "back")} title="Back (⌘[)" aria-label="Back">
          <Icon name="caret" />
        </button>
        <button className="browser-btn browser-forward" disabled={!live?.canForward} onClick={() => bridge.go(tabId, "forward")} title="Forward (⌘])" aria-label="Forward">
          <Icon name="caret" />
        </button>
        {loading ? (
          <button className="browser-btn" onClick={() => bridge.go(tabId, "stop")} title="Stop loading" aria-label="Stop loading">
            <Icon name="close" />
          </button>
        ) : (
          <button className="browser-btn" onClick={() => bridge.go(tabId, "reload")} title="Reload (⌘R)" aria-label="Reload">
            <Icon name="restart" />
          </button>
        )}
        <form className="browser-form" onSubmit={go}>
          <input
            ref={addressRef}
            className={`browser-address ${loading ? "browser-address-loading" : ""}`}
            value={typed ?? (shown === "about:blank" ? "" : shown)}
            placeholder="Type an address — localhost:3000, example.com"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
              setRefused(null);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setTyped((value) => (value === null || value === shown ? null : value))}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setTyped(null);
              setRefused(null);
              bridge.go(tabId, "focus");
            }}
            aria-label="Address"
          />
        </form>
        {zoom !== 1 && (
          <button className="browser-zoom" onClick={() => bridge.go(tabId, "zoom-reset")} title="Back to 100% (⌘0)">
            {Math.round(zoom * 100)}%
          </button>
        )}
        <button className="browser-btn" onClick={() => bridge.go(tabId, "devtools")} title="Open DevTools for this page" aria-label="DevTools">
          <Icon name="code" />
        </button>
        <button className="browser-btn" onClick={() => bridge.go(tabId, "external")} title="Open this page in your default browser" aria-label="Open in your browser">
          <Icon name="external" />
        </button>
      </div>
      {error && <div className="browser-error">{error}</div>}
      {downloads.map((download) => (
        <DownloadLine key={download.id} download={download} onReveal={() => bridge.go(tabId, "reveal", download.id)} onDismiss={() => bridge.go(tabId, "dismiss", download.id)} />
      ))}
      <div
        ref={stubRef}
        className="browser-stub"
        style={still ? { backgroundImage: `url(${still})` } : undefined}
        // A click that lands here is one on the still, with the page hidden
        // under an overlay; it is the overlay's to close, not the page's.
        aria-hidden="true"
      />
    </div>
  );
}

/** One download: its name, how far, and the way to it. A browser's line, not a download manager. */
function DownloadLine({ download, onReveal, onDismiss }: { download: BrowserDownload; onReveal: () => void; onDismiss: () => void }) {
  const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
  const how =
    download.state === "progressing"
      ? download.total > 0
        ? `${Math.floor((download.received / download.total) * 100)}% of ${size(download.total)}`
        : size(download.received)
      : download.state === "completed"
        ? `${size(download.received)} · in Downloads`
        : download.state === "cancelled"
          ? "cancelled"
          : "stopped";
  return (
    <div className="browser-download">
      <span className="browser-download-name">{download.name}</span>
      <span className="browser-download-how">{how}</span>
      {download.state === "completed" && (
        <button className="browser-download-btn" onClick={onReveal}>
          Show in Finder
        </button>
      )}
      {download.state !== "progressing" && (
        <button className="browser-download-btn" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
