/**
 * The window's three buttons, drawn by the page.
 *
 * The window has no title bar (`titleBarStyle` in `desktop/main.js`), and
 * until 2026-11-10 macOS floated its own close, minimise and zoom over the
 * top-left corner. Those are the system's to draw, and since macOS 26 it
 * draws them large and glassy for any app built against its SDK, which the
 * Electron kururu ships on is: nothing an app can ask for brings back the
 * small flat ones, and nothing moves them a pixel finer than
 * `trafficLightPosition` allows. The owner asked for small, flat, in the
 * plain three colours, standing level with the top of the logo beside them
 * (2026-11-10, beside Herdr, which gets the old ones by being linked against
 * an older SDK). So the main process hides the system's and these stand in
 * the same corner.
 *
 * One fixed mark over the corner rather than a part of the sidebar's top
 * line, because that is what the system's were: there whether the sidebar is
 * up, away, a phone-width sheet, or zen has taken the whole window, and above
 * a dialog's scrim, since a window with a question up can still be closed.
 * The layout keeps the same room for them it kept for the system's.
 *
 * Drawn only once the main process has been asked for the system's to be put
 * away (`frame.claim`), so a browser tab, the phone and an app built before
 * this draw nothing and the old app keeps the system's; and the system's come
 * back by themselves when this page goes, since the window may next show a
 * server whose page draws none. Not drawn in full screen, where the buttons
 * are in the title bar that slides down with the menu bar.
 *
 * Grey while the window is not the key one, as the system's are, and the
 * marks inside appear when the pointer is over the group: an × to close, a
 * − to minimise, and for the third the two arrows of full screen, or a + with
 * Option held, which fits the window to the screen instead.
 *
 * Three things the first build got wrong (2026-11-10, the owner: "clicking
 * close, minimise or zoom does nothing", and beside Herdr, "they were meant to
 * be smaller"):
 *
 * - **They are the last thing in the page.** Chromium collects the window's
 *   drag regions in the order of the tree, not of what is painted on top, and
 *   Electron lays them down in that order with the later one winning
 *   (`DraggableRegionsToSkRegion`). The buttons came first and the sidebar's
 *   top line — a drag region the width of the sidebar, the corner included —
 *   after, so every press on them was taken by the window as the start of a
 *   drag, whatever z-index drew them on top. `App.tsx` puts them after
 *   everything else for that reason alone.
 * - **They are sized in the screen's points, not the page's pixels.** The
 *   window's ⌘+ is the page's zoom, and the system's buttons do not grow with
 *   it: at 110% these were 13.2 points on a 22-point pitch beside Herdr's 12
 *   on 20. The group undoes the zoom with its inverse (`usePageZoom`, as the
 *   floating logo does), so the dots, the gap and the inset from the window's
 *   left edge are Herdr's whatever the zoom; only how far down they stand
 *   follows the zoom, because that is where the logo they stand level with is.
 * - **The first click acts while the window is behind**, as on the system's:
 *   the page says where they stand (`place`) and the main process gives that
 *   room alone the first click (`desktop/stay/stay.m`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktop, type FrameState } from "../desktop";
import { usePageZoom } from "../float";

const AT_REST: FrameState = { focused: true, fullscreen: false };

/**
 * Whether this window's buttons are the page's to draw, and what the main
 * process says of the window. `own` is false in a browser, on the phone, in
 * an app that has no such bridge, and wherever the claim is refused.
 *
 * `own` starts true wherever there is a bridge, before the claim is answered,
 * so the first paint keeps the right room; a refusal takes it back. The
 * system's buttons are given back when this unmounts, which is also what a
 * crash of the tree above it does (`Crash.tsx`): a window with a sentence on
 * it and no way to close it would be worse than the crash.
 */
export function useWindowFrame(): FrameState & { own: boolean } {
  const frame = desktop()?.frame;
  const [state, setState] = useState<FrameState>(AT_REST);
  const [own, setOwn] = useState(Boolean(frame));
  useEffect(() => {
    if (!frame) return;
    let live = true;
    void frame
      .claim()
      .then((now) => {
        if (!live) return;
        if (now) setState(now);
        else setOwn(false);
      })
      .catch(() => live && setOwn(false));
    const stop = frame.onState(setState);
    return () => {
      live = false;
      stop();
      frame.release();
    };
  }, [frame]);
  return { ...state, own };
}

/**
 * `layout` is whatever about the page moves the buttons — the sidebar away, a
 * phone-width window, zen — so the room is measured again when it changes,
 * and once more each time the window stops being the key one, which is when
 * a first click can next fall on them.
 */
export function WindowButtons({ frame, layout }: { frame: FrameState & { own: boolean }; layout: string }) {
  const [alt, setAlt] = useState(false);
  const zoom = usePageZoom();
  const group = useRef<HTMLDivElement>(null);
  // Option is read while it is held, not at the click alone, because the mark
  // in the green button says which of its two things a click will do.
  useEffect(() => {
    if (!frame.own) return;
    const key = (event: KeyboardEvent) => setAlt(event.altKey);
    const blur = () => setAlt(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
    };
  }, [frame.own]);

  const bridge = desktop()?.frame;
  const drawn = Boolean(frame.own && bridge && !frame.fullscreen);
  const sent = useRef("");
  useLayoutEffect(() => {
    if (!bridge?.place) return;
    const box = drawn ? group.current?.getBoundingClientRect() : undefined;
    const room = box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
    const said = JSON.stringify(room);
    if (said === sent.current) return;
    sent.current = said;
    bridge.place(room);
  }, [bridge, drawn, layout, zoom, frame.focused]);

  if (!drawn || !bridge) return null;
  return (
    <div
      ref={group}
      className={`win-btns ${frame.focused ? "" : "win-btns-away"}`}
      role="group"
      aria-label="Window"
      style={{ zoom: 1 / zoom, "--win-zoom": zoom } as React.CSSProperties}
      // Option pressed before the pointer came, or while another app had the keys.
      onPointerMove={(event) => setAlt(event.altKey)}
    >
      <button type="button" className="win-btn win-close" aria-label="Close the window" title="Close" onClick={() => bridge.act("close")}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8" />
        </svg>
      </button>
      <button type="button" className="win-btn win-min" aria-label="Minimise the window" title="Minimise" onClick={() => bridge.act("minimize")}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.8 6h6.4" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn win-zoom"
        aria-label={alt ? "Fit the window to the screen" : "Full screen"}
        title={alt ? "Zoom" : "Full screen (hold Option to zoom)"}
        onClick={(event) => bridge.act(event.altKey ? "zoom" : "fullscreen")}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {alt ? <path d="M6 2.9v6.2M2.9 6h6.2" /> : <path className="win-fill" d="M3.4 7.9V4.3c0-.5.4-.9.9-.9h3.6zM8.6 4.1v3.6c0 .5-.4.9-.9.9H4.1z" />}
        </svg>
      </button>
    </div>
  );
}
