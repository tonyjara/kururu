/**
 * Which tunnels are putting this machine on the internet, and whether the
 * address each one gave out still answers.
 *
 * A tunnel fails quietly. ngrok loses its session, cloudflared's quick tunnel
 * is ended with the shell it was typed into, the dev server behind one is
 * restarted onto another port — and nothing on the Mac says so, while
 * WhatsApp's webhooks and a TestFlight build pointed at the address go on
 * failing somewhere nobody is looking (the owner, 2026-11-13: "it'd be nice
 * to see our tunnels from the dev server as well to know that they are up").
 *
 * Found, not configured: the process table names the ngroks and cloudflareds
 * (`see`, on the dev scan's beat and off its `ps`), and each one is asked
 * what it is serving the way it answers best — ngrok's agent API
 * (`/api/tunnels`, on whatever port this agent bound, 4040 for the first),
 * cloudflared's metrics server (`/quicktunnel` and `/config`, on a port of
 * its own choosing), its config file for a named tunnel, and as a last
 * resort the URL it printed in the kururu terminal it runs in. The ports are
 * asked of `lsof` by pid, never guessed: a second ngrok is on 4041, and an
 * old cloudflared binds its metrics anywhere.
 *
 * Checked on two beats, because the obvious one would break what it watches.
 * ngrok's free plan is 20,000 requests a month, and a request a minute is
 * 43,200: the check alone would use up Holapy's webhooks' allowance by the
 * middle of the month. So every minute each tunnel is looked at locally —
 * its process, its agent still listing it, something listening on the port
 * it forwards to — and its public address is asked with a HEAD of `/` only
 * every `NGROK_PUBLIC_MS` for ngrok (four or five per cent of the plan), every
 * minute for Cloudflare, which counts nothing, and sooner than that for an
 * ngrok address that last said it was down. Any HTTP answer is up except the
 * tunnel's own error: ngrok's `ngrok-error-code` header, Cloudflare's 530, and
 * Cloudflare's 502–504, which is cloudflared reaching a port nobody answered.
 *
 * Kuru is told when a tunnel that was up goes down and stays down a second
 * look later, and when it comes back — through `harness.announce`, as
 * kururu's own line, never typed. A tunnel whose process ends is listed as
 * stopped for a while rather than dropped, so that its going is a thing seen.
 *
 * Read-only towards every tunnel: nothing here starts, stops or signals one.
 */
import { homedir } from "node:os";
import type { DevServer, Tunnel, TunnelHealth, TunnelKind } from "../../shared/wire";
import { TUNNEL_CHECK_MS } from "../../shared/wire";
import type { ProcRows } from "./proctable";

/** How often an ngrok address is asked from outside while it is answering. See the module's comment. */
export const NGROK_PUBLIC_MS = 30 * 60_000;
/** …and while it last said it was down, so that its coming back is seen. */
export const NGROK_DOWN_PUBLIC_MS = 5 * 60_000;
/** How long a tunnel whose process ended stays listed, as stopped. */
export const GONE_KEEP_MS = 30 * 60_000;
/** A tunnel just started may not have its address yet (a quick tunnel takes seconds): looked at again this soon. */
const EARLY_LOOK_MS = 10_000;
const EARLY_FOR_MS = 2 * 60_000;
/** Down this many looks in a row before Kuru hears of it: one timeout is a blip. */
const TELL_AFTER = 2;

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** What a command line says about the tunnel it starts, before anything is asked. */
export interface TunnelCommand {
  kind: TunnelKind;
  /** What it was told to forward to: `3006`, `localhost:3006`, `http://localhost:8080`. */
  target: string | null;
  /** The address it was told to take (`--url`, `--domain`), for ngrok. */
  url: string | null;
  /** cloudflared's `--config`, for a named tunnel's ingress. */
  config: string | null;
  /** A named cloudflared tunnel (`tunnel run`), whose addresses are in its config. */
  named: boolean;
}

/** Subcommands of ngrok that start a tunnel; anything else (`config`, `version`, `update`…) does not. */
const NGROK_TUNNELS = new Set(["http", "tls", "tcp", "start", "service"]);

function base(token: string): string {
  const cut = token.lastIndexOf("/");
  return (cut === -1 ? token : token.slice(cut + 1)).replace(/^['"]+|['"]+$/g, "").toLowerCase();
}

/** A flag's value, as `--url=x` or `--url x`; null when the flag is not there. */
function flag(tokens: readonly string[], ...names: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    for (const name of names) {
      if (token === name) return tokens[i + 1] ?? null;
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

/** ngrok's and cloudflared's flags that take a value, so the value is not read as a positional. */
const VALUE_FLAGS = new Set([
  "--url", "--domain", "--hostname", "--subdomain", "--config", "--authtoken", "--region", "--log", "--log-level",
  "--log-format", "--host-header", "--basic-auth", "--oauth", "--traffic-policy-file", "--metrics", "--token",
  "--loglevel", "--logfile", "--protocol", "--origincert", "--credentials-file", "--cred-file", "--name",
  "--edge-ip-version", "--pidfile", "--ha-connections",
]);

function positionals(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (!token.includes("=") && VALUE_FLAGS.has(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * Whether a command line starts a tunnel, and what it says about it. Only the
 * program itself, never something that mentions it: `ngrok` must be the
 * command (after `KEY=value` prefixes), so `grep ngrok` and an editor open on
 * `ngrok.yml` are nobody's tunnel. Pure, for the test.
 */
export function matchTunnel(args: string): TunnelCommand | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  const program = tokens[i] ? base(tokens[i]!) : "";
  const rest = tokens.slice(i + 1);
  const words = positionals(rest);
  if (program === "ngrok") {
    const sub = words[0];
    if (!sub || !NGROK_TUNNELS.has(sub)) return null;
    if (sub === "service" && words[1] !== "run") return null;
    const target = sub === "http" || sub === "tls" || sub === "tcp" ? (words[1] ?? null) : null;
    const asked = flag(rest, "--url", "--domain", "--hostname");
    const url = asked ? (/^[a-z]+:\/\//i.test(asked) ? asked : `https://${asked}`) : null;
    return { kind: "ngrok", target, url, config: null, named: false };
  }
  if (program === "cloudflared") {
    const target = flag(rest, "--url");
    const named = words[0] === "tunnel" && words.includes("run");
    if (!target && !named) return null;
    return { kind: "cloudflared", target, url: null, config: flag(rest, "--config"), named };
  }
  return null;
}

/**
 * A command line safe to show and to hand Kuru: a token, a password, an auth
 * string or a key, whether as `--flag value`, `--flag=value` or `VAR=value`,
 * is replaced by `…`. A named cloudflared tunnel is very often started with
 * `--token eyJ…`, which is the tunnel's credential and nothing to print.
 */
export function redactCommand(args: string): string {
  const secret = /token|auth|secret|password|passwd|key|credential/i;
  const tokens = args.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (eq !== -1 && secret.test(name) && (name.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      out.push(`${name}=…`);
      continue;
    }
    out.push(token);
    if (eq === -1 && token.startsWith("-") && secret.test(token) && i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) {
      out.push("…");
      i++;
    }
  }
  return out.join(" ").slice(0, 200);
}

/**
 * The port on this machine a target is, or null when it is somewhere else.
 * `3006`, `localhost:3006`, `http://127.0.0.1:3006/`, `http://localhost` (80).
 */
export function localPort(target: string | null): number | null {
  if (!target) return null;
  const bare = target.trim();
  if (/^\d+$/.test(bare)) return valid(Number(bare));
  const withScheme = /^[a-z]+:\/\//i.test(bare) ? bare : `http://${bare}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1", "0.0.0.0", ""].includes(host)) return null;
  if (url.port) return valid(Number(url.port));
  return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : null;
}

function valid(port: number): number | null {
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// ---------------------------------------------------------------------------
// What each tunnel says about itself
// ---------------------------------------------------------------------------

/** An address and what it forwards to, from wherever it was read. */
export interface Found {
  url: string;
  target: string | null;
}

/** ngrok's `/api/tunnels`. Null when the answer is not ngrok's. */
export function parseNgrokApi(body: unknown): Found[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { tunnels?: unknown }).tunnels)) return null;
  const out: Found[] = [];
  for (const item of (body as { tunnels: unknown[] }).tunnels) {
    if (!item || typeof item !== "object") continue;
    const url = (item as { public_url?: unknown }).public_url;
    const addr = (item as { config?: { addr?: unknown } }).config?.addr;
    if (typeof url !== "string" || !url) continue;
    out.push({ url, target: typeof addr === "string" ? addr : null });
  }
  // ngrok v2 listed an http and an https twin of every tunnel; the https is the one handed out.
  return out.filter((f) => !f.url.startsWith("http://") || !out.some((g) => g.url === f.url.replace(/^http:/, "https:")));
}

/** cloudflared's `/quicktunnel`: `{"hostname":"x.trycloudflare.com"}`, empty for a named tunnel. */
export function parseQuickTunnel(body: unknown): string | null {
  const host = body && typeof body === "object" ? (body as { hostname?: unknown }).hostname : null;
  return typeof host === "string" && /^[a-z0-9.-]+$/i.test(host) ? host : null;
}

export interface Ingress {
  hostname: string;
  service: string;
}

/** cloudflared's `/config`: the ingress rules it is running, a named tunnel's addresses among them. */
export function parseConfigIngress(body: unknown): Ingress[] {
  const config = body && typeof body === "object" ? (body as { config?: { ingress?: unknown } }).config : null;
  if (!config || !Array.isArray(config.ingress)) return [];
  const out: Ingress[] = [];
  for (const rule of config.ingress as unknown[]) {
    if (!rule || typeof rule !== "object") continue;
    const { hostname, service } = rule as { hostname?: unknown; service?: unknown };
    if (typeof service !== "string") continue;
    out.push({ hostname: typeof hostname === "string" ? hostname : "", service });
  }
  return out;
}

/**
 * The ingress rules of a cloudflared config file, read for the two keys that
 * matter rather than through a YAML library the server does not carry:
 * `- hostname: x` and the `service:` under it. A rule with no hostname is
 * the catch-all, which no address points at.
 */
export function parseIngressYaml(text: string): Ingress[] {
  const out: Ingress[] = [];
  let inIngress = false;
  let current: Partial<Ingress> | null = null;
  const flush = () => {
    if (current?.hostname && current.service) out.push({ hostname: current.hostname, service: current.service });
    current = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      flush();
      inIngress = /^ingress\s*:/.test(line);
      continue;
    }
    if (!inIngress) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      flush();
      current = {};
    }
    const pair = /^\s*(?:-\s*)?(hostname|service)\s*:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (pair && current) (current as Record<string, string>)[pair[1]!] = pair[2]!;
  }
  flush();
  return out;
}

/**
 * Addresses a tunnel printed in its terminal: cloudflared's boxed
 * `https://….trycloudflare.com`, and ngrok's `Forwarding  https://… ->
 * http://localhost:3006`. The last of each, since a restarted tunnel prints a
 * new one below the old.
 */
export function urlsOnScreen(text: string, kind: TunnelKind): Found[] {
  if (kind === "cloudflared") {
    const all = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return all?.length ? [{ url: all[all.length - 1]!, target: null }] : [];
  }
  const found = new Map<string, Found>();
  for (const m of text.matchAll(/Forwarding\s+(https?:\/\/\S+)\s+->\s+(\S+)/g)) {
    found.set(m[1]!, { url: m[1]!, target: m[2]! });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Whether it answers
// ---------------------------------------------------------------------------

export type Probe = { status: number; headers: Record<string, string> } | { error: string };

/** What ngrok's error codes mean, for the ones a tunnel's owner meets. */
const NGROK_ERRORS: Record<string, string> = {
  ERR_NGROK_3200: "ngrok says the endpoint is offline",
  ERR_NGROK_8012: "ngrok got through, but nothing answered on the port behind it",
  ERR_NGROK_3004: "ngrok got a broken answer from the port behind it",
  ERR_NGROK_727: "ngrok's monthly request limit is used up",
  ERR_NGROK_725: "ngrok's monthly data limit is used up",
};

/**
 * Whether the answer from a public address says the tunnel is up: any HTTP
 * response at all, except the tunnel's own word that it is not. Headers are
 * lower-cased by the caller. Pure, for the test.
 */
export function classifyProbe(probe: Probe): { up: boolean; why: string } {
  if ("error" in probe) return { up: false, why: `no answer from the address (${probe.error})` };
  const code = probe.headers["ngrok-error-code"];
  if (code) return { up: false, why: NGROK_ERRORS[code] ?? `ngrok error ${code}` };
  const cloudflare = (probe.headers.server ?? "").toLowerCase() === "cloudflare";
  if (probe.status === 530) return { up: false, why: "Cloudflare cannot reach the tunnel (530)" };
  if (cloudflare && probe.status >= 502 && probe.status <= 504) {
    return { up: false, why: `Cloudflare reached the tunnel, but nothing answered on the port behind it (${probe.status})` };
  }
  return { up: true, why: `HTTP ${probe.status}` };
}

/** When a tunnel's public address is next due a look, given the last one. */
export function publicDue(kind: TunnelKind, last: { at: number; up: boolean } | null, now: number): boolean {
  if (!last) return true;
  if (kind === "cloudflared") return now - last.at >= TUNNEL_CHECK_MS - 5_000;
  return now - last.at >= (last.up ? NGROK_PUBLIC_MS : NGROK_DOWN_PUBLIC_MS);
}

/**
 * The going-down and coming-back that Kuru is told of, one line of tunnels
 * (a kind and the port, or the address when there is no port) at a time:
 * a restarted ngrok is a new process and the same tunnel. Down is said only
 * of a line that was up since it was last said, and only once it has been
 * down `TELL_AFTER` looks in a row; back up only after a down was said.
 */
export interface Watch {
  wasUp: boolean;
  downLooks: number;
  told: boolean;
}

export function watchStep(watch: Watch, health: TunnelHealth): { watch: Watch; event: "down" | "up" | null } {
  if (health === "up") {
    return { watch: { wasUp: true, downLooks: 0, told: false }, event: watch.told ? "up" : null };
  }
  if (health === "unknown") return { watch, event: null };
  const downLooks = watch.downLooks + 1;
  if (watch.wasUp && !watch.told && downLooks >= TELL_AFTER) {
    return { watch: { wasUp: false, downLooks, told: true }, event: "down" };
  }
  return { watch: { ...watch, downLooks }, event: null };
}

export function lineOf(t: Pick<Tunnel, "kind" | "port" | "url">): string {
  return `${t.kind}:${t.port ?? t.url ?? "?"}`;
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

export interface TunnelDeps {
  /** The listening ports of these processes. `listenersOf` in `devservers.ts`. */
  listening: (pids: readonly number[]) => Promise<Map<number, number[]>>;
  /** A GET of a loopback port's JSON, or null. */
  localJson: (port: number, path: string) => Promise<unknown>;
  /** A HEAD of a public address. */
  probe: (url: string) => Promise<Probe>;
  /** Whether something on this machine accepts a connection on the port. */
  reachable: (port: number) => Promise<boolean>;
  /** A kururu terminal's screen as text, or null. */
  screen: (agentId: string) => Promise<string | null>;
  readText: (path: string) => Promise<string | null>;
  /** The list changed: push it. */
  changed: (tunnels: Tunnel[]) => void;
  /** A tunnel went down, or came back: tell Kuru. */
  tell: (tunnel: Tunnel, event: "down" | "up") => void;
  /**
   * When each address was last asked from outside, kept across a restart.
   * The server is restarted many times a day under `bun run dev`, and one
   * that forgot would ask every ngrok address again on each start — a
   * restart a minute for an afternoon of edits is the very request a minute
   * the half-hour beat is there to avoid.
   */
  asked?: { load: () => Promise<Record<string, unknown>>; save: (asked: Record<string, PublicLook>) => void };
  now?: () => number;
  home?: string;
}

export interface PublicLook {
  at: number;
  up: boolean;
  why: string;
}

/** A kept look, checked: anything else in the file is ignored. */
export function adoptLooks(raw: Record<string, unknown>): Map<string, PublicLook> {
  const out = new Map<string, PublicLook>();
  for (const [url, look] of Object.entries(raw)) {
    if (!look || typeof look !== "object") continue;
    const { at, up, why } = look as Record<string, unknown>;
    if (typeof at === "number" && Number.isFinite(at) && typeof up === "boolean" && typeof why === "string") out.set(url, { at, up, why });
  }
  return out;
}

interface Proc {
  pid: number;
  args: string;
  command: TunnelCommand;
  agentId?: string;
  firstSeen: number;
}

export class Tunnels {
  private procs = new Map<number, Proc>();
  private tunnels: Tunnel[] = [];
  private lastPublic = new Map<string, PublicLook>();
  private loaded: Promise<void> | null = null;
  private watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private lastJson = "[]";

  constructor(private readonly deps: TunnelDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  list(): Tunnel[] {
    return this.tunnels;
  }

  /**
   * The process table, on the dev scan's beat: which tunnels are running and
   * in which terminal. Only the table is read here, which the scan has
   * already paid for; a tunnel started or ended is looked at at once.
   * `roots` is each live terminal's process, by pid.
   */
  see(procs: ProcRows, roots: ReadonlyMap<number, string>): void {
    const next = new Map<number, Proc>();
    for (const row of procs.values()) {
      const command = matchTunnel(row.args);
      if (!command) continue;
      const known = this.procs.get(row.pid);
      next.set(row.pid, {
        pid: row.pid,
        args: row.args,
        command,
        agentId: terminalOf(row.pid, procs, roots),
        firstSeen: known?.args === row.args ? known.firstSeen : this.now(),
      });
    }
    const changed = next.size !== this.procs.size || [...next.keys()].some((pid) => !this.procs.has(pid));
    this.procs = next;
    if (changed) this.soon(1_000);
  }

  /** Begin the minute's beat. */
  start(): void {
    this.stopped = false;
    this.soon(2_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private soon(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  /** One look at every tunnel. Never two at once: one asked for mid-look runs when it ends. */
  async tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    let early = false;
    try {
      early = await this.look();
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.soon(0);
      } else {
        this.soon(early ? EARLY_LOOK_MS : TUNNEL_CHECK_MS);
      }
    }
  }

  /** Returns whether a tunnel just started is still without its address, to be looked at again soon. */
  private async look(): Promise<boolean> {
    this.loaded ??= (this.deps.asked?.load() ?? Promise.resolve({})).then(
      (raw) => {
        for (const [url, look] of adoptLooks(raw)) if (!this.lastPublic.has(url)) this.lastPublic.set(url, look);
      },
      () => undefined,
    );
    await this.loaded;
    const now = this.now();
    const procs = [...this.procs.values()];
    const ports = await this.deps.listening(procs.map((p) => p.pid)).catch(() => new Map<number, number[]>());
    const fresh: Tunnel[] = [];
    let early = false;
    await Promise.all(
      procs.map(async (proc) => {
        const found = await this.addressesOf(proc, ports.get(proc.pid) ?? []);
        if (!found.length) {
          if (now - proc.firstSeen < EARLY_FOR_MS) early = true;
          fresh.push(this.blank(proc, now));
          return;
        }
        for (const f of found) fresh.push(await this.check(proc, f, now));
      }),
    );

    // What was there and is not now: a process ended, or an address it no
    // longer serves. Kept, as stopped, unless the same line came back.
    const live = new Set(fresh.map((t) => t.id));
    const lines = new Set(fresh.filter((t) => t.health !== "gone").map(lineOf));
    for (const old of this.tunnels) {
      if (live.has(old.id) || lines.has(lineOf(old))) continue;
      const alive = this.procs.has(old.pid);
      if (old.health === "gone" && now - old.since > GONE_KEEP_MS) continue;
      fresh.push(
        old.health === "gone"
          ? old
          : {
              ...old,
              health: "gone",
              why: alive ? `${old.kind} no longer serves this address` : `${old.kind} is no longer running`,
              checkedAt: now,
              since: now,
            },
      );
    }
    fresh.sort((a, b) => (a.port ?? 1e6) - (b.port ?? 1e6) || a.id.localeCompare(b.id));

    // Tell Kuru what changed, one line of tunnels at a time.
    const byLine = new Map<string, Tunnel>();
    for (const t of fresh) {
      const have = byLine.get(lineOf(t));
      if (!have || score(t) < score(have)) byLine.set(lineOf(t), t);
    }
    for (const [line, t] of byLine) {
      const { watch, event } = watchStep(this.watches.get(line) ?? { wasUp: false, downLooks: 0, told: false }, t.health);
      this.watches.set(line, watch);
      if (event) this.deps.tell(t, event);
    }
    for (const line of [...this.watches.keys()]) if (!byLine.has(line)) this.watches.delete(line);
    for (const id of [...this.lastPublic.keys()]) if (!fresh.some((t) => t.url === id)) this.lastPublic.delete(id);

    this.tunnels = fresh;
    const json = JSON.stringify(fresh);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.deps.changed(fresh);
    }
    return early;
  }

  /** Every address a tunnel process serves, from the best source that answers. */
  private async addressesOf(proc: Proc, ports: readonly number[]): Promise<Found[]> {
    const { command } = proc;
    if (command.kind === "ngrok") {
      for (const port of ports) {
        const found = parseNgrokApi(await this.deps.localJson(port, "/api/tunnels").catch(() => null));
        if (found) return found.map((f) => ({ url: f.url, target: f.target ?? command.target }));
      }
      if (command.url) return [{ url: command.url, target: command.target }];
    } else {
      for (const port of ports) {
        const quick = parseQuickTunnel(await this.deps.localJson(port, "/quicktunnel").catch(() => null));
        const ingress = parseConfigIngress(await this.deps.localJson(port, "/config").catch(() => null));
        if (quick) return [{ url: `https://${quick}`, target: command.target ?? ingress[0]?.service ?? null }];
        const named = ingress.filter((r) => r.hostname);
        if (named.length) return named.map((r) => ({ url: `https://${r.hostname}`, target: r.service }));
      }
      if (command.named) {
        const home = this.deps.home ?? homedir();
        const paths = command.config ? [command.config.replace(/^~(?=\/)/, home)] : [`${home}/.cloudflared/config.yml`, `${home}/.cloudflared/config.yaml`];
        for (const path of paths) {
          const text = await this.deps.readText(path).catch(() => null);
          const rules = text ? parseIngressYaml(text) : [];
          if (rules.length) return rules.map((r) => ({ url: `https://${r.hostname}`, target: r.service }));
        }
      }
    }
    if (proc.agentId) {
      const text = await this.deps.screen(proc.agentId).catch(() => null);
      if (text) {
        const found = urlsOnScreen(text, command.kind);
        if (found.length) return found.map((f) => ({ url: f.url, target: f.target ?? command.target }));
      }
    }
    return [];
  }

  private base(proc: Proc, url: string | null, target: string | null): Omit<Tunnel, "health" | "why" | "checkedAt" | "publicAt" | "since"> {
    const port = localPort(target);
    return {
      id: `${proc.command.kind}:${proc.pid}:${url ?? port ?? "?"}`,
      kind: proc.command.kind,
      pid: proc.pid,
      url,
      port,
      target,
      command: redactCommand(proc.args),
      ...(proc.agentId ? { agentId: proc.agentId } : {}),
    };
  }

  /** A tunnel whose address has not been found (yet). */
  private blank(proc: Proc, now: number): Tunnel {
    const shown = this.base(proc, null, proc.command.target);
    return this.settle(shown, "unknown", "its public address has not been found yet", now, null);
  }

  /** One look at one address: locally every time, publicly when it is due. */
  private async check(proc: Proc, found: Found, now: number): Promise<Tunnel> {
    const shown = this.base(proc, found.url, found.target);
    if (shown.port !== null && !(await this.deps.reachable(shown.port).catch(() => false))) {
      return this.settle(shown, "down", `nothing is listening on :${shown.port}`, now, this.lastPublic.get(found.url)?.at ?? null);
    }
    // A tcp:// or tls:// address has no HTTP to ask; its agent listing it and the port answering is all there is.
    if (!/^https?:/i.test(found.url)) return this.settle(shown, "up", `${proc.command.kind} lists it, and its port answers`, now, null);
    let last = this.lastPublic.get(found.url) ?? null;
    if (publicDue(proc.command.kind, last, now)) {
      const probe = await this.deps.probe(found.url).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      const said = classifyProbe(probe);
      last = { at: now, up: said.up, why: said.why };
      this.lastPublic.set(found.url, last);
      this.deps.asked?.save(Object.fromEntries(this.lastPublic));
    }
    if (!last) return this.settle(shown, "unknown", "not asked from outside yet", now, null);
    return this.settle(shown, last.up ? "up" : "down", last.why, now, last.at);
  }

  private settle(shown: ReturnType<Tunnels["base"]>, health: TunnelHealth, why: string, now: number, publicAt: number | null): Tunnel {
    const before = this.tunnels.find((t) => t.id === shown.id);
    return { ...shown, health, why, checkedAt: now, publicAt, since: before && before.health === health ? before.since : now };
  }
}

function score(t: Tunnel): number {
  return t.health === "up" ? 0 : t.health === "unknown" ? 1 : t.health === "down" ? 2 : 3;
}

/** The kururu terminal a process runs under, found by walking up its parents to one. */
export function terminalOf(pid: number, procs: ProcRows, roots: ReadonlyMap<number, string>): string | undefined {
  let current: number | undefined = pid;
  for (let hop = 0; current && current > 1 && hop < 24; hop++) {
    const agentId = roots.get(current);
    if (agentId) return agentId;
    current = procs.get(current)?.ppid;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// In words, for Kuru
// ---------------------------------------------------------------------------

/** "40s ago", "12 min ago": a time without a time zone to get wrong. */
export function ago(at: number | null, now: number): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return s < 5 ? "just now" : `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** The dev server a tunnel serves, as a phrase: "pnpm dev in holapy". */
function serving(t: Tunnel, servers: readonly DevServer[]): string {
  if (t.port === null) return t.target ? `forwards to ${t.target}` : "forwards to an address not yet known";
  const dev = servers.find((s) => s.port === t.port);
  if (!dev) return `forwards to :${t.port}, where no dev server was found`;
  const folder = (dev.repo ?? dev.cwd)?.split("/").filter(Boolean).pop();
  return `serves the dev server on :${t.port} (${dev.command.slice(0, 60)}${folder ? ` in ${folder}` : ""})`;
}

/** One tunnel as a line of `kururu_status`. */
export function tunnelLine(t: Tunnel, servers: readonly DevServer[], nameOf: (agentId: string) => string, now: number): string {
  const state =
    t.health === "up"
      ? `up (${t.why})`
      : t.health === "unknown"
        ? `not known yet (${t.why})`
        : t.health === "gone"
          ? `STOPPED (${t.why})`
          : `DOWN (${t.why})`;
  const asked = t.publicAt !== null ? `, address last asked ${ago(t.publicAt, now)}` : "";
  const where = t.agentId ? ` · runs in ${nameOf(t.agentId)}` : " · started outside kururu";
  return `${t.kind} ${t.url ?? "(no address yet)"} · ${state} · looked at ${ago(t.checkedAt, now)}${asked} · ${serving(t, servers)}${where}`;
}

/** The `tunnels:` part of `kururu_status`, or null when there are none. */
export function tunnelsText(tunnels: readonly Tunnel[], servers: readonly DevServer[], nameOf: (agentId: string) => string, now: number): string | null {
  if (!tunnels.length) return null;
  return [
    "tunnels (ngrok/cloudflared on this Mac; looked at every minute, an ngrok address asked from outside every 30 min to spare its free plan's 20k requests/month):",
    ...tunnels.map((t) => `  - ${tunnelLine(t, servers, nameOf, now)}`),
  ].join("\n");
}

/** What Kuru is told when a tunnel goes down or comes back. */
export function tunnelNotice(t: Tunnel, event: "down" | "up", servers: readonly DevServer[], nameOf: (agentId: string) => string, now = Date.now()): string {
  const where = t.agentId ? `, in ${nameOf(t.agentId)}` : "";
  const what = `${t.kind} ${t.url ?? (t.port !== null ? `→ :${t.port}` : "")}`.trim();
  if (event === "up") return `[kururu] Tunnel back up: ${what} (${t.why}); it ${serving(t, servers)}${where}.`;
  return `[kururu] Tunnel ${t.health === "gone" ? "stopped" : "down"}: ${what} — ${t.why}, since ${ago(t.since, now)}. It ${serving(t, servers)}${where}. Anything pointed at that address (webhooks, a phone build) is failing until it is back.`;
}
