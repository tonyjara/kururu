/**
 * The floating Kuru's three drawings: the logo, the chat behind it, and the
 * voice's waveform beside it.
 *
 * The desktop app keeps Kuru's logo over every application
 * (`desktop/float.js`), and a thing over another application is a window of
 * its own. These are what is in those windows, and they are deliberately the
 * same build with most of it not mounted, as the pill and a note window are:
 * `main.tsx` renders `FloatLogo` for `?float=logo` and `FloatPanel` for
 * `?float=panel`, and what mounts is the session and the one thing drawn. No
 * panes, no emulators, no notifications and no player — so neither has a
 * vote in the size policy, makes a sound the window is already making, or is
 * ever a second voice client.
 *
 * **The chat is the drawers themselves.** `FloatPanel` mounts `KuruDrawer`
 * and `NeedsDrawer` as `App` does, with the two chips in their header as the
 * way between them, on the page's own copy of the two little stores that say
 * which is open (`kuru.ts`, `needs.ts`). So the conversation, the box with
 * its references, files, quotes and dictation, the search, the pins and the
 * Needs list are the window's, to the component; what differs is only what a
 * door does. Anything that shows something in the window — a card on its
 * board, a terminal, a file a reply named — is said to the server as the
 * window would say it, and then the window is asked for across the bridge
 * (`go`), since the thing being shown is there and not here.
 *
 * **The box's pencil works here as it does in the window.** A screen pen
 * with no voice belongs to the page whose box its marks land in, and this
 * page has that box: it asks for the session, is told to send, posts the
 * marks and puts their lines in (`installInk`). The pen's tools are where
 * they always are, in the pill's draw-only form, which the floating Kuru
 * keeps in the logo's row.
 *
 * **The drawers are only mounted while the chat is open.** A reply stops
 * being unheard once it has been in view in an open drawer (`KURU_SEEN_MS`),
 * and a drawer left mounted in a hidden window would read every reply the
 * moment it arrived, with nobody looking.
 *
 * **The waveform is the pill's page's** (`FloatWave`, mounted by `Pill.tsx`
 * in place of the pill while the floating Kuru is on): that page is the one
 * voice client, so the level is its own microphone's and nothing is relayed.
 * The main process docks its window to the logo's row, on the side the chat
 * extends to, as wide as `FloatState.wave` says — its own width beside a
 * shut chat, the rest of the chat's along an open one, so the bar and the
 * logo together run the chat's edge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mascotFor } from "../../../shared/model";
import { needsOf, type Need } from "../../../shared/needs";
import { nodesNeedCount } from "../../../shared/nodes";
import { nextNeedAcross, nodeNeeds as nodeNeedsOf, qualify, type NodeNeed } from "../../../shared/remote";
import { longWaits } from "../../../shared/slots";
import { DEFAULT_VOICE, type OutboxEntry } from "../../../shared/voice";
import { desktop, type FloatState, type TalkGesture, type VoiceGlobalState } from "../desktop";
import "../float.css";
import { floatNow, useFloat } from "../float";
import { useInterface } from "../fonts";
import { installInk } from "../ink";
import { kuruLive, leaveKuruSearch, openKuru, quoteInKuru, toggleKuru, useKuruDrawer, type KuruLive } from "../kuru";
import { closeNeeds, toggleNeeds, useNeedsDrawer } from "../needs";
import { arrangedNeeds, useNeedsView } from "../needsorder";
import * as api from "../session";
import { useKururu } from "../session";
import { dismissVoice, installTalkKey, setVoiceProfile, setVoiceRemote, useMine, useOutgoing, useVoiceUi, type Outgoing, type VoicePhase } from "../voice";
import { DrawerChips } from "./DrawerChips";
import { Icon } from "./Icon";
import { KuruDrawer } from "./KuruDrawer";
import { NeedsDrawer } from "./NeedsDrawer";
import { QuoteToKuru } from "./Quote";
import { Mascot } from "./Status";

/** The logo's window, a side, in an app that does not say: what it was before it was given more room around the mark. */
const LOGO_WINDOW = 64;
/** How far a press on the logo travels before it is a drag and not a click — the pill's own slop. */
const SLOP_PX = 4;
/** How long the drawers stay mounted after the chat is shut: the window's fade, and a little. */
const LEAVE_MS = 200;
/** How long an opening chat's drawer is sliding in. */
const ENTER_MS = 240;
/** How near its foot a list has to be for a resize to keep it there: the drawer's own `STICK_PX`. */
const FOOT_PX = 48;
/** How often the waveform takes a sample of the level, and so how fast it runs. */
const SAMPLE_MS = 45;
/** A bar and the gap after it, in CSS pixels: how many bars a width holds. */
const BAR_PITCH = 5;

/**
 * **Neither page is hot-updated; each reloads instead**, for the reason the
 * pill's page does (`Pill.tsx` has the whole story): what these pages are
 * lives in module state — the socket in `session.ts`, which drawer is open in
 * `kuru.ts`, what the main process last said in `float.ts` — and a hot update
 * that reaches those makes second copies, with the components drawn against
 * one and the listeners still feeding the other. Here that showed as a
 * conversation opened at its top instead of at its newest line. They are
 * small and quick to load, so the update is held and the page loaded again:
 * the logo at once, the chat as soon as it is shut, so nothing is reloaded
 * under somebody typing in it — and its draft is the drawer's, kept as it
 * is typed, so even that would have lost nothing but the cursor.
 */
if (import.meta.hot && typeof location !== "undefined") {
  const role = new URLSearchParams(location.search).get("float");
  if (role === "logo" || role === "panel") {
    let reloading = false;
    const hold = () => {
      if (!reloading) {
        reloading = true;
        const poll = setInterval(() => {
          if (role === "panel" && floatNow()?.open) return;
          clearInterval(poll);
          location.reload();
        }, 500);
      }
      return new Promise<never>(() => {});
    };
    import.meta.hot.on("vite:beforeUpdate", hold);
    import.meta.hot.on("vite:beforeFullReload", hold);
  }
}

/** The pill's phase, as the main process tells every window: what the logo's ring wears. */
function useVoicePhase(): VoicePhase {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  useEffect(() => {
    const bridge = desktop()?.voice;
    if (!bridge) return;
    const follow = (state: VoiceGlobalState) => setPhase(state.phase);
    void bridge.global().then(follow, () => {});
    return bridge.onGlobal(follow);
  }, []);
  return phase;
}

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

/**
 * Kuru's mark, in a window exactly its size: the profile's mascot on the
 * chrome's ground, ringed in the ink of whatever Kuru or the voice is doing,
 * with the count of what needs you on its corner.
 *
 * It is all click and all handle, which is why it is not a draggable region:
 * `-webkit-app-region` swallows the click with the drag. So the press is
 * taken here, a drag told from a click by how far it travelled, and the main
 * process moves the window (`FloatKuru.drag`).
 */
export function FloatLogo() {
  const { snapshot, connected, kuru, nodes, slots } = useKururu();
  useInterface(snapshot);
  const float = useFloat();
  const phase = useVoicePhase();
  const held = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("float-page", "float-logo-page");
    document.title = "Kuru";
    return () => document.documentElement.classList.remove("float-page", "float-logo-page");
  }, []);

  const profile = snapshot?.profile ?? null;
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);
  const mascot = useMemo(() => {
    if (!snapshot || !profile) return null;
    const workspace = profile.workspaces.find((w) => w.id === profile.activeWorkspaceId);
    return mascotFor(snapshot.mascots, workspace?.mascotId ?? null);
  }, [snapshot, profile]);
  const conversation = kuru.find((c) => c.profileId === profile?.id) ?? null;
  const live: KuruLive = profile && connected ? kuruLive(profile, agents, conversation, phase === "speaking") : "off";
  // What needs you, here and on the other nodes: the chip's own sum.
  const needs = useMemo(() => (profile ? needsOf(profile, agents, longWaits(slots)) : null), [profile, agents, slots]);
  const count = (needs?.count ?? 0) + nodesNeedCount(nodes?.nodes ?? []);

  const bridge = desktop()?.float;
  const grab = (event: React.PointerEvent<HTMLButtonElement>) => {
    held.current = null;
    if (event.button !== 0) return;
    // Captured, so a drag faster than the window can follow still lands here.
    event.currentTarget.setPointerCapture(event.pointerId);
    held.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const drag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const from = held.current;
    if (!from || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!from.moved) {
      // In the window's own coordinates: until the drag begins the window is still, so they are the screen's.
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) < SLOP_PX) return;
      from.moved = true;
      bridge?.drag("start");
    }
    bridge?.drag("move");
  };
  const drop = (event: React.PointerEvent<HTMLButtonElement>) => {
    const from = held.current;
    held.current = null;
    if (!from) return;
    if (from.moved) bridge?.drag("end");
    else if (event.type === "pointerup") bridge?.press();
  };

  // Thinking hops; the voice at work is the mascot at rest but alive; anything else is still.
  const moving = live === "thinking" || phase === "listening" || phase === "speaking";
  const clip = mascot ? (live === "thinking" ? mascot.working : (mascot.idle ?? mascot.working)) : null;
  const label = `${logoSays(live, phase)}${count > 0 ? ` · ${count} ${count === 1 ? "thing needs" : "things need"} you` : ""} — ${float?.open ? "close" : "open"} the conversation, or drag to move`;

  // The window's own size, as the app says it: this page may be newer than the app, and the mark has to stand in the middle of the window that is there.
  const size = float?.logo ?? LOGO_WINDOW;
  return (
    <div className="float-logo-root" style={{ width: size, height: size }}>
      <button
        type="button"
        className={`float-logo float-logo-${live} float-voice-${phase} ${float?.open ? "float-logo-open" : ""} ${moving ? "" : "float-logo-still"}`}
        aria-label={label}
        aria-expanded={float?.open ?? false}
        title={label}
        onPointerDown={grab}
        onPointerMove={drag}
        onPointerUp={drop}
        onPointerCancel={drop}
        onContextMenu={(event) => {
          event.preventDefault();
          bridge?.menu();
        }}
        data-ink-what="the floating Kuru"
      >
        <span className="float-logo-ring" aria-hidden="true" />
        <span className={`status ${live === "thinking" ? "status-working" : "status-idle"}`} aria-hidden="true">
          {mascot && clip ? <Mascot config={mascot} clip={clip} /> : <span className="status-dot" />}
        </span>
        {count > 0 && (
          <span className="float-logo-count" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    </div>
  );
}

function logoSays(live: KuruLive, phase: VoicePhase): string {
  if (phase === "listening") return "Kuru is listening";
  if (phase === "speaking" || live === "speaking") return "Kuru is speaking";
  if (live === "thinking") return "Kuru is thinking";
  if (live === "asking") return "Kuru is asking something in its terminal";
  if (live === "off") return "Kuru is not running";
  return "Kuru";
}

// ---------------------------------------------------------------------------
// The chat
// ---------------------------------------------------------------------------

export function FloatPanel() {
  const { snapshot, kuru, nodes, slots, voice } = useKururu();
  // The interface's face and size, as every page of ours wears them.
  useInterface(snapshot);
  const float = useFloat();
  const phase = useVoicePhase();
  const kuruDrawer = useKuruDrawer();
  const needsOpen = useNeedsDrawer();
  const open = float?.open === true;
  const bridge = desktop()?.float;

  useEffect(() => {
    document.documentElement.classList.add("float-page", "float-panel-page");
    document.title = "Kuru";
    return () => document.documentElement.classList.remove("float-page", "float-panel-page");
  }, []);

  /**
   * The voice, as the window wires it while the pill is the voice client
   * (`useVoiceWiring`), and here always: this page never takes a clip for
   * Kuru and never plays a reply, so its gestures — the talk key pressed
   * with the chat in front, Escape while Kuru speaks, a reply's Stop — are
   * the voice client's, across the bridge. The box's own mic still dictates
   * here, which `voice.ts` keeps this page's whoever holds Kuru's clips.
   */
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const profileRef = useRef("");
  profileRef.current = snapshot?.profile.id ?? "";
  useEffect(() => {
    const voiceBridge = desktop()?.voice ?? null;
    const send = (gesture: TalkGesture) => voiceBridge?.gesture(gesture);
    setVoiceProfile(() => profileRef.current);
    setVoiceRemote(send, "idle");
    const stopKey = installTalkKey(() => voiceRef.current?.settings.talkKey ?? DEFAULT_VOICE.talkKey);
    // The screen pen with no voice, from the box's pencil: this page owns
    // the session as the window owns one it started, and the marks land in
    // this box (`ink.ts`). A pen with a recording is the voice client's.
    const stopInk = installInk();
    const follow = (state: VoiceGlobalState) => setVoiceRemote(send, state.phase);
    let stopGlobal = () => {};
    if (voiceBridge) {
      void voiceBridge.global().then(follow, () => {});
      stopGlobal = voiceBridge.onGlobal(follow);
    }
    return () => {
      stopKey();
      stopInk();
      stopGlobal();
      setVoiceRemote(null);
    };
  }, []);

  /**
   * Opened, there is always a drawer in it: Kuru's unless the Needs list was
   * what it was left on. And the lit chip pressed, or a drawer's own ✕ —
   * which in the window puts the drawer away — puts the chat away here,
   * since a chat with neither drawer in it is an empty box.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    const just = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open || kuruDrawer.open || needsOpen) return;
    if (just) {
      openKuru();
      return;
    }
    // A turn later, and only if it is still so: going from one drawer to the
    // other is two stores changing, and the moment between them has neither.
    const timer = setTimeout(() => bridge?.close(), 0);
    return () => clearTimeout(timer);
  }, [open, kuruDrawer.open, needsOpen, bridge]);

  /**
   * Words put into the box while the chat is shut — the marks of a pen this
   * page started, kept when the pill's Done was pressed with the chat put
   * away to draw on what was under it — open the chat, since a box nobody
   * can see is marks nobody knows arrived. They wait in `kuru.ts` for the
   * composer the opening mounts.
   */
  const waiting = kuruDrawer.words !== null;
  useEffect(() => {
    if (waiting && !open) bridge?.show?.();
  }, [waiting, open, bridge]);

  /**
   * Mounted while open and through the fade out, then not — the header has
   * why not always. `entering` is the first moments of an opening, which is
   * when a drawer slides in; one swapped for the other while the chat is
   * open only changes.
   */
  const [shown, setShown] = useState(open);
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (open) {
      setShown(true);
      setEntering(true);
      const timer = setTimeout(() => setEntering(false), ENTER_MS);
      return () => clearTimeout(timer);
    }
    setEntering(false);
    const timer = setTimeout(() => setShown(false), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  /**
   * Escape puts the chat away, as it does the drawer in the window: a search
   * that is up goes first, and never from inside the box, where Escape is
   * the box's own way out.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest(".kuru-composer, .menu, .scrim, .quote-pop")) return;
      event.preventDefault();
      if (needsOpen || !leaveKuruSearch()) bridge?.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, needsOpen]);

  /**
   * A conversation read at its foot stays at its foot while the chat is made
   * shorter or taller. The drawer keeps to the newest line as lines arrive,
   * but in the window its height only ever changes with the window's; here
   * the height is the thing somebody drags, to keep the chat short and see
   * only the last few messages — and a list that kept its top while its box
   * shrank would hide exactly those. How far from the foot the list was is
   * taken on every scroll, since after the resize it is no longer knowable.
   */
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = root.current;
    if (!panel || !shown) return;
    let fromFoot = 0;
    let watched: Element | null = null;
    const watch = new ResizeObserver(() => {
      if (watched && fromFoot < FOOT_PX) watched.scrollTop = watched.scrollHeight;
    });
    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.matches(".kuru-list")) return;
      fromFoot = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (el === watched) return;
      watch.disconnect();
      watched = el;
      watch.observe(el);
    };
    // A list just drawn opens at its foot and has not scrolled yet.
    const first = panel.querySelector(".kuru-list");
    if (first) {
      watched = first;
      watch.observe(first);
    }
    panel.addEventListener("scroll", onScroll, true);
    return () => {
      panel.removeEventListener("scroll", onScroll, true);
      watch.disconnect();
    };
  }, [shown, kuruDrawer.open]);

  const profile = snapshot?.profile ?? null;
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);
  const mascot = useMemo(() => {
    if (!snapshot || !profile) return null;
    const workspace = profile.workspaces.find((w) => w.id === profile.activeWorkspaceId);
    return mascotFor(snapshot.mascots, workspace?.mascotId ?? null);
  }, [snapshot, profile]);
  const kuruHere = useMemo(() => kuru.find((c) => c.profileId === profile?.id) ?? null, [kuru, profile?.id]);
  const needs = useMemo(() => (profile ? needsOf(profile, agents, longWaits(slots)) : null), [profile, agents, slots]);
  const { order } = useNeedsView(profile?.key ?? null);
  const queue = useMemo(() => (needs ? arrangedNeeds(needs, order) : null), [needs, order]);
  const linked = nodes?.nodes ?? [];

  /** The window, brought up for something said to the server a moment ago — or for a card, which it finds by its id. */
  const go = useCallback((cardId: string | null = null) => bridge?.go(cardId), [bridge]);
  const goToNeed = useCallback(
    (need: Need) => {
      if (need.agent) {
        api.revealAgent(need.agent.id);
        go();
      } else if (need.card) go(need.card.id);
      else {
        api.switchWorkspace(need.workspaceId);
        go();
      }
    },
    [go],
  );
  const goToNodeNeed = useCallback(
    ({ node, workspaceKey, need }: NodeNeed) => {
      if (need.agentId) api.revealAgent(qualify(node, need.agentId));
      else api.showNodeWorkspace(node, workspaceKey);
      go();
    },
    [go],
  );
  const goNext = useCallback(() => {
    if (!queue) return;
    // From nowhere in particular: the chat has no pane with the keyboard in it, so the walk starts at the top.
    const next = nextNeedAcross(queue, nodeNeedsOf(linked), { focusedAgentId: null, workspaceId: null, remote: null, boardShowing: false });
    if (!next) return;
    if ("here" in next) goToNeed(next.here);
    else goToNodeNeed(next.there);
  }, [queue, linked, goToNeed, goToNodeNeed]);

  /** A file a reply named opens in the window's panes, by the drawer's own link; the window comes up to show it. */
  const onClick = (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(".made-link, .kuru-file")) go();
  };

  /**
   * A handle's drag, told to the main process as it happens: the far
   * horizontal edge for the height, the far vertical one for the width, the
   * corner between them for both. Whether one is under way is kept here and
   * not asked of the pointer's capture, so that however it ends — the button
   * up, the press cancelled, the capture taken away — the main process is
   * told once that it has, and the size is written down.
   */
  const gripHeld = useRef<Edge | null>(null);
  const gripEnd = () => {
    const edge = gripHeld.current;
    if (!edge) return;
    gripHeld.current = null;
    bridge?.grip("end", edge);
  };
  const gripFor = (edge: Edge) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gripHeld.current = edge;
      bridge?.grip("start", edge);
    },
    onPointerMove: () => {
      if (gripHeld.current) bridge?.grip("move", gripHeld.current);
    },
    onPointerUp: gripEnd,
    onPointerCancel: gripEnd,
    onLostPointerCapture: gripEnd,
  });

  const side = float?.side ?? "above";
  const ready = snapshot && profile && mascot;
  const chips = ready ? (
    <DrawerChips
      kuru={{ live: kuruLive(profile, agents, kuruHere, phase === "speaking"), undelivered: kuruHere?.undelivered ?? 0, open: kuruDrawer.open, mascot }}
      onKuru={toggleKuru}
      needs={{
        count: (needs?.count ?? 0) + nodesNeedCount(linked),
        workspaces: (needs?.inWorkspaces ?? 0) + linked.reduce((n, node) => n + (node.state === "up" ? (node.summary?.needs.inWorkspaces ?? 0) : 0), 0),
        cards: needs?.cards.length ?? 0,
        open: needsOpen,
      }}
      onNeeds={toggleNeeds}
    />
  ) : null;

  return (
    <div
      ref={root}
      className={`float-panel float-panel-${side} float-panel-${float?.reach ?? "left"} ${open ? "float-panel-open" : "float-panel-shut"} ${entering ? "float-panel-entering" : ""} ${float?.pen ? "float-panel-pen" : ""}`}
      onClick={onClick}
    >
      {/* The edges away from the logo: the ones that move when the chat is
          made taller, shorter, wider or narrower. The width's and the
          corner's only in an app that can drag them. */}
      <div
        className="float-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Make the conversation taller or shorter"
        title="Drag to make the conversation taller or shorter"
        {...gripFor("height")}
      />
      {float?.wide && (
        <div
          className="float-grip-side"
          role="separator"
          aria-orientation="vertical"
          aria-label="Make the conversation wider or narrower"
          title="Drag to make the conversation wider or narrower"
          {...gripFor("width")}
        />
      )}
      {float?.wide && <div className="float-grip-corner" aria-hidden="true" title="Drag to resize the conversation" {...gripFor("both")} />}
      {shown && ready && kuruDrawer.open && (
        <KuruDrawer
          profile={profile}
          agents={agents}
          mascot={mascot}
          sheet={false}
          focus={kuruDrawer.focus}
          asked={kuruDrawer.asked}
          onClose={() => bridge?.close()}
          onResize={nothing}
          onResetWidth={nothing}
          onEditing={nothing}
          chips={chips}
          onTerminal={() => api.startHarness().then(() => go())}
          onCard={(_workspaceId, cardId) => go(cardId)}
        />
      )}
      {shown && ready && !kuruDrawer.open && needsOpen && queue && (
        <NeedsDrawer
          needs={queue}
          profile={profile}
          nodes={linked}
          mascots={snapshot.mascots}
          agents={agents}
          sheet={false}
          onClose={() => {
            closeNeeds();
            bridge?.close();
          }}
          onResize={nothing}
          onResetWidth={nothing}
          chips={chips}
          onGo={goToNeed}
          onGoNode={goToNodeNeed}
          onNext={goNext}
          onWorkspace={(workspaceId) => {
            api.switchWorkspace(workspaceId);
            go();
          }}
          onBoard={(_workspaceId, cardId) => go(cardId)}
          onProfileCard={(cardId) => go(cardId)}
        />
      )}
      {shown && !ready && <p className="float-panel-wait muted">Connecting to the kururu server…</p>}
      {/* A reply's words selected and quoted go into this page's own box. */}
      {shown && ready && <QuoteToKuru onQuote={(reference, quote) => quoteInKuru(reference, quote)} />}
    </div>
  );
}

function nothing(): void {}

/** Which of the chat's far edges a handle drags. */
type Edge = "height" | "width" | "both";

// ---------------------------------------------------------------------------
// The waveform, in the pill's page
// ---------------------------------------------------------------------------

/**
 * The voice beside the logo, where the pill would have been: the microphone
 * as a waveform running towards the logo while it listens, Kuru's voice as
 * one running away from it while a reply is said, and words only for what
 * would otherwise go unnoticed — a clip the server is not taking, words that
 * were not heard. The ✕ is the pill's: drop the clip, stop Kuru, dismiss.
 *
 * As tall as the logo's mark and `float.wave` wide, since the main process
 * puts its window in the logo's row and the two are read as one thing.
 */
export function FloatWave({ float }: { float: FloatState }) {
  const ui = useVoiceUi();
  const mineId = useMine();
  const { outbox } = useKururu();
  const outgoing = useOutgoing();
  const mine: OutboxEntry | Outgoing | null = mineId ? (outbox.find((e) => e.id === mineId) ?? outgoing.find((c) => c.id === mineId) ?? null) : null;
  const stuck = ui.phase === "sending" && mine !== null && !("state" in mine) && mine.error !== null;
  const words = ui.phase === "error" ? ui.text : stuck ? "Not with the server yet — kept, retrying" : null;
  // Room for words when there are some: a waveform's width holds four of them.
  const width = words ? Math.max(float.wave, 300) : float.wave;
  const bars = Math.max(8, Math.floor((width - 58) / BAR_PITCH));
  const levels = useLevels(ui.phase === "listening", ui.level, bars);
  if (ui.phase === "idle") return null;

  const dismiss = ui.phase === "listening" ? "Drop the clip (Esc)" : ui.phase === "speaking" ? "Stop Kuru (Esc)" : ui.phase === "sending" ? (stuck ? "Hide — it keeps trying, and it is in your messages" : null) : "Dismiss";
  const says =
    ui.phase === "listening"
      ? ui.toggled
        ? "Listening — tap the talk key again to send, Esc to drop"
        : "Listening — let go to send, Esc to drop"
      : ui.phase === "speaking"
        ? `Kuru: ${ui.text}`
        : ui.phase === "sending"
          ? (words ?? "Saving…")
          : [ui.text, ui.detail].filter(Boolean).join(" — ");

  return (
    <div
      className={`float-wave float-wave-${ui.phase} float-wave-${float.reach} ${float.open ? "float-wave-wide" : ""}`}
      style={{ width }}
      role="status"
      aria-live="polite"
      aria-label={says}
      title={says}
      onMouseDown={(event) => event.preventDefault()}
    >
      {words ? (
        <span className="float-wave-words">{words}</span>
      ) : (
        <span className="float-wave-bars" aria-hidden="true">
          {levels.map((level, i) => (
            <span
              key={i}
              className="float-wave-bar"
              style={ui.phase === "listening" ? { transform: `scaleY(${level.toFixed(2)})` } : { animationDelay: `${(i % 9) * -110 - Math.floor(i / 9) * 37}ms` }}
            />
          ))}
        </span>
      )}
      {dismiss && (
        <button type="button" className="float-wave-close" onClick={dismissVoice} title={dismiss} aria-label={dismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

/**
 * The last `count` samples of the level, newest last, as each bar's height
 * 0–1. Sampled on a clock rather than on the level's own changes, so the
 * waveform runs at one speed however often the microphone reports; and held
 * in a ref between samples, so thirty reports a second are not thirty
 * renders on top of the clock's.
 */
function useLevels(listening: boolean, level: number, count: number): number[] {
  const now = useRef(level);
  now.current = level;
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: count }, () => 0.08));
  useEffect(() => {
    if (!listening) {
      setLevels(Array.from({ length: count }, () => 0.08));
      return;
    }
    const timer = setInterval(() => {
      // A square root, so quiet speech still moves the bars and a shout does not pin them.
      const tall = Math.max(0.08, Math.min(1, Math.sqrt(Math.max(0, now.current)) * 1.1));
      setLevels((was) => [...was.slice(-(count - 1)), tall]);
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [listening, count]);
  return levels.length === count ? levels : [...Array.from({ length: Math.max(0, count - levels.length) }, () => 0.08), ...levels].slice(-count);
}
