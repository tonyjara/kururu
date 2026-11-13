/**
 * A Cloudflare tunnel as one line: whether its address answers, when that
 * was last looked at, and the address itself — pressed, it is copied, and the arrow
 * beside it opens it.
 *
 * The same line in two places, because a tunnel belongs to two things: the
 * dev server it serves (paired by port, `shared/tunnels.ts`), under that
 * server's row in the sidebar's Dev servers; and the terminal it was typed
 * into, under that terminal's row. The first is where you look to ask "is
 * this app reachable from outside", the second where you look to ask "what is
 * that shell doing". Copy rather than open on the address, since what a
 * tunnel's address is usually wanted for is pasting somewhere — a webhook's
 * settings, an app's config — and opening it is the arrow's.
 */
import { useEffect, useState } from "react";
import { healthWord, tunnelHost } from "../../../shared/tunnels";
import type { Tunnel } from "../../../shared/wire";
import { useKururu } from "../session";
import { Icon } from "./Icon";
import { copyText } from "./KuruMarkdown";

function clock(at: number | null): string {
  return at === null ? "—" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What the hover says: the whole of what is known, for the one who wants it. */
function hover(t: Tunnel): string {
  return [
    `Cloudflare tunnel — ${healthWord(t)}: ${t.why}`,
    t.url ? `Address: ${t.url}` : null,
    t.target ? `Forwards to ${t.target}` : null,
    `Looked at ${clock(t.checkedAt)}`,
    t.publicAt !== null ? `Address last asked from outside at ${clock(t.publicAt)}` : null,
    t.command,
  ]
    .filter(Boolean)
    .join("\n");
}

export function TunnelLine({ tunnel, showPort = false }: { tunnel: Tunnel; showPort?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const host = tunnel.url ? tunnelHost(tunnel.url) : null;
  return (
    <span className={`tun-line tun-${tunnel.health}`} title={hover(tunnel)}>
      <span className={`tun-dot tun-dot-${tunnel.health}`} aria-hidden />
      <span className="tun-label">tunnel</span>
      {host ? (
        <button
          className="tun-url"
          onClick={(event) => {
            event.stopPropagation();
            void copyText(tunnel.url!).then((ok) => ok && setCopied(true));
          }}
          aria-label={`Copy ${tunnel.url}`}
        >
          {copied ? "Copied" : host}
        </button>
      ) : (
        <span className="tun-url tun-url-none">no address yet</span>
      )}
      {showPort && tunnel.port !== null && <span className="tun-port">→ :{tunnel.port}</span>}
      <span className="tun-state">
        {healthWord(tunnel)} · {clock(tunnel.checkedAt)}
      </span>
      {tunnel.url && (
        <a
          className="tun-open"
          href={tunnel.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Open ${tunnel.url}`}
        >
          <Icon name="external" />
        </a>
      )}
    </span>
  );
}

/** The tunnels typed into one terminal, under its row in the sidebar; nothing when there are none. */
export function TerminalTunnels({ agentId }: { agentId: string }) {
  const { tunnels } = useKururu();
  const mine = tunnels.filter((t) => t.agentId === agentId);
  if (!mine.length) return null;
  return (
    <span className="tun-under-agent">
      {mine.map((t) => (
        <TunnelLine key={t.id} tunnel={t} showPort />
      ))}
    </span>
  );
}
