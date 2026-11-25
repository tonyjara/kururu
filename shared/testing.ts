/**
 * Knowing a test run when an agent makes one, from nothing but the command
 * line it was going to run anyway.
 *
 * The owner asked to see testing the way usage is seen: whether something is
 * testing, what kind, how many tests, how long, and what it cost, "in a
 * performant way that makes sense and doesn't burn tokens keeping track of
 * this". So nothing here is asked of an agent. A test run is a tool call, and
 * kururu already sees every tool call twice: the hook that runs before each
 * one, and the transcript line the usage ledger parses for its tokens. This
 * module is what both of them ask, and it is pure so that a hook's process,
 * the server's reader and the tests all get the same answer.
 *
 * Three questions. **Is this command a test, and of what kind**
 * (`classifyCommand`): by the program at the head of each part of the line,
 * never by a word that merely appears in it, or `git commit -m "fix tests"`
 * would be a test run. **What may be kept of it** (`redactCommand`): the part
 * that is the test, with anything shaped like a secret taken out, because a
 * command line is the one piece of text this feature writes down. **How did
 * it go** (`parseTestCounts`): the summary line a runner prints, read for
 * three numbers; the output itself is never kept anywhere.
 *
 * Typecheck, lint and build are kinds here beside the tests proper. A
 * project with no test suite still spends its agents' minutes somewhere, and
 * the page that answers "are our tests too slow" should not go blank for it.
 *
 * Rejected: asking the runner. A reporter plugin per framework would give
 * exact counts and would have to be installed in every project, by an agent,
 * with tokens. The summary line is already on the screen.
 */

export type TestKind = "unit" | "e2e" | "typecheck" | "lint" | "build" | "simulator" | "check";

export const TEST_KINDS: readonly TestKind[] = ["unit", "e2e", "simulator", "typecheck", "lint", "build", "check"];

export function isTestKind(value: unknown): value is TestKind {
  return typeof value === "string" && (TEST_KINDS as readonly string[]).includes(value);
}

/** What the page calls each kind. */
export const KIND_LABEL: Record<TestKind, string> = {
  unit: "Unit",
  e2e: "End to end",
  simulator: "Simulator",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
  check: "Check",
};

/**
 * Which kind names a call that holds several. One Bash call is one stretch of
 * time and cannot be split between its parts, so `tsc && vitest` is a unit
 * run that also typechecked: the heavier part is what the minutes went on.
 */
const KIND_WEIGHT: Record<TestKind, number> = { simulator: 6, e2e: 5, unit: 4, check: 3, build: 2, typecheck: 1, lint: 0 };

/** The kinds a project with no test suite is not expected to run. See `Workspace.loose`. */
export function isSuiteKind(kind: TestKind): boolean {
  return kind === "unit" || kind === "e2e" || kind === "simulator";
}

/** A command line read as a test run. */
export interface TestCall {
  kind: TestKind;
  /** The program that ran it: `vitest`, `playwright`, `tsc`, or `script` when a package script did not say. */
  runner: string;
  /** What runs of the same thing are grouped by: `pnpm chat:e2e`, `bun test`, `tsc (tsconfig.js.json)`. */
  suite: string;
  /** The parts of the line that are the run, redacted, for a person to read. */
  command: string;
  /** Whether it named files or a filter, and so is not the whole suite: its time says nothing about the suite's. */
  focused: boolean;
}

export const MAX_COMMAND = 240;
export const MAX_SUITE = 96;
/** A command longer than this is read only this far. Nothing that is a test run is a heredoc of kilobytes. */
const MAX_READ = 8192;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_FLAG =
  /(--?[A-Za-z-]*(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|credential|private[-_]?key|access[-_]?key|bearer|cookie|session|dsn|database[-_]?url|connection[-_]?string|header)[A-Za-z-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s-]\S*)/gi;
const TOKEN_SHAPES =
  /\b(?:(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?|whsec_[A-Za-z0-9]{10,}|re_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,})/g;
/** Anything long with both letters and digits in it. A long test name with a number in it goes too, which is the right side to be wrong on. */
const LONG_RUN = /[A-Za-z0-9_+=-]{32,}/g;

/**
 * A command line with what looks like a secret taken out. Pure, and run on
 * both sides of the socket: the hook redacts before it sends and the server
 * redacts what it is sent, since a hook is whatever script a settings file
 * names.
 *
 * `NAME=value` loses every value, not only the ones that look secret: an
 * environment variable on a command line is where a key most often is, and
 * knowing that `E2E=1` was set is not worth guessing which values are safe.
 */
export function redactCommand(text: string): string {
  return text
    .replace(/(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g, "$1$2=…")
    .replace(SECRET_FLAG, "$1$2…")
    .replace(/(-H)\s+("[^"]*"|'[^']*'|\S+)/g, "$1 …")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1…@")
    .replace(/([?&][A-Za-z0-9_.-]+)=[^&\s'"]+/g, "$1=…")
    .replace(TOKEN_SHAPES, "…")
    .replace(LONG_RUN, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "…" : run))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMMAND);
}

// ---------------------------------------------------------------------------
// Reading a command line
// ---------------------------------------------------------------------------

/** The line without the bodies of its heredocs: a script written to a file is not a script being run. */
function withoutHeredocs(command: string): string {
  if (!command.includes("<<")) return command;
  const out: string[] = [];
  let until: string | null = null;
  for (const line of command.split("\n")) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      continue;
    }
    out.push(line);
    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (opened) until = opened[2]!;
  }
  return out.join("\n");
}

/**
 * A command line as the simple commands in it, split where a shell would run
 * one after another: `&&`, `||`, `;`, `|`, `&`, a newline, and the brackets
 * of a subshell. Quotes are honoured and kept. `2>&1` is not a split.
 */
export function commandParts(command: string): string[] {
  const text = withoutHeredocs(command.slice(0, MAX_READ));
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "\\" && i + 1 < text.length) {
      // A line continued is one line.
      current += text[i + 1] === "\n" ? " " : c + text[i + 1];
      i++;
    } else if (c === "&" && (text[i - 1] === ">" || text[i + 1] === ">")) {
      current += c;
    } else if (c === "&" || c === "|") {
      if (text[i + 1] === c) i++;
      push();
    } else if (c === ";" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      push();
    } else {
      current += c;
    }
  }
  push();
  return out;
}

/** One simple command as words, quotes off. Redirections are not words of the command. */
function words(part: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let any = false;
  const push = () => {
    if (any) out.push(current);
    current = "";
    any = false;
  };
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < part.length) current += part[++i];
      else current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      any = true;
    } else if (/\s/.test(c)) {
      push();
    } else {
      current += c;
      any = true;
    }
  }
  push();
  const kept: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const word = out[i]!;
    if (/^\d*(?:>>?|<)&?\d*-?$/.test(word)) {
      // A bare `>` takes the word after it.
      if (!/&\d/.test(word)) i++;
      continue;
    }
    if (/^\d*(?:>>?|<|&>)/.test(word)) continue;
    kept.push(word);
  }
  return kept;
}

function baseName(word: string): string {
  const cut = word.lastIndexOf("/");
  return (cut === -1 ? word : word.slice(cut + 1)).toLowerCase();
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Programs that run another program and are not themselves the run. */
const PREFIXES = new Set(["time", "command", "exec", "nohup", "sudo", "caffeinate", "xcrun", "nice", "stdbuf", "unbuffer", "script"]);
/** Programs whose own words end at `--`, with the real command after it. */
const DASH_WRAPPERS = new Set(["vault", "slot", "ios-q", "doppler", "dotenv", "dotenvx", "op", "mise", "infisical", "with-env", "cross-env", "env-cmd"]);
/** Package runners that execute a binary by name. */
const BIN_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** `<these> <verb> <program…>`. */
const EXEC_VERBS: Record<string, readonly string[]> = {
  pnpm: ["exec", "dlx"],
  yarn: ["exec", "dlx"],
  npm: ["exec", "x"],
  bun: ["x"],
  uv: ["run"],
  poetry: ["run"],
  pipenv: ["run"],
  pdm: ["run"],
  hatch: ["run"],
  bundle: ["exec"],
  rye: ["run"],
};

/** Flags whose value names a different suite: a config, a project, a scheme. */
const SCOPE_FLAGS = new Set(["-c", "--config", "--project", "-p", "--filter", "-F", "-C", "--cwd", "--dir", "--prefix", "-scheme", "-workspace", "--workspace", "-w", "--tsconfig", "--root"]);
/** Flags that take a value which is neither a scope nor a file to test. */
const VALUE_FLAGS = new Set([
  "--reporter", "--workers", "-j", "--jobs", "--timeout", "--shard", "--bail", "--maxWorkers", "--max-workers", "--retries", "--repeat-each",
  "-destination", "-sdk", "-configuration", "-derivedDataPath", "-resultBundlePath", "--outDir", "--outdir", "--out-dir", "--coverage-reporter",
  "--testTimeout", "--test-timeout", "--pool", "--env", "--environment", "--mode", "--port", "--host", "--seed", "--color", "--output", "-o",
  "--format", "-f", "--parallel", "--concurrency", "--log-level", "--loglevel", "--device", "--udid", "--target", "--platform", "--preload", "-r", "--require", "--import", "--loader",
]);
/** Flags that narrow a run to some of its tests. */
const FOCUS_FLAGS = new Set(["-t", "--grep", "-g", "-k", "--testNamePattern", "--test-name-pattern", "-run", "--only", "--tests", "--testPathPattern", "--changed", "--onlyChanged", "--related", "--last-failed", "--lf", "--include-tags", "--tags"]);

interface Seen {
  kind: TestKind;
  runner: string;
  /** The suite's name before its scope is added. */
  name: string;
  /** How many leading words are the command itself, before its arguments. */
  taken: number;
}

function kindByName(name: string): TestKind | null {
  const n = name.toLowerCase();
  if (/maestro|detox/.test(n) || /(e2e|test).*(ios|android|simulator)|(ios|android|simulator).*(e2e|test)/.test(n)) return "simulator";
  if (/e2e|end-to-end|integration|playwright|cypress|acceptance/.test(n)) return "e2e";
  if (/type-?check|check-?types|(^|[:_.-])(tsc|types|typings)([:_.-]|$)/.test(n)) return "typecheck";
  if (/lint|eslint|biome|prettier|stylelint|(format|fmt)[:_.-]?check/.test(n)) return "lint";
  if (/(^|[:_.-])(test|tests|spec|specs|unit|vitest|jest|coverage|cov)([:_.-]|$)/.test(n)) return "unit";
  if (/(^|[:_.-])(build|compile|bundle|dist|codegen|typegen)([:_.-]|$)/.test(n)) return "build";
  if (/(^|[:_.-])(check|checks|verify|validate|contract|contracts|smoke|ci|doctor|preflight|precommit|pre-commit)([:_.-]|$)/.test(n)) return "check";
  return null;
}

const SIMPLE_RUNNERS: Record<string, TestKind> = {
  vitest: "unit", jest: "unit", mocha: "unit", ava: "unit", tap: "unit", uvu: "unit", jasmine: "unit", karma: "unit",
  pytest: "unit", "py.test": "unit", tox: "unit", nox: "unit", rspec: "unit", phpunit: "unit", pest: "unit", unittest: "unit",
  wdio: "e2e",
  tsc: "typecheck", "vue-tsc": "typecheck", tsgo: "typecheck", "svelte-check": "typecheck", pyright: "typecheck", mypy: "typecheck", flow: "typecheck",
  eslint: "lint", oxlint: "lint", stylelint: "lint", rubocop: "lint", swiftlint: "lint", "golangci-lint": "lint", shellcheck: "lint",
  knip: "lint", markdownlint: "lint", ktlint: "lint", flake8: "lint", pylint: "lint",
  webpack: "build", rollup: "build", tsup: "build", unbuild: "build", "electron-builder": "build", tsdown: "build",
};

/** `<program> <verb>` and what the verb is. A verb not listed is not a run. */
const VERB_RUNNERS: Record<string, Record<string, TestKind>> = {
  playwright: { test: "e2e" },
  cypress: { run: "e2e" },
  go: { test: "unit", vet: "lint", build: "build" },
  cargo: { test: "unit", nextest: "unit", clippy: "lint", check: "typecheck", build: "build" },
  deno: { test: "unit", lint: "lint", check: "typecheck" },
  swift: { test: "unit", build: "build" },
  dotnet: { test: "unit", build: "build" },
  mix: { test: "unit", compile: "build", credo: "lint", dialyzer: "typecheck" },
  rails: { test: "unit" },
  rake: { test: "unit", spec: "unit" },
  next: { build: "build", lint: "lint" },
  vite: { build: "build" },
  astro: { build: "build", check: "typecheck" },
  nuxt: { build: "build", typecheck: "typecheck" },
  expo: { "run:ios": "build", "run:android": "build", prebuild: "build", export: "build" },
  eas: { build: "build" },
  maestro: { test: "simulator" },
  detox: { test: "simulator", build: "build" },
  biome: { lint: "lint", check: "lint", ci: "lint" },
  ruff: { check: "lint" },
  mvn: { test: "unit", verify: "unit", package: "build", compile: "build", install: "build" },
  docker: { build: "build" },
  parcel: { build: "build" },
  esbuild: {},
};

/** Subcommands of a package manager that are its own and not a script's name. */
const MANAGER_OWN = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "dlx", "exec", "x", "store", "why", "list", "ls", "outdated", "audit", "publish",
  "pack", "link", "unlink", "rebuild", "prune", "init", "create", "config", "env", "setup", "import", "dedupe", "patch", "patch-commit", "deploy", "fetch",
  "approve-builds", "self-update", "licenses", "root", "bin", "cache", "set", "plugin", "npm", "node", "info", "view", "login", "logout", "whoami", "pm", "upgrade-interactive",
  "version", "help", "start", "dev", "serve", "preview", "watch", "repl", "completion", "doctor", "workspaces", "workspace",
]);

/** A package manager's line: which script it runs, past its own flags. */
function managerScript(manager: string, rest: readonly string[]): { script: string; taken: number; scope: string | null } | null {
  let scope: string | null = null;
  let i = 0;
  const flags = () => {
    for (; i < rest.length; i++) {
      const word = rest[i]!;
      if (!word.startsWith("-")) return;
      if (SCOPE_FLAGS.has(word) && i + 1 < rest.length) scope ??= rest[++i]!;
      else if (/^--(filter|cwd|dir|prefix)=/.test(word)) scope ??= word.slice(word.indexOf("=") + 1);
    }
  };
  flags();
  let verb = rest[i];
  if (verb === undefined) return null;
  if (manager === "yarn" && verb === "workspace" && rest[i + 2] !== undefined) {
    scope ??= rest[i + 1]!;
    i += 2;
    verb = rest[i];
  }
  if (verb === "run" || verb === "run-script") {
    i++;
    flags();
    verb = rest[i];
  } else if (manager === "npm" && (verb === "test" || verb === "t" || verb === "tst")) {
    return { script: "test", taken: i + 1, scope };
  } else if (manager === "npm") {
    // `npm <anything else>` is npm's own.
    return null;
  }
  if (verb === undefined || verb.startsWith("-")) return null;
  // `pnpm test` and `yarn build` are scripts; `pnpm install` is not.
  if (MANAGER_OWN.has(verb) && rest[i - 1] !== "run" && rest[i - 1] !== "run-script") return null;
  return { script: verb, taken: i + 1, scope };
}

/** A script handed to an interpreter: read by its file's name, since nothing else says what it does. */
function scriptFile(path: string): Seen | null {
  const base = baseName(path);
  if (!/\.(m?[jt]s|cjs|sh|bash|zsh|py|rb|php)$/.test(base) && path.indexOf("/") === -1) return null;
  const kind = kindByName(base.replace(/\.[a-z]+$/, ""));
  return kind ? { kind, runner: "script", name: base, taken: 1 } : null;
}

function heavier(name: string, args: readonly string[], kind: TestKind): TestKind {
  // A unit runner pointed at an e2e config or folder is running e2e.
  if (kind !== "unit") return kind;
  return args.some((arg) => /e2e|integration|playwright/i.test(arg)) ? "e2e" : kind;
}

/** What one simple command is, given its words with the wrappers already off. */
function seen(all: readonly string[]): Seen | null {
  const head = all[0];
  if (head === undefined) return null;
  const program = baseName(head).replace(/\.(m?js|cjs|exe)$/, "");
  const rest = all.slice(1);
  const verb = rest.find((word) => !word.startsWith("-"));

  if (program === "bun") {
    if (verb === "test") return { kind: heavier(program, rest, "unit"), runner: "bun", name: "bun test", taken: 1 + rest.indexOf("test") + 1 };
    if (verb === "build") return { kind: "build", runner: "bun", name: "bun build", taken: 1 + rest.indexOf("build") + 1 };
  }
  if (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun") {
    const found = managerScript(program, rest);
    if (!found) return null;
    // `bun file.ts` runs a file, where `pnpm name` runs a script.
    if (program === "bun" && /[./]/.test(found.script) && rest[found.taken - 2] !== "run") return scriptFile(found.script);
    const kind = kindByName(found.script);
    if (!kind) return null;
    return { kind, runner: "script", name: `${program} ${found.script}${found.scope ? ` (${baseName(found.scope)})` : ""}`, taken: 1 + found.taken };
  }
  if (program === "turbo" || program === "nx" || program === "lerna" || program === "moon") {
    const tasks = rest.filter((word) => !word.startsWith("-") && word !== "run" && word !== "run-many" && word !== "affected");
    const targets = rest.flatMap((word, i) => (word === "-t" || word === "--target" || word === "--targets" ? (rest[i + 1] ?? "").split(",") : []));
    for (const task of [...targets, ...tasks]) {
      const kind = kindByName(task.includes(":") && program === "nx" ? task.slice(task.indexOf(":") + 1) : task);
      if (kind) return { kind, runner: "script", name: `${program} ${task}`, taken: all.length };
    }
    return null;
  }
  if (program === "make" || program === "just" || program === "task" || program === "gmake") {
    const target = verb ?? (program === "make" || program === "gmake" ? "build" : undefined);
    const kind = target === undefined ? null : kindByName(target);
    return kind ? { kind, runner: "script", name: `${program} ${target}`, taken: all.length } : null;
  }
  if (program === "gradle" || program === "gradlew") {
    for (const task of rest) {
      if (task.startsWith("-")) continue;
      const leaf = task.slice(task.lastIndexOf(":") + 1);
      const kind: TestKind | null = /connected.*test/i.test(leaf) ? "simulator" : /test/i.test(leaf) ? "unit" : /^lint/i.test(leaf) ? "lint" : /^(assemble|build|bundle)/i.test(leaf) ? "build" : null;
      if (kind) return { kind, runner: "gradle", name: `gradle ${leaf}`, taken: all.length };
    }
    return null;
  }
  if (program === "xcodebuild") {
    const testing = rest.some((word) => word === "test" || word === "test-without-building");
    return { kind: testing ? "simulator" : "build", runner: "xcodebuild", name: testing ? "xcodebuild test" : "xcodebuild build", taken: 1 };
  }
  if (program === "node" || program === "nodejs") {
    if (rest.includes("--test")) return { kind: "unit", runner: "node", name: "node --test", taken: 1 + rest.indexOf("--test") + 1 };
    return verb ? shifted(scriptFile(verb), 1 + rest.indexOf(verb)) : null;
  }
  if (program === "python" || program === "python3" || /^python3\.\d+$/.test(program)) {
    const m = rest.indexOf("-m");
    if (m !== -1 && rest[m + 1] !== undefined) return shifted(seen(rest.slice(m + 1)), m + 2);
    if (verb && baseName(verb) === "manage.py") return rest[rest.indexOf(verb) + 1] === "test" ? { kind: "unit", runner: "django", name: "manage.py test", taken: all.length } : null;
    return verb ? shifted(scriptFile(verb), 1 + rest.indexOf(verb)) : null;
  }
  if (program === "tsx" || program === "ts-node" || program === "bash" || program === "sh" || program === "zsh" || program === "ruby" || program === "php" || program === "deno-run") {
    if (program === "php" && verb === "artisan") return rest[rest.indexOf(verb) + 1] === "test" ? { kind: "unit", runner: "artisan", name: "artisan test", taken: all.length } : null;
    // `bash -c "…"` is a line of its own, read by the caller.
    return verb && !rest.includes("-c") && !rest.includes("-lc") ? shifted(scriptFile(verb), 1 + rest.indexOf(verb)) : null;
  }
  if (program === "prettier" || program === "black" || program === "gofmt" || program === "rustfmt") {
    return rest.some((word) => word === "--check" || word === "-c" || word === "-l" || word === "--list-different") ? { kind: "lint", runner: program, name: `${program} --check`, taken: 1 } : null;
  }
  if (program === "ruff" && verb === "format") return rest.includes("--check") ? { kind: "lint", runner: "ruff", name: "ruff format --check", taken: 1 } : null;
  if (program === "cargo" && verb === "fmt") return rest.includes("--check") ? { kind: "lint", runner: "cargo", name: "cargo fmt --check", taken: 1 } : null;
  if (program === "docker" && (verb === "compose" || verb === "buildx")) {
    return rest.includes("build") ? { kind: "build", runner: "docker", name: `docker ${verb} build`, taken: all.length } : null;
  }
  const verbs = VERB_RUNNERS[program];
  if (verbs) {
    const kind = verb === undefined ? undefined : verbs[verb];
    if (!kind) return null;
    return { kind: heavier(program, rest, kind), runner: program, name: `${program} ${verb}`, taken: 1 + rest.indexOf(verb!) + 1 };
  }
  const simple = SIMPLE_RUNNERS[program];
  if (simple) return { kind: heavier(program, rest, simple), runner: program, name: program, taken: 1 };
  // `./scripts/e2e.sh`, run by its path.
  if (head.includes("/")) return scriptFile(head);
  return null;
}

function shifted(found: Seen | null, by: number): Seen | null {
  return found ? { ...found, taken: found.taken + by } : null;
}

/** The words of a command with what merely runs it taken off the front. */
function unwrapped(all: readonly string[]): string[] {
  let rest = [...all];
  for (let guard = 0; guard < 8; guard++) {
    while (rest.length && ASSIGNMENT.test(rest[0]!)) rest.shift();
    const head = rest[0];
    if (head === undefined) return rest;
    const program = baseName(head);
    if (program === "env") {
      rest.shift();
      while (rest.length && (rest[0]!.startsWith("-") || ASSIGNMENT.test(rest[0]!))) {
        if (rest[0] === "-u") rest.shift();
        rest.shift();
      }
    } else if (program === "timeout" || program === "gtimeout") {
      rest.shift();
      while (rest.length && rest[0]!.startsWith("-")) {
        if (/^-[sk]$/.test(rest[0]!)) rest.shift();
        rest.shift();
      }
      rest.shift();
    } else if (PREFIXES.has(program)) {
      rest.shift();
      while (rest.length && rest[0]!.startsWith("-")) rest.shift();
      if (program === "nice" && /^\d+$/.test(rest[0] ?? "")) rest.shift();
    } else if (DASH_WRAPPERS.has(program)) {
      const dash = rest.indexOf("--");
      if (dash === -1) return rest;
      rest = rest.slice(dash + 1);
    } else if (BIN_RUNNERS.has(program)) {
      rest.shift();
      while (rest.length && rest[0]!.startsWith("-")) {
        if (rest[0] === "-p" || rest[0] === "--package") rest.shift();
        rest.shift();
      }
    } else if (EXEC_VERBS[program]) {
      const verb = rest.findIndex((word, i) => i > 0 && !word.startsWith("-"));
      if (verb === -1 || !EXEC_VERBS[program]!.includes(rest[verb]!)) return rest;
      rest = rest.slice(verb + 1);
      if (rest[0] === "--") rest.shift();
      while (rest.length && rest[0]!.startsWith("-")) rest.shift();
    } else {
      return rest;
    }
  }
  return rest;
}

/** A scope and a focus read off a run's arguments. */
function argumentsOf(found: Seen, all: readonly string[]): { scope: string | null; focused: boolean } {
  const args = all.slice(found.taken);
  let scope: string | null = null;
  let focused = false;
  const narrows = found.kind === "unit" || found.kind === "e2e";
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") continue;
    const eq = word.indexOf("=");
    const flag = word.startsWith("-") && eq !== -1 ? word.slice(0, eq) : word;
    if (SCOPE_FLAGS.has(flag)) {
      const value = eq !== -1 && word.startsWith("-") ? word.slice(eq + 1) : args[++i];
      if (value !== undefined) scope ??= value;
    } else if (FOCUS_FLAGS.has(flag) || word.startsWith("-only-testing")) {
      focused = true;
      if (eq === -1) i++;
    } else if (VALUE_FLAGS.has(flag)) {
      if (eq === -1) i++;
    } else if (!word.startsWith("-") && narrows && !/^(run|watch|dev|related|ci|\.|\.\/\.\.\.)$/.test(word)) {
      // A word that is not a flag or a flag's value is a file, a folder or a name to run.
      focused = true;
    }
  }
  return { scope, focused };
}

/** One simple command, as the test run it is, or null. */
function classifyPart(part: string): TestCall | null {
  const all = unwrapped(words(part));
  // `bash -c "pnpm test"` and `sh -lc '…'`: the line inside is the command.
  const shell = all[0] !== undefined && /^(bash|sh|zsh)$/.test(baseName(all[0]));
  if (shell) {
    const c = all.findIndex((word) => /^-[a-z]*c$/.test(word));
    if (c !== -1 && all[c + 1] !== undefined) return classifyCommand(all[c + 1]!);
  }
  const found = seen(all);
  if (!found) return null;
  const { scope, focused } = argumentsOf(found, all);
  const named = scope && !found.name.includes("(") ? `${found.name} (${baseName(scope)})` : found.name;
  // What a person reads back: the words of the run itself, env names kept and values gone.
  const told = part.replace(/\s(?:\d*|&)(?:>>?|<)&?\s*\S*/g, " ");
  return { kind: found.kind, runner: found.runner, suite: redactCommand(named).slice(0, MAX_SUITE), command: redactCommand(told), focused };
}

/**
 * A command line, as the test run it is: null for one that runs no test,
 * typecheck, lint or build. Pure.
 *
 * Every part of the line is read and every part that is a run names the
 * suite, so `tsc && vitest` is `tsc + vitest`; the kind and the runner are the
 * heaviest part's. Parts that are not a run (`cd`, `tail`, `echo`) are
 * dropped from what is kept, which is also what keeps a heredoc, a commit
 * message and a `curl` with a key in it out of the record entirely.
 */
export function classifyCommand(command: unknown): TestCall | null {
  if (typeof command !== "string" || !command.trim()) return null;
  const found: TestCall[] = [];
  for (const part of commandParts(command)) {
    const call = classifyPart(part);
    if (call && !found.some((each) => each.suite === call.suite)) found.push(call);
    if (found.length >= 6) break;
  }
  const first = found[0];
  if (!first) return null;
  let lead = first;
  for (const each of found) if (KIND_WEIGHT[each.kind] > KIND_WEIGHT[lead.kind]) lead = each;
  const names = found.map((each) => each.suite);
  const suite = (names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names).join(" + ");
  return {
    kind: lead.kind,
    runner: lead.runner,
    suite: suite.slice(0, MAX_SUITE),
    command: found.map((each) => each.command).join(" && ").slice(0, MAX_COMMAND),
    focused: lead.focused,
  };
}

// ---------------------------------------------------------------------------
// How it went
// ---------------------------------------------------------------------------

export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** The runner the summary line belongs to, which names a package script's runner when its name did not. */
  runner?: string;
}

/** As much of an output's end as is read. A summary is at the bottom. */
const MAX_OUTPUT = 24_000;

/** `3 failed | 120 passed | 2 skipped`, or jest's commas, as counts. */
function tally(text: string): { passed: number; failed: number; skipped: number; any: boolean } {
  const out = { passed: 0, failed: 0, skipped: 0, any: false };
  for (const match of text.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending|errors?|xfailed|xpassed|deselected|ignored)\b/g)) {
    const n = Number(match[1]);
    const word = match[2]!;
    out.any = true;
    if (word === "passed" || word === "xpassed") out.passed += n;
    else if (word === "failed" || word.startsWith("error")) out.failed += n;
    else if (word !== "deselected") out.skipped += n;
  }
  return out;
}

function last(text: string, pattern: RegExp): RegExpMatchArray | null {
  let found: RegExpMatchArray | null = null;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}

function count(text: string, pattern: RegExp): number {
  let n = 0;
  for (const _ of text.matchAll(pattern)) n++;
  return n;
}

function num(value: string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

/**
 * The counts a runner's own summary states, or null when none is there to
 * read. Pure, and the only thing that ever looks at a test's output: the
 * numbers go on, the text is dropped where it was read.
 *
 * A summary is looked for in the order of how unmistakable its line is, and
 * a compiler's error count only when no test runner spoke, since a run of
 * both is judged by its tests.
 */
export function parseTestCounts(output: unknown): TestCounts | null {
  if (typeof output !== "string" || !output) return null;
  const text = output.slice(-MAX_OUTPUT).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  const vitest = last(text, /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/gm);
  if (vitest) {
    const t = tally(vitest[1]!);
    if (t.any) return { passed: t.passed, failed: t.failed, skipped: t.skipped, runner: "vitest" };
  }
  const jest = last(text, /^Tests:\s+(.+?)\s*(\d+) total\s*$/gm);
  if (jest) {
    const t = tally(jest[1]!);
    return { passed: t.passed, failed: t.failed, skipped: t.skipped, runner: "jest" };
  }
  const bunPass = last(text, /^\s*(\d+) pass\s*$/gm);
  const bunFail = last(text, /^\s*(\d+) fail\s*$/gm);
  if (bunPass || bunFail) {
    // Half a summary, as `| tail -1` leaves it, says only what it says: a count that was cut off is not a zero.
    return { passed: bunPass ? num(bunPass[1]) : null, failed: bunFail ? num(bunFail[1]) : null, skipped: num(last(text, /^\s*(\d+) skip\s*$/gm)?.[1]) + num(last(text, /^\s*(\d+) todo\s*$/gm)?.[1]), runner: "bun" };
  }
  const pytest = last(text, /^=+ (.*?) in [\d.]+s.*?=+\s*$/gm);
  if (pytest) {
    const t = tally(pytest[1]!);
    if (t.any) return { passed: t.passed, failed: t.failed, skipped: t.skipped, runner: "pytest" };
  }
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) {
    return { passed: cargo.reduce((n, m) => n + num(m[1]), 0), failed: cargo.reduce((n, m) => n + num(m[2]), 0), skipped: cargo.reduce((n, m) => n + num(m[3]), 0), runner: "cargo" };
  }
  const nodePass = last(text, /^[#ℹ] pass (\d+)\s*$/gm);
  if (nodePass) {
    return { passed: num(nodePass[1]), failed: num(last(text, /^[#ℹ] fail (\d+)\s*$/gm)?.[1]), skipped: num(last(text, /^[#ℹ] skipped (\d+)\s*$/gm)?.[1]), runner: "node" };
  }
  const xcode = last(text, /Executed (\d+) tests?, with (\d+) failures?/g);
  if (xcode) return { passed: num(xcode[1]) - num(xcode[2]), failed: num(xcode[2]), skipped: 0, runner: "xcodebuild" };
  const flowsPassed = last(text, /(\d+)\/(\d+) Flows? Passed/gi);
  const flowsFailed = last(text, /(\d+)\/(\d+) Flows? Failed/gi);
  if (flowsPassed || flowsFailed) {
    const passed = flowsPassed ? num(flowsPassed[1]) : num(flowsFailed![2]) - num(flowsFailed![1]);
    const failed = flowsFailed ? num(flowsFailed[1]) : num(flowsPassed![2]) - num(flowsPassed![1]);
    return { passed, failed, skipped: 0, runner: "maestro" };
  }
  const maven = last(text, /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g);
  if (maven) {
    const failed = num(maven[2]) + num(maven[3]);
    return { passed: num(maven[1]) - failed - num(maven[4]), failed, skipped: num(maven[4]), runner: "junit" };
  }
  const dotnet = last(text, /Failed:\s*(\d+), Passed:\s*(\d+), Skipped:\s*(\d+)/g);
  if (dotnet) return { passed: num(dotnet[2]), failed: num(dotnet[1]), skipped: num(dotnet[3]), runner: "dotnet" };
  const rspec = last(text, /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/gm);
  if (rspec) return { passed: num(rspec[1]) - num(rspec[2]) - num(rspec[3]), failed: num(rspec[2]), skipped: num(rspec[3]), runner: "rspec" };
  const phpunitOk = last(text, /^OK \((\d+) tests?,/gm);
  if (phpunitOk) return { passed: num(phpunitOk[1]), failed: 0, skipped: 0, runner: "phpunit" };
  const phpunit = last(text, /^Tests: (\d+), Assertions: \d+(.*)$/gm);
  if (phpunit) {
    const failed = num(/Failures: (\d+)/.exec(phpunit[2]!)?.[1]) + num(/Errors: (\d+)/.exec(phpunit[2]!)?.[1]);
    const skipped = num(/Skipped: (\d+)/.exec(phpunit[2]!)?.[1]);
    return { passed: num(phpunit[1]) - failed - skipped, failed, skipped, runner: "phpunit" };
  }
  // Playwright and mocha say it in a line of their own, indented, after the ones above have had their chance.
  const pwPassed = last(text, /^\s+(\d+) passed \([\d.]+(?:ms|s|m|h)\)\s*$/gm);
  const pwFailed = last(text, /^\s+(\d+) failed\s*$/gm);
  if (pwPassed || pwFailed) {
    return { passed: pwPassed ? num(pwPassed[1]) : null, failed: num(pwFailed?.[1]), skipped: num(last(text, /^\s+(\d+) skipped\s*$/gm)?.[1]), runner: "playwright" };
  }
  const passing = last(text, /^\s*(\d+) passing\b/gm);
  if (passing) return { passed: num(passing[1]), failed: num(last(text, /^\s*(\d+) failing\b/gm)?.[1]), skipped: num(last(text, /^\s*(\d+) pending\b/gm)?.[1]), runner: "mocha" };
  // go test: each test with -v, each package without.
  const goTests = count(text, /^\s*--- PASS:/gm) + count(text, /^\s*--- FAIL:/gm);
  if (goTests) return { passed: count(text, /^\s*--- PASS:/gm), failed: count(text, /^\s*--- FAIL:/gm), skipped: count(text, /^\s*--- SKIP:/gm), runner: "go" };
  const goOk = count(text, /^ok\s+[\w./-]+\s+(?:[\d.]+s|\(cached\))/gm);
  const goFail = count(text, /^FAIL\s+[\w./-]+\s+(?:[\d.]+s|\[)/gm);
  if (goOk || goFail) return { passed: goOk, failed: goFail, skipped: 0, runner: "go" };

  // No test runner spoke: a compiler's or a linter's count of what is wrong.
  const tsc = last(text, /Found (\d+) errors? in /g);
  if (tsc) return { passed: null, failed: num(tsc[1]), skipped: null, runner: "tsc" };
  const tsErrors = count(text, /\berror TS\d+:/g);
  if (tsErrors) return { passed: null, failed: tsErrors, skipped: null, runner: "tsc" };
  const eslint = last(text, /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/g);
  if (eslint) return { passed: null, failed: num(eslint[2]), skipped: null, runner: "eslint" };
  const biome = last(text, /^Found (\d+) errors?\.\s*$/gm);
  if (biome) return { passed: null, failed: num(biome[1]), skipped: null, runner: "biome" };
  return null;
}

export type TestOutcome = "pass" | "fail" | "stopped";

export function isTestOutcome(value: unknown): value is TestOutcome {
  return value === "pass" || value === "fail" || value === "stopped";
}

/**
 * Whether a run passed. The counts are asked before the exit code, because a
 * run piped through `tail` exits with `tail`'s zero whatever the tests did;
 * the exit code decides only when no summary was read. Null when neither is
 * known, which is a run in the background.
 */
export function outcomeOf(exit: number | null, counts: TestCounts | null, stopped: boolean): TestOutcome | null {
  if (stopped) return "stopped";
  if (counts?.failed) return "fail";
  if (exit !== null && exit !== 0) return "fail";
  if (exit === 0 || counts) return "pass";
  return null;
}

/** The exit code Claude Code's error text opens with, or null. `Exit code 1\n…`. */
export function exitCodeIn(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const found = /^(?:Error: )?Exit code (\d{1,3})\b/.exec(text.trimStart());
  return found ? Number(found[1]) : null;
}

/** Whether an errored tool result is the call never having run: the user said no, or stopped it. */
export function wasRefused(text: unknown): boolean {
  return typeof text === "string" && /^(?:Error: )?(?:The user doesn't want to proceed|\[Request interrupted|The tool use was rejected|Permission to use Bash)/.test(text.trimStart());
}

// ---------------------------------------------------------------------------
// What a hook says, and what a page is told
// ---------------------------------------------------------------------------

/** A run that is going on now, as an agent's row and card draw it. Never the command: a row is on every phone. */
export interface LiveTest {
  suite: string;
  kind: TestKind;
  /** When it started, as the server's clock had it. */
  since: number;
  /** In a workspace marked as having no test suite. See `Workspace.loose`. */
  loose?: boolean;
  /** How many more runs this agent has going beside this one. */
  more?: number;
}

/** What `report.mjs` adds to its report for a test's call. See `server/src/testing.ts`. */
export interface TestHookReport {
  phase: "start" | "end";
  session: string;
  callId: string;
  call: TestCall;
  background?: boolean;
  /** At the end: Claude Code's own measure of the call. */
  durationMs?: number | null;
  exit?: number | null;
  stopped?: boolean;
  counts?: TestCounts | null;
}

const HOOK_ID = /^[\w.:-]{1,128}$/;

function wholeOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : null;
}

/** Counts off a socket, held to their shape. */
export function adoptCounts(raw: unknown): TestCounts | null {
  if (!raw || typeof raw !== "object") return null;
  const { passed, failed, skipped, runner } = raw as Record<string, unknown>;
  const out: TestCounts = { passed: wholeOrNull(passed, 1e7), failed: wholeOrNull(failed, 1e7), skipped: wholeOrNull(skipped, 1e7) };
  if (out.passed === null && out.failed === null && out.skipped === null) return null;
  if (typeof runner === "string" && /^[\w.:-]{1,32}$/.test(runner)) out.runner = runner;
  return out;
}

/**
 * A hook's `test` field, read as untrusted: every string is held to its
 * shape and the command goes through `redactCommand` again, since what
 * posted it is whatever a settings file names. Null for anything else.
 */
export function adoptTestReport(raw: unknown): TestHookReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.phase !== "start" && r.phase !== "end") return null;
  if (typeof r.session !== "string" || !HOOK_ID.test(r.session) || typeof r.callId !== "string" || !HOOK_ID.test(r.callId)) return null;
  const c = r.call as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || !isTestKind(c.kind)) return null;
  if (typeof c.runner !== "string" || typeof c.suite !== "string" || typeof c.command !== "string" || !c.suite.trim()) return null;
  const call: TestCall = {
    kind: c.kind,
    runner: /^[\w.:-]{1,32}$/.test(c.runner) ? c.runner : "script",
    suite: redactCommand(c.suite).slice(0, MAX_SUITE),
    command: redactCommand(c.command),
    focused: c.focused === true,
  };
  const out: TestHookReport = { phase: r.phase, session: r.session, callId: r.callId, call, background: r.background === true };
  if (r.phase === "end") {
    out.durationMs = wholeOrNull(r.durationMs, 7 * 24 * 3600_000);
    out.exit = wholeOrNull(r.exit, 255);
    out.stopped = r.stopped === true;
    out.counts = adoptCounts(r.counts);
  }
  return out;
}

/** `2m10s`, `45s`, `1h04m`: a duration as a chip has room for. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** A suite's name as a chip says it: a package script without its manager, since `chat:e2e` is what it is called. */
export function chipName(suite: string): string {
  return suite.replace(/(^|\+ )(?:pnpm|npm|yarn|bun) (?!test\b|build\b)/g, "$1");
}
