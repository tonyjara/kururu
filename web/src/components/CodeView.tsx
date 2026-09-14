import { useEffect, useState } from "react";
import type { OpenFile } from "../App";

interface Props {
  file: OpenFile | null;
}

/**
 * A file, read-only, with line numbers.
 *
 * Plain text for now. Syntax highlighting belongs on the server (Shiki, so the
 * phone is sent markup rather than a highlighter and every grammar it might
 * need) — that is the next step here, and nothing in this component's shape
 * changes when it lands.
 */
export function CodeView({ file }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    let live = true;
    setText(null);
    setError(null);
    const params = new URLSearchParams({ root: file.root, path: file.path });
    fetch(`/api/file?${params}`)
      .then((res) => res.json())
      .then((body: { text?: string; error?: string }) => {
        if (!live) return;
        if (body.error) setError(body.error);
        else setText(body.text ?? "");
      })
      .catch((err: unknown) => live && setError(String(err)));
    return () => {
      live = false;
    };
  }, [file]);

  if (!file) {
    return (
      <div className="empty">
        <h2>No file open</h2>
        <p>Open the sidebar and pick one from a project kururu can see.</p>
      </div>
    );
  }

  if (error) return <div className="empty"><h2>Could not read that</h2><p>{error}</p></div>;
  if (text === null) return <div className="empty"><p>Reading {file.path}…</p></div>;

  const lines = text.split("\n");
  return (
    <div className="code">
      <div className="code-path">{file.path}</div>
      <pre className="code-body">
        {lines.map((line, i) => (
          <div className="code-line" key={i}>
            <span className="code-gutter">{i + 1}</span>
            <span className="code-text">{line || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
