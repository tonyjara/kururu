/**
 * The parts of `kururu child` that are text in and text out.
 *
 * The wizard's value is in being right about a machine it has never seen, and
 * a machine cannot be arranged from a test: an rc file that exports an API key
 * three ways, a `loginctl` from an older systemd, a unit written by last
 * month's wizard. So every decision that reads such a thing is a function of
 * the text, here, and `checks.mjs` only fetches the text. Plain JavaScript
 * like the rest of the command, because it runs on a box before anything is
 * built; `tools/test/kururu.test.ts` is its test.
 */

/** The names that outrank a Claude login and bill as API usage, or send the requests to another cloud. */
export const API_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Where a file of shell, systemd or fish sets one of `API_KEY_NAMES` to
 * something, as `{ name, line }` — never the value, which is the thing that
 * must not be printed. A comment, an `unset`, and an assignment of nothing
 * are not findings: `export ANTHROPIC_API_KEY=` is somebody clearing it.
 *
 * The forms are the ones people write: `NAME=…` and `export NAME=…` (sh,
 * bash, zsh, `environment.d`, `/etc/environment`), `Environment=NAME=…` and
 * `Environment="NAME=…"` (a unit, several to a line), `set -gx NAME …` (fish),
 * `NAME: …` is not one, since no shell reads it.
 */
export function scanForKeys(text, names = API_KEY_NAMES) {
  const found = [];
  const lines = String(text).split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    for (const name of names) {
      if (!line.includes(name)) continue;
      const sh = new RegExp(`(?:^|[\\s;&|])(?:export\\s+|declare\\s+-x\\s+|typeset\\s+-x\\s+|setenv\\s+)?${name}(?:=|\\s+(?=\\S))(\\S*)`);
      const unit = new RegExp(`(?:^|\\s|")${name}=([^"\\s]*)`);
      const fish = new RegExp(`^set\\s+(?:-[a-zA-Z]+\\s+)*${name}\\s+(\\S+)`);
      let value = null;
      if (line.startsWith("Environment=")) value = unit.exec(line.slice("Environment=".length))?.[1] ?? null;
      else if (line.startsWith("set ")) value = fish.exec(line)?.[1] ?? null;
      else if (!/^unset\s/.test(line)) {
        const match = sh.exec(line);
        // `setenv NAME value` (csh) has a space; every other form has the `=`.
        if (match) value = match[0].includes("=") || /setenv\s/.test(match[0]) ? match[1] : null;
      }
      if (value !== null && value.replace(/^["']|["']$/g, "") !== "") found.push({ name, line: index + 1 });
    }
  }
  return found;
}

/**
 * The same question of an environment that is already a map — this shell's,
 * or `systemctl --user show-environment`'s parsed — as the names set in it.
 */
export function keysInEnv(env, names = API_KEY_NAMES) {
  return names.filter((name) => typeof env[name] === "string" && env[name] !== "");
}

/** `systemctl --user show-environment`'s `NAME=value` lines as a map. Values with newlines come quoted and are not keys anyway. */
export function parseShowEnvironment(text) {
  const env = {};
  for (const line of String(text).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

/**
 * What a Claude settings file says that would take a pty off the login: an
 * `env` block naming one of the keys, and `apiKeyHelper`, which hands Claude
 * a key from a command. As names, not values.
 */
export function settingsKeys(json, names = API_KEY_NAMES) {
  if (!json || typeof json !== "object") return [];
  const found = [];
  const env = json.env && typeof json.env === "object" ? json.env : {};
  for (const name of names) if (typeof env[name] === "string" && env[name] !== "") found.push(`env.${name}`);
  if (typeof json.apiKeyHelper === "string" && json.apiKeyHelper.trim()) found.push("apiKeyHelper");
  return found;
}

/** `v26.12.0`, `26.12.0`, `bun 1.4.3` → `[26, 12, 0]`, or null. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** Whether `version` is at least `floor`, both as `parseVersion` returns them. */
export function atLeast(version, floor) {
  if (!version) return false;
  for (let i = 0; i < floor.length; i++) {
    const a = version[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** `loginctl show-user <name> -p Linger` or `--value`: `Linger=yes`, or `yes`. */
export function lingerOn(text) {
  return /^(?:Linger=)?yes$/m.test(String(text).trim());
}

/** Tailscale's range, 100.64.0.0/10, as `server/src/reach.ts` reads it. */
export function isTailnet(address) {
  const [a, b] = String(address).split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * This machine's tailnet address out of `os.networkInterfaces()`, the way the
 * server finds the one it binds to — `tailscale0` first when there is one,
 * since that is the interface's name on Linux, then any 100.64/10 address.
 * Never by running `tailscale`, which is the user's (CLAUDE.md rule 4).
 */
export function tailnetAddress(interfaces) {
  const v4 = (entries) => (entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal && isTailnet(entry.address));
  const named = v4(interfaces.tailscale0)[0];
  if (named) return named.address;
  for (const entries of Object.values(interfaces)) {
    const first = v4(entries)[0];
    if (first) return first.address;
  }
  return null;
}

/** Bridges and tunnels with nothing on them but this machine, as `server/src/reach.ts` keeps them out of the Share dialog. */
const NOT_A_LAN = /^(utun|ipsec|ppp|tun|tap|wg|bridge|br-|virbr|veth|vmnet|vboxnet|docker)/i;

/** The private IPv4 addresses a neighbour could reach and the tailnet's is not: the ones a child must not answer on. */
export function lanAddresses(interfaces) {
  const out = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (NOT_A_LAN.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || isTailnet(entry.address)) continue;
      const [a, b] = entry.address.split(".").map(Number);
      const private_ = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
      if (private_ && !out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}

/**
 * A value for a unit's `Environment=`, quoted when it has to be. systemd
 * splits the line on whitespace and takes `"…"` as one word, with `\"` and
 * `\\` inside; `%` is a specifier and is doubled.
 */
function unitWord(text) {
  const escaped = String(text).replace(/%/g, "%%");
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : escaped;
}

/**
 * The server's unit, as text. Pure, for the test and so that "has it
 * changed" is a string comparison with the file on disk.
 *
 * - `run.mjs --no-build`: the wizard and `child update` build, and a restart
 *   is then a restart, not a build that a half-pulled tree could fail.
 * - Node by its full path, because a service's PATH is not the login shell's
 *   and mise's shims are on the second.
 * - `PATH` is the one the wizard was run with, since the ptys' shells and the
 *   harness's `claude` start from the server's environment.
 * - `KURURU_BIND=tailscale` and `KURURU_LOOPBACK_TOKEN=1`, the child's two
 *   (`server/src/access.ts`); the isolation variables when the wizard was
 *   given any, so a throwaway instance's unit is as isolated as its run.
 * - The pre-start waits for the tailnet address, because at boot the unit can
 *   come up before `tailscaled` has one, and a server that started then
 *   binds loopback until somebody restarts it. `-` so a box with no tailnet
 *   still starts, and the record says why it is on loopback.
 * - `KillMode=process`: stopping the unit sends its signal to the runner
 *   alone, which stops its server. The pty host is in a unit of its own
 *   (`server/src/hostlaunch.ts`) and nothing here reaches it either way.
 */
export function unitText({ description, node, checkout, env }) {
  const lines = [
    "# Written by `kururu child setup`. Run it again rather than editing this:",
    "# it compares the file with what it would write, and rewrites it when they differ.",
    "[Unit]",
    `Description=${description}`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${unitWord(checkout)}`,
  ];
  for (const [name, value] of Object.entries(env)) lines.push(`Environment=${unitWord(`${name}=${value}`)}`);
  lines.push(
    `ExecStartPre=-${unitWord(node)} ${unitWord(`${checkout}/tools/kururu.mjs`)} child wait-tailnet`,
    `ExecStart=${unitWord(node)} ${unitWord(`${checkout}/server/run.mjs`)} --no-build`,
    "Restart=on-failure",
    "RestartSec=2",
    "KillMode=process",
    "TimeoutStopSec=15",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

/** `systemctl --user is-active`'s answer, which is the exit status's word: active, inactive, failed, activating. */
export function unitActive(text) {
  return String(text).trim() === "active";
}

/**
 * The newest modification time among `files` as `[path, mtimeMs]` pairs, and
 * whether `built` is older than it — "the build is older than the sources".
 * A missing build is stale. Pure; `checks.mjs` walks the directories.
 */
export function staleBuild(builtMs, sources) {
  if (builtMs === null) return { stale: true, newest: null };
  let newest = null;
  for (const [path, ms] of sources) if (!newest || ms > newest[1]) newest = [path, ms];
  return { stale: Boolean(newest && newest[1] > builtMs), newest: newest?.[0] ?? null };
}

/** The unit a pid's cgroup line puts it in, as `server/src/hostlaunch.ts` reads `/proc/<pid>/cgroup`. */
export function cgroupUnit(text) {
  for (const line of String(text).split("\n")) {
    const [, controllers, ...rest] = line.split(":");
    if (controllers !== "" && controllers !== "name=systemd") continue;
    const unit = rest
      .join(":")
      .split("/")
      .reverse()
      .find((part) => part.endsWith(".service") || part.endsWith(".scope"));
    if (unit) return unit;
  }
  return null;
}

/** Whether a unit name is a pty host's own, `kururu-ptyhost-<label>-<n>.service`. */
export function isHostUnit(unit) {
  return /^kururu-ptyhost-[0-9a-z]+-\d+\.service$/.test(String(unit ?? ""));
}

/**
 * The doctor's table. Each row is `{ title, state, detail, fix }` with state
 * `ok`, `fail` or `skip`; a failure carries its fix on the line under it, so
 * the person reading knows what to type without reading the wizard's prose.
 * `paint` colours a mark and is the identity when nobody is looking.
 */
export function table(rows, paint = (_state, text) => text) {
  const mark = { ok: "✓", fail: "✗", skip: "–" };
  const width = Math.max(0, ...rows.map((row) => row.title.length)) + 2;
  const out = [];
  for (const row of rows) {
    out.push(`  ${paint(row.state, mark[row.state] ?? "?")} ${row.title.padEnd(width)}${row.detail ?? ""}`);
    if (row.state === "fail" && row.fix) out.push(`    ${" ".repeat(width)}→ ${row.fix}`);
  }
  return out;
}

/** The exit status the doctor gives a set of rows: 1 when any failed. */
export function doctorExit(rows) {
  return rows.some((row) => row.state === "fail") ? 1 : 0;
}

/**
 * `--name=value`, `--name value` and bare `--flag` into a map, the rest as
 * words. Hand-rolled because the command runs before `bun install` and so
 * cannot have a dependency.
 */
export function parseArgs(argv, valued = []) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (valued.includes(arg.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[arg.slice(2)] = argv[++i];
    else flags[arg.slice(2)] = true;
  }
  return { flags, words };
}


/**
 * Where this node stands with the Mac, from `/api/health`'s `nodes`:
 * `unknown` for a server from before nodes, `alone` for one in no roster,
 * `parent` for one that pairs others, and for a child `linked` or `waiting`
 * — waiting being a parent that is away or not yet dialled, with its name
 * and since when. One reading, for the doctor's row and for `child join`'s
 * wait, so the two cannot disagree about what "paired" is.
 */
export function pairingState(health) {
  const nodes = health?.nodes;
  if (!nodes || typeof nodes.role !== "string") return { state: "unknown" };
  if (nodes.role === "alone") return { state: "alone" };
  const members = Array.isArray(nodes.nodes) ? nodes.nodes : [];
  if (nodes.role === "parent") return { state: "parent", count: members.length };
  const parent = members.find((node) => node?.parent);
  if (!parent) return { state: "waiting", parent: null, link: "connecting", since: null };
  if (parent.state === "up") return { state: "linked", parent: parent.name };
  return { state: "waiting", parent: parent.name, link: parent.state, since: typeof parent.since === "number" ? parent.since : null };
}

/**
 * The doctor's pairing row. Not paired is a `–`, never a `✗`: a child that
 * stands alone is a child working as built, and a doctor that failed it for
 * that would fail every standalone child forever. A parent that is *away* —
 * was linked, and went quiet — is a `–` too: that is a Mac with its lid
 * shut, which is the whole reason a child exists, and a doctor run after a
 * reboot at night must not exit 1 for it. Paired with a parent this node
 * has not reached since its server started is the `✗`, because then
 * something is wrong — the Mac unshared, a wrong address, the tailnet down.
 */
export function pairingRow(health, now = Date.now()) {
  const at = pairingState(health);
  switch (at.state) {
    case "unknown":
      return { title: "pairing", state: "skip", detail: health ? "this server is from before pairing — kururu child update" : "no server to ask" };
    case "alone":
      return { title: "pairing", state: "skip", detail: "not paired with a Mac (optional) — the Mac's Settings → Nodes → Add a computer shows the command to run here" };
    case "parent":
      return { title: "pairing", state: "skip", detail: `the parent of ${at.count} node${at.count === 1 ? "" : "s"}, not a child` };
    case "linked":
      return { title: "pairing", state: "ok", detail: `paired with ${at.parent}, linked` };
    default: {
      if (at.link === "away") {
        return { title: "pairing", state: "skip", detail: `paired with ${at.parent ?? "a parent"}, away${at.since ? ` for ${ago(now - at.since)}` : ""} — as it is while its lid is shut; the link comes back by itself` };
      }
      return {
        title: "pairing",
        state: "fail",
        detail: `paired with ${at.parent ?? "a parent this roster does not name"}, ${at.link}`,
        fix: "is the Mac awake, with sharing on? Its Settings → Nodes says whether a node can reach it; the link comes back by itself",
      };
    }
  }
}

/** A duration as a person says it: "40 s", "12 min", "3 h". */
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/**
 * The Claude token this child holds from its parent, out of
 * `secrets-held.json` — `{ kind, hint }`, or null. The file has kinds,
 * hints and digests and never a value, which is why the doctor may read it.
 */
export function lentClaude(held) {
  const entries = held && typeof held === "object" && held.held && typeof held.held === "object" ? Object.entries(held.held) : [];
  const found = entries.find(([kind, entry]) => kind.startsWith("claude-token:") && entry && typeof entry.hint === "string");
  return found ? { kind: found[0], hint: found[1].hint } : null;
}

/**
 * The doctor's secrets row: what this child holds from its parent, by
 * kind and hint. Nothing lent is a `–` — lending is optional, a child signed
 * in with its own `/login` needs none of it — unless the wizard was told
 * Claude would be lent, and it has not been: then the agents have no login,
 * and that is the `✗`.
 */
export function heldRows(held, { paired, parent, name, claudeLent, isParent = false }) {
  const from = parent ?? "the Mac";
  const where = `${from}'s Settings → Nodes → ${name ?? "this node"} → Secrets`;
  if (isParent) return [{ title: "secrets", state: "skip", detail: "the parent: it lends secrets, and holds none from another node" }];
  if (!paired) return [{ title: "secrets", state: "skip", detail: "not paired, so nothing is lent" }];
  const entries = held && typeof held === "object" && held.held && typeof held.held === "object" ? Object.entries(held.held) : [];
  const rows = [
    entries.length
      ? { title: "secrets", state: "ok", detail: `held from ${from}: ${entries.map(([kind, entry]) => `${kind} ${entry?.hint ?? ""}`.trim()).join(", ")}` }
      : { title: "secrets", state: "skip", detail: `nothing held from ${from} (optional) — switch them on in ${where}` },
  ];
  if (claudeLent && !lentClaude(held)) {
    rows.push({
      title: "claude token",
      state: "fail",
      detail: `Claude is to be lent by ${from}, and is not held yet`,
      fix: `on ${from}: Settings → Agents → Lend this login to a node, then ${where} → Claude login, as a token`,
    });
  }
  return rows;
}
