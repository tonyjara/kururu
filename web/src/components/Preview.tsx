import { useEffect, useMemo } from "react";
import { openPreview } from "../session";
import type { DevServer } from "../../../shared/wire";

interface Props {
  dev: DevServer | null;
}

/**
 * The dev server, in an iframe.
 *
 * Which URL depends on who is looking. On this machine localhost *is* the dev
 * server, so the iframe points straight at it and no proxy runs at all. From a
 * phone, localhost is the phone — so the server opens a proxy on a port of its
 * own and we point at that instead. Same component, one decision.
 */
export function Preview({ dev }: Props) {
  const local = useMemo(
    () => location.hostname === "localhost" || location.hostname === "127.0.0.1",
    [],
  );

  // A remote viewer needs a proxy; ask for one as soon as we know the port.
  useEffect(() => {
    if (!dev || local || dev.proxyPort) return;
    openPreview(dev.port);
  }, [dev, local]);

  if (!dev) {
    return (
      <div className="empty">
        <h2>No dev server running</h2>
        <p>
          Start one and it shows up here. Kururu asks the kernel which port a process is
          actually listening on, so <code>npm run dev</code> is found without being told.
        </p>
      </div>
    );
  }

  const src = local
    ? `http://localhost:${dev.port}/`
    : dev.proxyPort
      ? `${location.protocol}//${location.hostname}:${dev.proxyPort}/`
      : null;

  if (!src) {
    return (
      <div className="empty">
        <h2>Opening a proxy for :{dev.port}</h2>
        <p>
          Your phone cannot reach this machine's <code>localhost</code>, so kururu is putting
          the dev server on a port of its own.
        </p>
      </div>
    );
  }

  return (
    <iframe
      className="preview-frame"
      src={src}
      title={`${dev.program} on port ${dev.port}`}
      // Let the previewed app do what it would do in a tab, minus top-level navigation.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    />
  );
}
