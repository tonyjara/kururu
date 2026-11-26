/**
 * The guard on agents' shell commands: whether a command line aims a
 * destructive verb at a system path, read the way a shell would read it.
 *
 * It exists because of 2026-11-26. An agent's cleanup over ssh held
 * `rm -rf /dev/null 2>/dev/null`; it ran as root on a VPS, deleted
 * `/dev/null`, and ssh, `docker exec` and the containers broke until the
 * box was recreated from its host's console. Claude Code's own check on
 * `rm` did not fire, because the `rm` was inside a quoted ssh string, which
 * is a word to the outer shell and a command only to the far one. So this
 * reads into the places a command hides: `ssh … '…'`, `sh -c`, `bash -c`,
 * `docker exec`, `kubectl exec`, `eval`, `su -c`, `xargs`, `$( )`,
 * backticks and a here-document fed to a shell.
 *
 * What it refuses is narrow on purpose: one of a short list of verbs
 * (`DESTRUCTIVE`), or a `>` redirection, with a target that is a system
 * path (`systemPath`). Everything else passes, and so does anything it
 * cannot read, because a guard that refuses ordinary work gets switched
 * off, and then it refuses nothing. `2>/dev/null` is a redirection onto a
 * device kept for the purpose and passes; `rm /dev/null` does not.
 *
 * **An unknown variable is read as empty**, because that is how the
 * classic version of this accident happens: `rm -rf "$X"/` with `X` unset
 * is `rm -rf /`. On this machine the guard knows the environment it runs
 * in, which is the agent's, so `$TMPDIR` and `$HOME` are what the agent's
 * shell would make of them. On the far side of ssh or `docker exec` it
 * knows nothing but `HOME`, taken to be root's, since that is the case
 * that costs a machine. `${X:?}`, the guard a careful script writes
 * itself, is read as something that is not empty.
 *
 * Pure, and in `shared/` so the test is a table: `server/test/rmguard.test.ts`.
 * The hook that runs it is `server/src/guard-cli.ts`.
 */

/** A part of a word as the shell sees it before expansion. */
type Piece =
  | { t: "lit"; s: string }
  | { t: "var"; name: string; op?: string; arg?: string }
  | { t: "sub"; script: string }
  | { t: "tilde" };

type Word = { pieces: Piece[] };

type Token =
  | { k: "word"; w: Word }
  | { k: "op"; op: string }
  | { k: "redir"; op: string; fd: string }
  | { k: "heredoc"; body: string };

/** Where a script is being read: here, with the guard's own environment, or on another machine. */
type Level = { remote: boolean; env: Map<string, string>; depth: number };

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")", "{", "}"]);

/**
 * Split a script into tokens the way sh does, keeping enough of each word
 * to expand it later with whatever was assigned before it.
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const pendingHeredocs: { delim: string; strip: boolean }[] = [];
  let i = 0;
  let pieces: Piece[] = [];
  let inWord = false;
  let lit = "";

  const flushLit = () => {
    if (lit) pieces.push({ t: "lit", s: lit });
    lit = "";
  };
  const endWord = () => {
    flushLit();
    if (inWord) out.push({ k: "word", w: { pieces } });
    pieces = [];
    inWord = false;
  };

  /** From `(` just read, to the index after its `)`, minding quotes and nesting. */
  const matchParen = (from: number): number => {
    let depth = 1;
    let j = from;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === "'") {
        const end = src.indexOf("'", j + 1);
        j = end < 0 ? src.length : end + 1;
      } else if (c === '"') {
        j = matchDouble(j + 1);
      } else {
        if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
    }
    return j;
  };
  /** From just inside a `"`, to the index after the closing one. */
  const matchDouble = (from: number): number => {
    let j = from;
    while (j < src.length && src[j] !== '"') {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "$" && src[j + 1] === "(") j = matchParen(j + 2);
      else if (src[j] === "`") {
        const end = src.indexOf("`", j + 1);
        j = end < 0 ? src.length : end + 1;
      } else j++;
    }
    return j + 1;
  };

  /** A `$…` at `i`; returns the index after it and pushes what it was. */
  const dollar = (at: number): number => {
    const next = src[at + 1];
    if (next === "(") {
      if (src[at + 2] === "(") {
        // Arithmetic: a number, never a path.
        const end = matchParen(at + 2);
        flushLit();
        pieces.push({ t: "lit", s: "0" });
        return end + 1;
      }
      const end = matchParen(at + 2);
      flushLit();
      pieces.push({ t: "sub", script: src.slice(at + 2, end - 1) });
      return end;
    }
    if (next === "{") {
      const end = src.indexOf("}", at + 2);
      const body = src.slice(at + 2, end < 0 ? src.length : end);
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(:?[-=?+]|#{1,2}|%{1,2}|\/{1,2})?([\s\S]*)$/.exec(body);
      flushLit();
      if (m) pieces.push({ t: "var", name: m[1] ?? "", op: m[2], arg: m[3] });
      else pieces.push({ t: "var", name: "" });
      return end < 0 ? src.length : end + 1;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(at + 1));
    if (m) {
      flushLit();
      pieces.push({ t: "var", name: m[1] ?? "" });
      return at + 1 + (m[1]?.length ?? 0);
    }
    lit += "$";
    return at + 1;
  };

  /** After a newline: the bodies of any here-documents opened on the line just ended. */
  const readHeredocs = () => {
    while (pendingHeredocs.length) {
      const doc = pendingHeredocs.shift();
      if (!doc) break;
      const lines: string[] = [];
      while (i < src.length) {
        const nl = src.indexOf("\n", i);
        const line = src.slice(i, nl < 0 ? src.length : nl);
        i = nl < 0 ? src.length : nl + 1;
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        lines.push(line);
      }
      out.push({ k: "heredoc", body: lines.join("\n") });
    }
  };

  while (i < src.length) {
    const c = src[i] ?? "";
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      inWord = true;
      lit += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === "'") {
      inWord = true;
      const end = src.indexOf("'", i + 1);
      lit += src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      inWord = true;
      let j = i + 2;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") {
          const e = src[j + 1] ?? "";
          lit += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else lit += src[j++];
      }
      i = j + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        const d = src[j];
        if (d === "\\" && /[$`"\\\n]/.test(src[j + 1] ?? "")) {
          if (src[j + 1] !== "\n") lit += src[j + 1];
          j += 2;
        } else if (d === "$") {
          j = dollar(j);
        } else if (d === "`") {
          const end = src.indexOf("`", j + 1);
          flushLit();
          pieces.push({ t: "sub", script: src.slice(j + 1, end < 0 ? src.length : end) });
          j = end < 0 ? src.length : end + 1;
        } else lit += src[j++];
      }
      i = j + 1;
      continue;
    }
    if (c === "$") {
      inWord = true;
      i = dollar(i);
      continue;
    }
    if (c === "`") {
      inWord = true;
      const end = src.indexOf("`", i + 1);
      flushLit();
      pieces.push({ t: "sub", script: src.slice(i + 1, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "~" && !inWord) {
      const next = src[i + 1] ?? "";
      if (next === "" || next === "/" || /[\s;&|)]/.test(next)) {
        inWord = true;
        pieces.push({ t: "tilde" });
        i++;
        continue;
      }
    }
    if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "\n") {
      endWord();
      out.push({ k: "op", op: "\n" });
      i++;
      readHeredocs();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    // Process substitution: a command, and as a word, nothing that names a path here.
    if ((c === "<" || c === ">") && src[i + 1] === "(" && !inWord) {
      const end = matchParen(i + 2);
      inWord = true;
      flushLit();
      pieces.push({ t: "sub", script: src.slice(i + 2, end - 1) });
      i = end;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // A redirection, with the fd in front of it when the word so far is all digits.
      let fd = "";
      if (inWord && pieces.length === 0 && /^[0-9]+$/.test(lit)) {
        fd = lit;
        lit = "";
        inWord = false;
      } else endWord();
      const m = /^(<<<|<<-|<<|<>|<&|>>|>\||>&|&>>|&>|<|>)/.exec(src.slice(i));
      const op = m?.[1] ?? c;
      i += op.length;
      if (op === "<<" || op === "<<-") {
        while (src[i] === " " || src[i] === "\t") i++;
        const dm = /^(['"]?)([^\s;&|<>()'"]+)\1/.exec(src.slice(i));
        if (dm) {
          pendingHeredocs.push({ delim: dm[2] ?? "", strip: op === "<<-" });
          i += dm[0].length;
        }
        out.push({ k: "redir", op, fd });
        continue;
      }
      out.push({ k: "redir", op, fd });
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || ((c === "{" || c === "}") && !inWord && /[\s;]|^$/.test(src[i + 1] ?? ""))) {
      endWord();
      const m = /^(&&|\|\||\|&|;;|[;&|(){}])/.exec(src.slice(i));
      const op = m?.[1] ?? c;
      out.push({ k: "op", op: op === ";;" ? ";" : op });
      i += op.length;
      continue;
    }
    inWord = true;
    lit += c;
    i++;
  }
  endWord();
  return out;
}

/** Shell keywords that start a compound command and are not a command themselves. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time"]);

/** A word's value, with what is known of the environment. A `$( )` in it adds nothing and is put on `subs`, to be read as a script of its own. */
function expand(word: Word, level: Level, subs: string[]): string {
  let s = "";
  for (const p of word.pieces) {
    if (p.t === "lit") s += p.s;
    else if (p.t === "tilde") s += home(level);
    else if (p.t === "sub") {
      subs.push(p.script);
    } else {
      const known = lookup(p.name, level);
      if (p.op === ":?" || p.op === "?") s += known ?? `\${${p.name}}`;
      else if ((p.op === ":-" || p.op === "-" || p.op === ":=" || p.op === "=") && (known === undefined || known === "")) s += stripQuotes(p.arg ?? "");
      else if (p.op === ":+" || p.op === "+") s += known ? stripQuotes(p.arg ?? "") : "";
      else s += known ?? "";
    }
  }
  return s;
}

function stripQuotes(s: string): string {
  return s.replace(/^(['"])(.*)\1$/s, "$2");
}

function home(level: Level): string {
  return level.remote ? "/root" : (level.env.get("HOME") ?? "/root");
}

function lookup(name: string, level: Level): string | undefined {
  if (level.env.has(name)) return level.env.get(name);
  if (name === "HOME") return home(level);
  return undefined;
}

/** One simple command: its words, its redirections and any here-document fed to it. */
type Simple = { words: Word[]; redirs: { op: string; fd: string; target: Word | null }[]; heredocs: string[] };

function simpleCommands(tokens: Token[]): Simple[] {
  const list: Simple[] = [];
  let cur: Simple = { words: [], redirs: [], heredocs: [] };
  let lastWithHeredoc: Simple | null = null;
  const push = () => {
    if (cur.words.length || cur.redirs.length) list.push(cur);
    cur = { words: [], redirs: [], heredocs: [] };
  };
  for (let n = 0; n < tokens.length; n++) {
    const tok = tokens[n];
    if (!tok) continue;
    if (tok.k === "op") {
      if (SEPARATORS.has(tok.op)) push();
      continue;
    }
    if (tok.k === "heredoc") {
      (lastWithHeredoc ?? cur).heredocs.push(tok.body);
      continue;
    }
    if (tok.k === "redir") {
      if (tok.op === "<<" || tok.op === "<<-") {
        lastWithHeredoc = cur;
        continue;
      }
      const next = tokens[n + 1];
      const target = next?.k === "word" ? next.w : null;
      if (target) n++;
      cur.redirs.push({ op: tok.op, fd: tok.fd, target });
      continue;
    }
    cur.words.push(tok.w);
  }
  push();
  // A here-document's body is read after its line ends, by which time the
  // command it belongs to may have been pushed; `lastWithHeredoc` kept hold of it.
  return list;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Whole trees: nothing at or under these is an agent's to delete or overwrite. */
const SYSTEM_TREES = [
  "/dev", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/proc", "/sys", "/opt",
  "/System", "/Library", "/Applications", "/var", "/private/etc", "/private/var", "/snap", "/srv",
];

/** Under a system tree, but scratch: the system's own temporary folders, and the swap of a kururu build into place. */
const SCRATCH_UNDER = ["/var/folders", "/var/tmp", "/private/var/folders", "/private/var/tmp", "/Applications/Kururu.app"];

/** Homes and the folders that hold them: the folder and a home in it are refused, anything inside a home is the owner's business. */
const HOME_ROOTS = ["/home", "/Users", "/root"];

/** Devices a redirection is meant to write to. */
const WRITABLE_DEVICES = /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/[0-9]+|u?random)$/;

/** `/a/./b/../c//` → `/a/c`. Lexical only: the guard never touches the disk. */
export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Why an absolute path is a system one, or null. A path with a glob in it
 * is judged by the folder the glob is in, since `/*` names everything in
 * `/` and `/us*` would match `/usr`. Pure, for the test.
 */
export function systemPath(raw: string): string | null {
  if (!raw.startsWith("/")) return null;
  const glob = raw.search(/[*?[{]/);
  if (glob >= 0) {
    const dir = normalize(raw.slice(0, raw.lastIndexOf("/", glob) + 1) || "/");
    if (dir === "/") return "/";
    if (HOME_ROOTS.includes(dir)) return dir;
    if (SCRATCH_UNDER.some((s) => under(dir, s))) return null;
    // `/Applications/Kururu.app*` is the swap's staged copy and its old one.
    if (dir === "/Applications" && /^Kururu\.app/.test(raw.slice(dir.length + 1))) return null;
    return SYSTEM_TREES.find((root) => under(dir, root)) ?? null;
  }
  const path = normalize(raw);
  if (path === "/" || path === "/private") return path;
  if (SCRATCH_UNDER.some((s) => under(path, s))) return null;
  if (/^\/Applications\/Kururu\.app[^/]*(\/|$)/.test(path)) return null;
  const tree = SYSTEM_TREES.find((root) => under(path, root));
  if (tree) return path;
  for (const root of HOME_ROOTS) {
    if (path === root) return path;
    // A home itself: `/home/x`, `/Users/x`. `/root` is a home and has no homes in it.
    if (root !== "/root" && path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes("/")) return path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The verbs that delete or overwrite what they are pointed at. */
const DESTRUCTIVE = new Set(["rm", "rmdir", "unlink", "shred", "srm", "mv", "cp", "chmod", "chown", "chgrp", "truncate", "dd", "tee", "find", "rsync", "wipefs"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);

/** Options that take the next word as their value, per wrapper, so the command after them is found. */
const VALUED: Record<string, RegExp> = {
  sudo: /^-[ugCDhprtUT]$/,
  doas: /^-[uC]$/,
  env: /^-[uSC]$/,
  nice: /^-n$/,
  timeout: /^-[sk]$/,
  ionice: /^-[cnp]$/,
  caffeinate: /^-[tw]$/,
  xargs: /^-[IndPLEsa]$/,
  stdbuf: /^-[ioe]$/,
  exec: /^-a$/,
  chrt: /^-[p]$/,
  ssh: /^-[bcDEeFIiJLlmOopQRSWwB]$/,
  su: /^-[sgG]$/,
};

/** Strip a command of what runs it — `sudo`, `env X=1`, `nice`, `timeout 5`, `xargs -0` — down to the command itself. */
function unwrap(words: string[]): string[] {
  let w = words;
  for (let guard = 0; guard < 16; guard++) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? "")) w = w.slice(1);
    while (w.length && KEYWORDS.has(w[0] ?? "")) w = w.slice(1);
    const verb = base(w[0] ?? "");
    if (!["sudo", "doas", "env", "nice", "nohup", "time", "command", "builtin", "exec", "timeout", "stdbuf", "ionice", "caffeinate", "xargs", "chrt", "busybox", "unbuffer"].includes(verb)) return w;
    let n = 1;
    const valued = VALUED[verb];
    while (n < w.length) {
      const a = w[n] ?? "";
      if (a === "--") {
        n++;
        break;
      }
      if (verb === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        n++;
        continue;
      }
      if (!a.startsWith("-") || a === "-") break;
      n += valued?.test(a) ? 2 : 1;
    }
    // `timeout 5 cmd`, `chrt 10 cmd`: one positional before the command.
    if ((verb === "timeout" || verb === "chrt") && n < w.length) n++;
    w = w.slice(n);
  }
  return w;
}

/** `/bin/rm` → `rm`, `\rm` → `rm`, `mkfs.ext4` stays itself. */
function base(word: string): string {
  return word.replace(/^\\/, "").replace(/^.*\//, "");
}

/** The words of a verb that are operands, past its options; `valued` names the options that eat the next word. */
function operands(args: string[], valued?: RegExp): string[] {
  const out: string[] = [];
  let options = true;
  for (let n = 0; n < args.length; n++) {
    const a = args[n] ?? "";
    if (options && a === "--") {
      options = false;
      continue;
    }
    if (options && a.startsWith("-") && a !== "-") {
      if (valued?.test(a)) n++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function refuse(verb: string, path: string): string {
  return `kururu guard: refused \`${verb}\` aimed at ${path}, a system path. Use literal paths inside your own scratch folder or worktree.`;
}

function firstSystem(verb: string, paths: string[]): string | null {
  for (const p of paths) {
    const hit = systemPath(p);
    if (hit) return refuse(verb, hit === p ? p : `${p} (${hit})`);
  }
  return null;
}

/** The destructive verbs' own reading: which of their words they would destroy. */
function checkVerb(verb: string, args: string[]): string | null {
  if (/^(mkfs|newfs)/.test(verb)) return firstSystem(verb, args.filter((a) => a.startsWith("/")));
  if (!DESTRUCTIVE.has(verb)) return null;
  switch (verb) {
    case "rm":
    case "rmdir":
    case "unlink":
    case "srm":
    case "wipefs":
      return firstSystem(verb, operands(args));
    case "shred":
      return firstSystem(verb, operands(args, /^-[ns]$/));
    case "tee":
      return firstSystem(verb, operands(args));
    case "truncate":
      return firstSystem(verb, operands(args, /^-[sr]$/));
    case "mv": {
      const t = targetDir(args);
      return firstSystem(verb, [...operands(args, /^-[tS]$/), ...(t ? [t] : [])]);
    }
    case "cp": {
      const t = targetDir(args);
      const ops = operands(args, /^-[tS]$/);
      const dest = t ?? (ops.length > 1 ? ops.at(-1) : undefined);
      return dest ? firstSystem(verb, [dest]) : null;
    }
    case "chmod":
    case "chown":
    case "chgrp": {
      if (!args.some((a) => a === "--recursive" || /^-[A-Za-z]*R/.test(a))) return null;
      return firstSystem(`${verb} -R`, operands(args).slice(1));
    }
    case "dd":
      return firstSystem(verb, args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
    case "rsync": {
      if (!args.some((a) => /^--(delete|remove-source-files)/.test(a))) return null;
      const dest = operands(args).at(-1);
      return dest && !dest.includes(":") ? firstSystem(`${verb} --delete`, [dest]) : null;
    }
    case "find":
      return checkFind(args);
  }
  return null;
}

function targetDir(args: string[]): string | null {
  for (let n = 0; n < args.length; n++) {
    const a = args[n] ?? "";
    if (a === "-t") return args[n + 1] ?? null;
    if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
  }
  return null;
}

/** `find` is destructive with `-delete`, or an `-exec` of a destructive verb; then what it starts from is what it destroys. */
function checkFind(args: string[]): string | null {
  const starts: string[] = [];
  let n = 0;
  while (n < args.length && /^-[HLP]$/.test(args[n] ?? "")) n++;
  while (n < args.length && !/^[-(!]/.test(args[n] ?? "")) starts.push(args[n++] ?? "");
  let destructive = args.includes("-delete");
  for (let k = n; k < args.length; k++) {
    if (/^-(exec|execdir|ok|okdir)$/.test(args[k] ?? "")) {
      const inner = unwrap(args.slice(k + 1));
      const verb = base(inner[0] ?? "");
      if (DESTRUCTIVE.has(verb) || /^(mkfs|newfs)/.test(verb)) destructive = true;
    }
  }
  return destructive ? firstSystem("find", starts) : null;
}

/** Read a script and say why it is refused, or null. */
function checkScript(script: string, level: Level): string | null {
  if (level.depth > 8) return null;
  const tokens = tokenize(script);
  for (const cmd of simpleCommands(tokens)) {
    const why = checkSimple(cmd, level);
    if (why) return why;
  }
  return null;
}

function checkSimple(cmd: Simple, level: Level): string | null {
  const subs: string[] = [];
  const words = cmd.words.map((w) => expand(w, level, subs));
  // `X=/tmp/a` on its own is remembered for the words after it; in front of a command it is that command's only.
  if (words.length && words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) {
    for (const w of words) {
      const eq = w.indexOf("=");
      level.env.set(w.slice(0, eq), w.slice(eq + 1));
    }
  }
  // `for d in /etc /tmp/x; do rm -rf "$d"; done`: the loop's variable is
  // taken to be the worst of its words, since the body runs on each.
  if (words[0] === "for" && words[2] === "in" && words[1]) level.env.set(words[1], words.slice(3).find((w) => systemPath(w)) ?? words[3] ?? "");
  for (const r of cmd.redirs) {
    const target = r.target ? expand(r.target, level, subs) : "";
    if (/^(>|>>|>\||&>|&>>|<>)$/.test(r.op) || (r.op === ">&" && !/^([0-9]+|-)$/.test(target))) {
      if (target.startsWith("/") && !WRITABLE_DEVICES.test(normalize(target)) && systemPath(target)) return refuse(`${r.fd}${r.op}`, target);
    }
    if (r.op === "<<<") cmd.heredocs.push(target);
  }
  for (const sub of subs) {
    const why = checkScript(sub, { ...level, depth: level.depth + 1 });
    if (why) return why;
  }
  return checkWords(words, cmd.heredocs, level);
}

/** A command already split into words: the shell's, or the one handed to `docker exec`. */
function checkWords(raw: string[], heredocs: string[], level: Level): string | null {
  const words = unwrap(raw);
  const verb = base(words[0] ?? "");
  const args = words.slice(1);
  const deeper = (remote: boolean): Level => ({ remote: remote || level.remote, env: remote ? new Map() : new Map(level.env), depth: level.depth + 1 });
  const fed = (remote: boolean) => {
    for (const body of heredocs) {
      const why = checkScript(body, deeper(remote));
      if (why) return why;
    }
    return null;
  };

  if (SHELLS.has(verb) || (verb === "busybox" && SHELLS.has(args[0] ?? ""))) {
    const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (c >= 0) {
      const script = args.slice(c + 1).find((a) => !a.startsWith("-") || a === "-");
      return script === undefined ? null : checkScript(script, deeper(false));
    }
    return fed(false);
  }
  if (verb === "eval") return checkScript(args.join(" "), deeper(false));
  if (verb === "su") {
    const c = args.findIndex((a) => a === "-c" || a === "--command");
    if (c >= 0 && args[c + 1] !== undefined) return checkScript(args[c + 1] ?? "", deeper(false));
    return fed(false);
  }
  if (verb === "ssh") {
    // Options end at the host; everything after it is the far side's command line, `-rf` included.
    let n = 0;
    while (n < args.length && args[n]?.startsWith("-")) n += VALUED.ssh?.test(args[n] ?? "") ? 2 : 1;
    const remote = args.slice(n + 1);
    if (remote.length) return checkScript(remote.join(" "), deeper(true));
    return fed(true);
  }
  if (verb === "docker" || verb === "podman" || verb === "docker-compose") {
    let a = args;
    if (verb === "docker" && a[0] === "compose") a = a.slice(1);
    // `docker compose -f x.yml exec`: global options before the subcommand.
    while (a.length && a[0]?.startsWith("-")) a = a.slice(/^-(f|p|-file|-project-name|-env-file|-profile|H|-host|-context|c)$/.test(a[0] ?? "") ? 2 : 1);
    if (a[0] !== "exec") return null;
    const opts = /^(-e|--env|-u|--user|-w|--workdir|--env-file|--detach-keys|--index)$/;
    let n = 1;
    while (n < a.length && a[n]?.startsWith("-")) n += opts.test(a[n] ?? "") ? 2 : 1;
    const inner = a.slice(n + 1);
    return inner.length ? checkWords(inner, heredocs, deeper(true)) : fed(true);
  }
  if (verb === "kubectl" || verb === "oc") {
    const dash = args.indexOf("--");
    if (args[0] !== "exec" || dash < 0) return null;
    return checkWords(args.slice(dash + 1), heredocs, deeper(true));
  }
  return checkVerb(verb, args);
}

/**
 * Why this command line is refused, or null to let it run. `env` is the
 * environment the command would run in, for `$HOME` and `$TMPDIR`; any
 * other variable it does not hold is read as empty. Pure, for the test.
 */
export function guardRefusal(command: string, env: Record<string, string | undefined> = {}): string | null {
  const known = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") known.set(k, v);
  try {
    return checkScript(command, { remote: false, env: known, depth: 0 });
  } catch {
    // A line it cannot read is let through: see the header.
    return null;
  }
}

/**
 * The command a hook payload is about: Claude Code's and Codex's `Bash`
 * call (`tool_input.command`), Codex's argv form, or null for any other tool.
 */
export function commandOfPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const input = (p.tool_input ?? p.toolInput) as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return null;
  const command = input.command ?? input.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((a) => typeof a === "string")) {
    return command.map((a) => (/^[A-Za-z0-9_./=:@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
  }
  return null;
}
