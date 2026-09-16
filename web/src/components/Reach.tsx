/**
 * How to get kururu onto the phone: two addresses, as two things to point a
 * camera at.
 *
 * Kururu has always served the same URL to the Electron window and to a phone,
 * and the phone half has always been the half nobody could get to — because
 * getting to it meant knowing which of a Mac's four IPv4 addresses is the one
 * the phone can see, and then typing it, with a port, on a phone keyboard. This
 * is a dialog that answers both.
 *
 * Two codes rather than one, side by side, because the two ways in fail in
 * completely different situations and neither is a fallback for the other: the
 * LAN address is the fast one and needs both devices on the same Wi-Fi, and the
 * tailnet address works from a train and needs tailscale up at both ends. Which
 * you want depends on where you are, which this cannot know — so it shows both
 * and lets the phone choose by which one it can reach.
 *
 * **The URL is built from `window.location`, not from the server's port**, and
 * that is the one decision in here worth the paragraph. In dev the window is
 * loaded from vite on 5173 and the kururu server is on 7717 behind it; the phone
 * pointed at 7717 would get `web/dist`, which in dev is whatever was last built
 * — a stale app, talking to a live server, with nothing on screen to say so. So
 * the code encodes *the page you are looking at*, at somebody else's address,
 * and the phone gets what the desktop has. `reach.port` is still fetched, and is
 * drawn as a note when the two differ, because "why is my phone a commit
 * behind" is otherwise a long afternoon.
 *
 * It re-asks while it is open. Interfaces raise no event, and the thing people
 * will actually do when this says tailscale is down is turn tailscale on and
 * look back at the dialog — so it would have to be re-opened to be right, which
 * is the kind of small lie that makes somebody stop trusting a readout. Three
 * seconds, and nothing at all while the dialog is closed.
 *
 * Either code can be put away, and the toggle is per-way rather than one switch
 * over the pair — the two are wanted in different situations by construction, so
 * a single one would only ever be hiding the one somebody still uses. Hiding
 * *collapses* the code rather than blanking it, because the space is the whole
 * point; what is left behind is the address, which is the half you can read.
 */
import { useEffect, useState } from "react";
import type { Reach as ReachInfo, Sharing } from "../../../shared/wire";
import { REACH_POLL_MS } from "../../../shared/wire";
import { qrMatrix } from "../qr";

/**
 * The two questions this dialog asks are answered together, by one fetch, and
 * that is not a saving — "how do I get to this from my phone" and "is anybody
 * allowed to" are one sentence to the person reading it. Splitting them would
 * let the dialog draw a perfectly good QR code for an address the server is not
 * listening on.
 */
type ReachAnswer = ReachInfo & Sharing;

/**
 * Which codes this device keeps out of the way, by the name of the way in.
 *
 * Per device rather than in the snapshot, on `zoom.ts`'s reasoning: a phone and
 * a desktop watching one server are two windows of two shapes, and a code
 * hidden on the small one has said nothing about the big one. It outlives the
 * dialog rather than resetting every time it opens, because hiding one is
 * nearly always a standing fact about how you get in — a machine with no
 * tailnet, a phone that is never on this Wi-Fi — and re-hiding it each open
 * would be the dialog forgetting something it had been told. Nothing is lost by
 * keeping it: the address is still printed where the code was, and the button
 * beside the title says `Show`.
 */
const HIDDEN_KEY = "kururu.reach.hidden";

type WayName = "lan" | "tailscale";

/**
 * Whatever is stored, made into a list of ways. A hand-edited value hides
 * nothing rather than being believed — this is a view state with a button next
 * to it, so the cost of falling back is one click and the cost of trusting a
 * string is a dialog that draws neither code and says why nowhere.
 */
function readHidden(): WayName[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const stored = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(stored)) return [];
    return stored.filter((one): one is WayName => one === "lan" || one === "tailscale");
  } catch {
    // A private window reads back nothing, and both codes are on — which is the
    // state this dialog shipped in.
    return [];
  }
}

export function Reach({ onClose }: { onClose: () => void }) {
  const [reach, setReach] = useState<ReachAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * Which LAN address the code is for. Null means "whatever is first", so that
   * a machine which gains or loses an interface while this is open follows
   * along — an index would silently point at a different address, and a copied
   * string would keep showing one that has gone.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [hidden, setHidden] = useState<WayName[]>(readHidden);
  /** A press in flight, so the buttons cannot be pressed twice on a slow link. */
  const [busy, setBusy] = useState(false);

  /**
   * Turning sharing on or off, and minting a new code.
   *
   * The answer is applied straight away rather than waited for from the poll,
   * because turning sharing *on* ends in the server restarting — so the next
   * two or three polls will fail, and a dialog that only believed the poll
   * would sit there looking like nothing had happened for the most interesting
   * three seconds it has. A failure is left to the poll to correct: it is the
   * source of truth and it is three seconds away.
   */
  const askServer = async (body: { share?: boolean; rotate?: boolean }) => {
    setBusy(true);
    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as Sharing;
      setReach((was) => (was ? { ...was, ...next } : was));
    } catch {
      // The poll says what the server actually thinks, shortly.
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: WayName) => {
    setHidden((was) => {
      const next = was.includes(name) ? was.filter((one) => one !== name) : [...was, name];
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      } catch {
        // It holds for this window and will not be here tomorrow, which is the
        // bargain `zoom.ts` makes with the same storage for the same reason.
      }
      return next;
    });
  };

  useEffect(() => {
    let live = true;
    const ask = async () => {
      try {
        const response = await fetch("/api/reach");
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as ReachAnswer;
        if (!live) return;
        setReach(next);
        setFailed(false);
      } catch {
        // The server restarts on edit and this dialog survives it, so a failed
        // poll is the ordinary case rather than an error — it says so only once
        // there is nothing at all to draw.
        if (live) setFailed(true);
      }
    };
    ask();
    const timer = setInterval(ask, REACH_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const lan = reach?.lan ?? [];
  const address = chosen && lan.includes(chosen) ? chosen : lan[0];
  // The port the *window* came from, which in dev is vite and not the server.
  const port = window.location.port;
  const origin = (host: string) => `${window.location.protocol}//${host}${port ? `:${port}` : ""}`;
  /**
   * The code carries the token and the line under it does not, which is a
   * deliberate split rather than an oversight. The code is the thing a phone
   * consumes and it has to work on a device the server has never seen; the line
   * is the thing a *person* reads, and it is there to be checked against what
   * they already know about their own network — which a forty-character secret
   * on the end of it would make impossible, as well as putting it on screen in
   * every screenshot of this dialog anybody ever takes.
   */
  const url = (host: string) =>
    reach?.shared ? `${origin(host)}/?k=${encodeURIComponent(reach.token)}` : origin(host);

  return (
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="dialog reach-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Kururu on your phone"
      >
        <h2 className="dialog-title">Kururu on your phone</h2>
        <p className="dialog-hint">
          The same server, the same agents — a phone is for watching and steering them.
        </p>

        {reach && <ShareState reach={reach} busy={busy} onAsk={askServer} />}

        <div className="reach-pair">
          <Way
            title="This network"
            note="Both devices on the same Wi-Fi."
            url={address ? url(address) : null}
            label={address ? origin(address) : null}
            missing="No local network. This machine is not on a Wi-Fi or Ethernet it can be reached over."
            shown={!hidden.includes("lan")}
            onToggle={() => toggle("lan")}
          >
            {/* Which address the phone can see is a question only the phone can
                answer, so the alternates are on offer rather than hidden behind
                the guess. Drawn only when there is a choice to make. */}
            {lan.length > 1 && (
              <div className="reach-alts">
                {lan.map((one) => (
                  <button
                    key={one}
                    className={`reach-alt ${one === address ? "reach-alt-on" : ""}`}
                    onClick={() => setChosen(one)}
                    aria-pressed={one === address}
                  >
                    {one}
                  </button>
                ))}
              </div>
            )}
          </Way>

          <Way
            title="Tailscale"
            note="Anywhere, with tailscale up on both."
            url={reach?.tailscale ? url(reach.tailscale) : null}
            label={reach?.tailscale ? origin(reach.tailscale) : null}
            /* Named as a state of tailscale rather than as a missing address:
               this is the one of the two that has an obvious fix, and a dialog
               that just showed a gap would not be pointing at it. */
            missing="Tailscale is not up — there is no tailnet address on this machine."
            shown={!hidden.includes("tailscale")}
            onToggle={() => toggle("tailscale")}
          />
        </div>

        {failed && !reach && (
          <p className="reach-note">Asking the server… it may be restarting.</p>
        )}
        {/* In dev the window is vite's and the server is behind it. Both work,
            and which one the phone gets decides whether it sees today's code. */}
        {reach && port && port !== String(reach.port) && (
          <p className="reach-note">
            Serving from <code>:{port}</code>, with the kururu server on{" "}
            <code>:{reach.port}</code> behind it — so the phone gets this build, not the
            last one written to <code>web/dist</code>.
          </p>
        )}

        <div className="dialog-actions">
          <button className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Whether anybody but this machine is allowed in, and the button that decides.
 *
 * It sits above the codes rather than below them because it is the question
 * that has to be answered first: a QR code on a loopback-bound server is a
 * picture of an address that will not answer, and somebody who scanned it would
 * blame their phone, their Wi-Fi and their tailnet in that order before
 * suspecting the thing they were looking at the whole time.
 *
 * The wording is about the agents rather than about ports, because that is what
 * is actually behind the decision. "Binds 0.0.0.0" is true and tells nobody
 * anything; "anything on this network could use your agents" is the same
 * sentence with the consequence in it.
 */
function ShareState({
  reach,
  busy,
  onAsk,
}: {
  reach: ReachAnswer;
  busy: boolean;
  onAsk: (body: { share?: boolean; rotate?: boolean }) => void;
}) {
  // The socket and the decision disagreeing is exactly "a restart is owed".
  const pending = reach.shared !== reach.wanted;

  return (
    <section className={`reach-share ${reach.shared ? "reach-share-on" : "reach-share-off"}`}>
      {reach.shared ? (
        <p>
          <strong>Your devices can reach this kururu</strong> — the ones holding the code.
          Anything else on these networks is refused, which is what the code is for.
        </p>
      ) : (
        <p>
          <strong>Only this machine can reach kururu.</strong> Your agents, your terminals
          and the files they can read are all behind this server, so it listens on this
          machine alone until you say otherwise. Sharing puts it on the networks below
          and hands out a code that the device scanning has to keep.
        </p>
      )}

      <div className="reach-share-actions">
        {reach.shared ? (
          <>
            <button className="button button-quiet" onClick={() => onAsk({ share: false })} disabled={busy}>
              Stop sharing
            </button>
            {/* The way to say "that phone is not mine any more". Every device
                that has the old code is out, including the one you are on if it
                is not this machine — which is the point of it. */}
            <button className="button button-quiet" onClick={() => onAsk({ rotate: true })} disabled={busy}>
              New code
            </button>
          </>
        ) : (
          <button className="button" onClick={() => onAsk({ share: true })} disabled={busy}>
            Share with my devices
          </button>
        )}
      </div>

      {pending && (
        <p className="reach-note">
          {reach.restartable
            ? "Restarting the server so it can listen on the new address — the agents are next door and will not notice."
            : "Nothing is supervising this server, so it keeps its current address until you start it again yourself."}
        </p>
      )}
    </section>
  );
}

/**
 * One way in: the code, what it is, and the address under it.
 *
 * The address is printed as well as encoded, and not only as a courtesy to
 * somebody without a camera to hand — it is the one part of this that can be
 * checked against what you already know about your own network, and a QR code
 * is by construction unreadable to the person deciding whether to trust it.
 */
function Way({
  title,
  note,
  url,
  label,
  missing,
  shown,
  onToggle,
  children,
}: {
  title: string;
  note: string;
  url: string | null;
  /** What to print under the code, when that is not the whole of the URL. */
  label?: string | null;
  missing: string;
  shown: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <section className="reach-way">
      <header className="reach-head">
        <h3 className="reach-title">{title}</h3>
        {/* Only where there is a code to put away. A toggle over the box that
            says tailscale is down would be a control with nothing behind it,
            and the state it would remember is about an address that does not
            exist yet. */}
        {url && (
          <button
            className="reach-toggle"
            onClick={onToggle}
            aria-expanded={shown}
            title={shown ? `Hide the ${title} code` : `Show the ${title} code`}
          >
            {shown ? "Hide" : "Show"}
          </button>
        )}
      </header>
      {url ? (
        <>
          {/* Collapsed rather than replaced by a box the size of the code,
              which is the opposite of what the branch below does and is meant
              to be: `reach-absent` is there so tailscale coming up does not
              make the dialog jump under the pointer, and this is somebody
              asking for the space back. A placeholder here would be the button
              refusing to do the one thing it is for. */}
          {shown && <QrCode text={url} />}
          <a className="reach-url" href={url} target="_blank" rel="noreferrer">
            {(label ?? url).replace(/^https?:\/\//, "")}
          </a>
          <p className="reach-note">{note}</p>
          {children}
        </>
      ) : (
        /* A box the size of the code that is not there, so the two halves stay
           the same shape and tailscale coming up does not make the dialog jump. */
        <div className="reach-absent">
          <p>{missing}</p>
        </div>
      )}
    </section>
  );
}

/**
 * The matrix as one SVG path.
 *
 * One path of many little squares rather than a rect per module: a version 3
 * code is 841 of them, and 841 elements is a real amount of DOM to build every
 * time a poll comes back identical. `shape-rendering: crispEdges` is the part
 * that matters — the default antialiases the module edges into grey, which is
 * precisely the contrast a scanner is trying to threshold.
 *
 * The four-module quiet zone is in the viewBox, because that is where a margin
 * belongs. It is not decoration: a code butted against a dark background is a
 * code with no border, and a decoder locating the finders will not find them.
 * Which is also why the white stays white in a window that is otherwise all
 * dark — the quiet zone has to be the light of the code, not of the dialog.
 */
function QrCode({ text }: { text: string }) {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const quiet = 4;

  let path = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[y]![x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }

  return (
    <svg
      className="qr"
      viewBox={`0 0 ${size + quiet * 2} ${size + quiet * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${text}`}
    >
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
