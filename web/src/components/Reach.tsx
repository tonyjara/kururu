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
 */
import { useEffect, useState } from "react";
import type { Reach as ReachInfo } from "../../../shared/wire";
import { REACH_POLL_MS } from "../../../shared/wire";
import { qrMatrix } from "../qr";

export function Reach({ onClose }: { onClose: () => void }) {
  const [reach, setReach] = useState<ReachInfo | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * Which LAN address the code is for. Null means "whatever is first", so that
   * a machine which gains or loses an interface while this is open follows
   * along — an index would silently point at a different address, and a copied
   * string would keep showing one that has gone.
   */
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const ask = async () => {
      try {
        const response = await fetch("/api/reach");
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as ReachInfo;
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
  const url = (host: string) => `${window.location.protocol}//${host}${port ? `:${port}` : ""}`;

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

        <div className="reach-pair">
          <Way
            title="This network"
            note="Both devices on the same Wi-Fi."
            url={address ? url(address) : null}
            missing="No local network. This machine is not on a Wi-Fi or Ethernet it can be reached over."
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
            /* Named as a state of tailscale rather than as a missing address:
               this is the one of the two that has an obvious fix, and a dialog
               that just showed a gap would not be pointing at it. */
            missing="Tailscale is not up — there is no tailnet address on this machine."
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
  missing,
  children,
}: {
  title: string;
  note: string;
  url: string | null;
  missing: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="reach-way">
      <h3 className="reach-title">{title}</h3>
      {url ? (
        <>
          <QrCode text={url} />
          <a className="reach-url" href={url} target="_blank" rel="noreferrer">
            {url.replace(/^https?:\/\//, "")}
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
