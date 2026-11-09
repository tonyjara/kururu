/**
 * Kuru's reply drawn as the Markdown it was written in, with the drawer's
 * doors still in it.
 *
 * The tree comes from `kurumd.ts`; this only draws it. The one thing it does
 * not do itself is draw words: every run of text, every code span and every
 * fenced block is handed back to the caller's `leaf`, which is where the
 * drawer finds paths and card codes and lights a search's words — the same
 * pipeline it ran on the whole reply when the reply was one string, run now
 * on each leaf. A path in a table cell, a list item or a code span is a
 * door for the reason it was one in a sentence, and the search marks inside
 * it. A link whose target is a path (`[the plan](docs/plan.md)`) is given
 * to `link`, which answers with the file door around the label when the
 * server found the file, and with nothing when it did not, in which case
 * the label is words with the target in a tooltip.
 *
 * Headings are drawn as headings but sized for a bubble, not a page: the
 * biggest a step above the text. A table wider than the bubble scrolls
 * inside it, as the reader's does, never the drawer. A fenced block keeps a
 * copy button in its corner, drawn as an icon with no text node, so a
 * selection dragged across the block for a quote picks up the code and not
 * the word "Copy". A web link opens outside the app, as the reader's do,
 * since the app is the whole window. An image is only shown from the web;
 * a relative one would be a fetch kururu has no root for, so its alt text
 * stands in.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { MdBlock, MdInline } from "../kurumd";

export interface MarkdownDoors {
  /** Words as the drawer draws them: paths, card codes, a search's marks. */
  leaf: (text: string) => ReactNode;
  /** A link to a path on disk: the file door around `label` when there is one to open, else null. */
  link: (href: string, label: ReactNode) => ReactNode | null;
}

export function KuruMarkdown({ blocks, doors }: { blocks: readonly MdBlock[]; doors: MarkdownDoors }) {
  return <>{blocks.map((block, i) => drawBlock(block, i, doors))}</>;
}

/** The inline runs alone — a folded line, which is one row and no block. */
export function KuruInline({ nodes, doors }: { nodes: readonly MdInline[]; doors: MarkdownDoors }) {
  return <>{drawInlines(nodes, doors)}</>;
}

function drawBlock(block: MdBlock, key: number, doors: MarkdownDoors): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p key={key}>{drawInlines(block.children, doors)}</p>;
    case "heading": {
      const Tag = `h${block.level}` as const;
      return (
        <Tag key={key} className={`kuru-md-h kuru-md-h${block.level}`}>
          {drawInlines(block.children, doors)}
        </Tag>
      );
    }
    case "fence":
      return <Fence key={key} text={block.text} lang={block.lang} doors={doors} />;
    case "quote":
      return <blockquote key={key}>{block.children.map((child, i) => drawBlock(child, i, doors))}</blockquote>;
    case "rule":
      return <hr key={key} />;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : "kuru-md-task"}>
          {item.checked !== null && <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? "done" : "to do"} />}
          {item.children.map((child, j) => drawBlock(child, j, doors))}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      return (
        <table key={key}>
          {block.head.length > 0 && (
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} style={cell.align ? { textAlign: cell.align } : undefined}>
                    {drawInlines(cell.children, doors)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          {block.rows.length > 0 && (
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={cell.align ? { textAlign: cell.align } : undefined}>
                      {drawInlines(cell.children, doors)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      );
  }
}

function drawInlines(nodes: readonly MdInline[], doors: MarkdownDoors): ReactNode[] {
  return nodes.map((node, i) => drawInline(node, i, doors));
}

function drawInline(node: MdInline, key: number, doors: MarkdownDoors): ReactNode {
  switch (node.kind) {
    case "text":
      return <span key={key}>{doors.leaf(node.text)}</span>;
    case "code":
      return <code key={key}>{doors.leaf(node.text)}</code>;
    case "break":
      return <br key={key} />;
    case "strong":
      return <strong key={key}>{drawInlines(node.children, doors)}</strong>;
    case "em":
      return <em key={key}>{drawInlines(node.children, doors)}</em>;
    case "strike":
      return <s key={key}>{drawInlines(node.children, doors)}</s>;
    case "image":
      return node.src && /^https?:\/\//i.test(node.src) ? (
        <img key={key} src={node.src} alt={node.alt} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span key={key} className="kuru-md-dead" title={node.src}>
          {doors.leaf(node.alt || "image")}
        </span>
      );
    case "link": {
      const label = drawInlines(node.children, doors);
      if (node.to === "web" || node.to === "mail") {
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer noopener" title={node.href}>
            {label}
          </a>
        );
      }
      if (node.to === "path") {
        const door = doors.link(node.href, label);
        if (door !== null) return <span key={key}>{door}</span>;
      }
      return (
        <span key={key} className="kuru-md-dead" title={node.href}>
          {label}
        </span>
      );
    }
  }
}

/** How long the copy button says it copied. */
const COPIED_MS = 1500;

function Fence({ text, lang, doors }: { text: string; lang: string | null; doors: MarkdownDoors }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <pre data-lang={lang ?? undefined}>
      <button
        type="button"
        className={`kuru-md-copy ${copied ? "kuru-md-copied" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void copyText(text).then((ok) => setCopied(ok))}
        title={copied ? "Copied" : "Copy this block"}
        aria-label={copied ? "Copied" : "Copy this block"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <code>{doors.leaf(text)}</code>
    </pre>
  );
}

/**
 * Text onto the clipboard. The async clipboard needs a secure context, which
 * the phone over plain http is not; there the old way — a selection of a
 * textarea nobody sees, and `execCommand` — still works in every browser
 * kururu is drawn in.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Two sheets, for copying — drawn here, as the drawer's own glyphs are. */
function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="13" height="13" x="9" y="9" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
