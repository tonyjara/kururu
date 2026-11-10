/**
 * One variable of an env file replaced, and nothing else in it touched.
 *
 * The vault's dialog writes a pasted key into the file a program reads its
 * settings from — `~/.config/pylink-local/env` was the first — and that file
 * is the program's, in the program's format, beside the program's other
 * settings. So the rule is the narrowest edit that does the job: every line
 * that sets the variable is replaced where it stands, keeping its `export `;
 * a variable that is not there is appended; every other byte stays as it
 * was. A file that is not an env file at all is refused rather than edited,
 * so a path mistyped as `~/.zshrc` is an error and not a line added to the
 * owner's shell.
 *
 * Pure, and tested on its own, because a mistake here is an edit to a file
 * kururu does not own.
 */
import { VARIABLE } from "./vaultitems";

const ASSIGN = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;
const COMMENT = /^\s*#/;

interface Assignment {
  /** The first line and one past the last: a quoted value may run over several. */
  from: number;
  to: number;
  name: string;
  exported: boolean;
}

/**
 * Where the quote that opens a value closes, on the same line or a later
 * one. Dotenv readers take a double-quoted value over several lines (a PEM
 * key is often kept that way) and so does a shell for either quote; a value
 * left open to the end of the file is not an env file.
 */
function valueEnd(lines: readonly string[], at: number, rest: string): number | null {
  const open = rest.trimStart()[0];
  if (open !== '"' && open !== "'") return at;
  const body = rest.trimStart().slice(1);
  const closes = (text: string): boolean => {
    if (open === "'") return text.includes("'");
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\\") i += 1;
      else if (text[i] === '"') return true;
    }
    return false;
  };
  if (closes(body)) return at;
  for (let i = at + 1; i < lines.length; i += 1) if (closes(lines[i] ?? "")) return i;
  return null;
}

/** The file read as assignments, or the first line (1-based) that is not blank, a comment or one. */
export function envShape(text: string): { ok: true; assignments: Assignment[] } | { ok: false; line: number } {
  const lines = text.split("\n");
  const assignments: Assignment[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (!line.trim() || COMMENT.test(line)) continue;
    const m = ASSIGN.exec(line);
    if (!m) return { ok: false, line: i + 1 };
    const end = valueEnd(lines, i, m[5] ?? "");
    if (end === null) return { ok: false, line: i + 1 };
    assignments.push({ from: i, to: end + 1, name: m[3] ?? "", exported: Boolean(m[2]) });
    i = end;
  }
  return { ok: true, assignments };
}

/** Characters a value may have and be written bare: what no shell and no dotenv reader treats specially. */
const BARE = /^[A-Za-z0-9_./:+=@,%-]*$/;

/**
 * A value as the right-hand side of `NAME=`: bare when it can be, single
 * quotes when it has no `'` (read literally by a shell and by dotenv), and
 * double quotes otherwise with what a shell would expand escaped. A newline
 * is refused before this, by the caller: a key with one is kept in the
 * Keychain, and no single form of it reads the same to every env reader.
 */
export function quoteEnv(value: string): string {
  if (BARE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/** Whether a value can go in an env file at all. */
export function envValueOk(value: string): boolean {
  return !/[\r\n\u0000]/.test(value);
}

/**
 * The file with `variable` set to `value`. Throws, with a sentence for the
 * owner and never the value, when the file is not an env file or the value
 * cannot be written as one line. `text` is `""` for a file that is not
 * there yet.
 */
export function setVariable(text: string, variable: string, value: string): string {
  if (!VARIABLE.test(variable)) throw new Error(`${variable} is not a variable name`);
  if (!envValueOk(value)) throw new Error("the value has a line break, which an env file cannot hold on one line; it is kept in the Keychain only");
  const shape = envShape(text);
  if (!shape.ok) throw new Error(`line ${shape.line} is not NAME=value, a comment or blank, so this does not look like an env file; nothing was changed`);
  const lines = text.split("\n");
  const ours = shape.assignments.filter((a) => a.name === variable);
  if (ours.length === 0) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${variable}=${quoteEnv(value)}\n`;
  }
  // From the last to the first, so the earlier indices still hold.
  for (const a of [...ours].reverse()) {
    const first = lines[a.from] ?? "";
    const cr = first.endsWith("\r") && (lines[a.to - 1] ?? "").endsWith("\r") ? "\r" : "";
    const m = ASSIGN.exec(first.replace(/\r$/, ""));
    const lead = m?.[1] ?? "";
    lines.splice(a.from, a.to - a.from, `${lead}${a.exported ? "export " : ""}${variable}=${quoteEnv(value)}${cr}`);
  }
  return lines.join("\n");
}
