/**
 * Whether a workspace has a local Supabase behind it, and whether it is up.
 *
 * This exists for the same reason the dev-server half of `devservers.ts` does,
 * and it is worth saying which reason that is. A local Supabase is a stack of
 * Docker containers that takes the better part of a minute to come up, is
 * invisible once it has, and is the thing every request in the app you are
 * looking at goes through — so "is the database running" is a question you ask
 * constantly and can only answer by leaving the window. It is also a question
 * with an expensive wrong answer in both directions: an app failing against a
 * stopped database looks exactly like an app with a bug in it, and a `supabase
 * start` typed at a stack that is already running is a minute of waiting for
 * nothing.
 *
 * Discovered, never configured. A workspace *has* a Supabase when one of its
 * terminals is sitting in a directory with `supabase/config.toml` at or above
 * it — which is the same thing `supabase start` itself looks for, so kururu
 * finding one and the CLI finding one cannot disagree. Nothing has to be set up,
 * and a workspace that has nothing to do with Supabase draws no button.
 *
 * "Up" is asked of the port rather than of the CLI. `supabase status` shells out
 * to Docker and takes seconds, which is not a thing to do every three seconds
 * per workspace; the local Postgres port is either accepting connections or it
 * is not, and that is the fact the app in the next pane cares about anyway. The
 * port comes out of the project's own config rather than being assumed to be
 * 54322, because two Supabase projects on one machine cannot both be on 54322
 * and somebody with two of them has already changed one.
 *
 * Nothing in here runs anything. Starting and stopping is `index.ts` typing a
 * line into a terminal, exactly as ▸ does — see `supabaseCommand` for how the
 * line is worked out, and `runSupabase` there for why it is typed rather than
 * spawned.
 */
import { connect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";

/** A Supabase project, as found on disk. */
export interface SupabaseFound {
  /** The directory holding `supabase/`. What the command has to run in. */
  root: string;
  /** `project_id` from the config — what the CLI names its containers. */
  project: string;
  /** The local Postgres port. What "is it up" is asked of. */
  port: number;
}

/**
 * The `port` under `[db]`, and the `project_id` above every section.
 *
 * A hand-rolled reader rather than a TOML dependency, and the reason is the
 * shape of what is being read rather than the size of the library: this needs
 * two scalars out of a file the CLI generates with a documented layout, and the
 * one thing that can go wrong is reading the wrong `port` — `config.toml` has at
 * least four of them (`[api]`, `[db]`, `[db.pooler]`, `[studio]`) and a reader
 * that took the first or the last would be wrong on most real projects. So this
 * is section-aware and nothing else, which is the whole of the correctness at
 * stake.
 *
 * `[db.pooler]` is deliberately not `[db]`: the section name is compared whole,
 * so a subsection cannot answer for its parent. Null when there is no `[db]`
 * port at all, because a config without one is one this cannot check and a
 * button that cannot tell you the answer is worse than no button.
 */
export function parseConfig(toml: string): { project: string; port: number } | null {
  let section = "";
  let project = "";
  let port: number | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair as unknown as [string, string, string];
    if (section === "" && key === "project_id") project = value.trim().replace(/^["']|["']$/g, "");
    if (section === "db" && key === "port") {
      const n = Number(value.trim());
      // `Number.isFinite` for the reason everything off the wire gets it: this
      // one is off a file rather than a socket, but `Number("")` is 0 and a
      // probe of port 0 is a probe of whatever the kernel feels like.
      if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
    }
  }
  return port === null ? null : { project, port };
}

/**
 * The nearest directory at or above `dir` with a `supabase/config.toml` in it.
 *
 * Upwards rather than at the directory itself, because a terminal sitting in
 * `web/` of a monorepo is still in the project the database belongs to — which
 * is exactly the case `supabase start` handles the same way. It stops at the
 * root of the filesystem and at the home directory: a `supabase/` in `$HOME`
 * would claim every workspace on the machine, which is not a thing anybody
 * meant by putting it there.
 */
export async function findSupabase(dir: string): Promise<SupabaseFound | null> {
  const home = process.env.HOME ?? "";
  const stop = parsePath(dir).root;
  let at = dir;
  for (;;) {
    if (!at || at === home) return null;
    const config = join(at, "supabase", "config.toml");
    try {
      if ((await stat(config)).isFile()) {
        const parsed = parseConfig(await readFile(config, "utf8"));
        if (parsed) return { root: at, project: parsed.project || parsePath(at).base, port: parsed.port };
      }
    } catch {
      // Unreadable is not found. A directory kururu cannot stat is one it has no
      // business claiming a database in.
    }
    if (at === stop) return null;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * How long to wait for the database port to answer before calling it down.
 *
 * Generous for a loopback connect, which either succeeds in a millisecond or is
 * refused in one. The timeout is for the third case — a port held by something
 * that accepts the TCP handshake and then says nothing — where hanging the whole
 * poll would be worse than a wrong answer a person can see is wrong.
 */
const PROBE_MS = 700;

/**
 * Is anything accepting connections on this port of this machine?
 *
 * A connect rather than a scan of the listener table, and rather than `docker
 * ps`. The listener table is what `devservers.ts` reads and would work here too,
 * but it answers "is there a socket" where this wants "would my app get through"
 * — and Supabase's Postgres is published by Docker, which on macOS means the
 * listener belongs to a helper process the scan attributes to nobody. A connect
 * asks the question the app in the next pane asks.
 */
export function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * The line to type to start or stop this project's database.
 *
 * The user's own script wins, and that is the whole point of looking rather than
 * writing `supabase start` and being done. The CLI is a devDependency in most
 * projects — it is not on anybody's PATH — so the bare command is the one that
 * fails, and the line people actually type is `npm run db:start`. Reading it out
 * of `package.json` also means the button and the terminal history agree, which
 * is the same bargain `Workspace.dev` makes: the command kururu re-types is the
 * one a person would have.
 *
 * Failing that, `npx supabase`, which finds `node_modules/.bin` and is right for
 * the project that has the dependency and no script for it. Failing *that*, the
 * bare command, for a machine with the CLI installed properly — the one case
 * where assuming PATH is correct rather than hopeful.
 */
export async function supabaseCommand(root: string, verb: "start" | "stop"): Promise<string> {
  const script = await findScript(root, verb);
  if (script) return `${await packageManager(root)} run ${script}`;
  try {
    if ((await stat(join(root, "node_modules", ".bin", "supabase"))).isFile()) {
      return `npx supabase ${verb}`;
    }
  } catch {
    // No local CLI. Fall through to the one on PATH, if there is one.
  }
  return `supabase ${verb}`;
}

/**
 * A script in this project's `package.json` that runs `supabase <verb>` — the
 * name, not the body.
 *
 * Matched on the body rather than on a list of likely names (`db:start`,
 * `supabase:start`, `dev:db`), because the name is the thing that varies between
 * projects and the body is the thing that does not. A script whose body merely
 * *mentions* the verb is not a match: `supabase db reset` contains neither
 * `start` nor `stop`, but `supabase stop && rm -rf .branches` should still be
 * the stop button, so the test is on the head of the line rather than on the
 * whole of it.
 */
async function findScript(root: string, verb: "start" | "stop"): Promise<string | null> {
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return null;
  }
  const head = new RegExp(`^(?:npx\\s+|bunx\\s+|pnpm\\s+(?:dlx\\s+|exec\\s+)?|yarn\\s+)?supabase\\s+${verb}\\b`);
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body === "string" && head.test(body.trim())) return name;
  }
  return null;
}

/**
 * Which package manager this project is run with, from the lockfile it keeps.
 *
 * The lockfile rather than `packageManager` in `package.json`, because the
 * lockfile is there in every project and the field is there in some — and
 * because getting this wrong is not fatal: `npm run` works in a bun project, it
 * is just not what the person types.
 */
async function packageManager(root: string): Promise<string> {
  const locks: Array<[string, string]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ];
  for (const [file, pm] of locks) {
    try {
      if ((await stat(join(root, file))).isFile()) return pm;
    } catch {
      // Not this one.
    }
  }
  return "npm";
}
