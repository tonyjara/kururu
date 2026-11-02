/**
 * Kuru on OpenCode, the half that touches the disk: kururu's plugin, and the
 * config and role written into Kuru's folder before each start. The argument
 * for a second program, and the map of which door replaced which, is
 * `shared/opencode.ts`.
 *
 * The plugin is the part worth reading. A Claude Code harness tells kururu
 * everything through hooks (`hooks.ts`, `report-cli.ts`): `working` with the
 * prompt when a message is taken — which is how the drawer writes your words
 * down and the outbox knows they arrived — `done` with the last message when
 * a turn ends, which the voice reads aloud and Telegram carries, `blocked`
 * when it asks, and how full its context is. OpenCode has no hooks of that
 * kind; it has plugins, which run inside its server and see its events. So
 * this one listens to the one session kururu started and posts the same
 * reports to the same endpoint, and nothing on kururu's side of
 * `/api/report` knows which program sent them.
 *
 * Written as JavaScript in a string, and written out on every start, for the
 * reason `hooks.ts` rewrites its settings file: it has to exist on a machine
 * that only has the app, where there is no checkout to point at and no
 * bundler step that knows about it, and a few kilobytes are cheaper to write
 * than to keep in step. It imports nothing but Node's own modules, which
 * OpenCode's Bun has.
 *
 * Three things it does that Claude Code did for itself:
 *
 * - **Compaction at kururu's point.** Claude Code is told where to compact
 *   (`--autocompact`); OpenCode compacts near the model's own limit, which
 *   for Opus is a million tokens, re-sent on every notice and billed per
 *   token now. So after a turn that leaves the context past
 *   `HARNESS_COMPACT_AT`, the plugin asks OpenCode to compact — OpenCode's
 *   own summary, at its next safe point, not one of kururu's.
 * - **The model the setting names.** A session keeps the model it was made
 *   with, so a resumed Kuru would stay on yesterday's choice; the plugin
 *   switches it to the one in Settings when they differ.
 * - **One reply per turn.** Every turn's end is reported once, by the id of
 *   the message it ended on, so a compaction or an interrupted turn that
 *   ends without new words is `idle` — between turns, nothing to say aloud
 *   — and never a second reading of the last reply.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  OPENCODE_INSTALL,
  OPENCODE_MIN_MAJOR,
  opencodeCandidates,
  opencodeAgentConfig,
  opencodeHarnessConfig,
  opencodeVersion,
  type OpencodeHarnessArgs,
} from "../../shared/opencode";
import { stateDir } from "./fsutil";

/** How long `opencode --version` may take before that copy is passed over. It answers in a twentieth of a second. */
const VERSION_TIMEOUT_MS = 5000;

/** What `opencode --version` said, or why it said nothing. */
function askVersion(bin: string): Promise<{ output: string } | { failed: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS, env: process.env }, (err, stdout, stderr) => {
      if (!err) return resolve({ output: `${stdout}\n${stderr}` });
      const { signal, killed, code } = err as NodeJS.ErrnoException & { signal?: string | null; killed?: boolean };
      if (killed && signal === "SIGTERM") return resolve({ failed: "did not answer" });
      if (signal) return resolve({ failed: `was killed (${signal}) as it started` });
      resolve({ failed: `would not run (${code ?? err.message})` });
    });
  });
}

/**
 * The OpenCode Kuru is started on: the first of `opencodeCandidates` that
 * runs and is at least OpenCode 2, as an absolute path for the command line.
 * Asked on every start rather than remembered, since an install or an
 * upgrade changes the answer and the asking costs a twentieth of a second.
 *
 * Throws a sentence for the drawer when there is none, naming what it found
 * and what was wrong with each — an OpenCode 1 that will not do is the case
 * that needs saying, since `opencode` in a terminal may well be fine.
 */
export async function findOpencode(candidates = opencodeCandidates(homedir(), process.env.PATH ?? "")): Promise<{ path: string; version: string }> {
  const seen = new Set<string>();
  const wrong: string[] = [];
  for (const candidate of candidates) {
    let real: string;
    try {
      accessSync(candidate, constants.X_OK);
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const said = await askVersion(candidate);
    if ("failed" in said) {
      wrong.push(`${candidate} ${said.failed}`);
      continue;
    }
    const version = opencodeVersion(said.output);
    if (!version) {
      wrong.push(`${candidate} gave no version`);
      continue;
    }
    if (version[0] < OPENCODE_MIN_MAJOR) {
      wrong.push(`${candidate} is ${version.join(".")}`);
      continue;
    }
    return { path: candidate, version: version.join(".") };
  }
  const found = wrong.length ? ` ${wrong.join("; ")}.` : " There is none in ~/.opencode/bin or on the PATH.";
  throw new Error(`Kuru needs OpenCode ${OPENCODE_MIN_MAJOR} or newer.${found} Install it with: ${OPENCODE_INSTALL}`);
}

/** The plugin's folder, under kururu's state directory beside `claude-hooks.json`. */
function pluginDir(): string {
  const state = stateDir();
  return join(state, "opencode-plugin");
}

/**
 * The plugin. OpenCode loads a folder's `index.js` and calls the default
 * export's `setup` with its plugin context; `ctx.options` is what
 * `opencodeHarnessConfig` put beside the package. Exported for the test,
 * which loads it against a fake context.
 *
 * Nothing in it may throw into OpenCode or hold a turn up: every report is
 * fire-and-forget with a short timeout, serialised so they arrive in order,
 * and a server that is restarting simply misses one — as a hook does.
 */
export const OPENCODE_PLUGIN = String.raw`// kururu's plugin for OpenCode: the hooks a Kuru on Claude Code has, for a Kuru
// on OpenCode. Written by kururu on every start of an OpenCode Kuru
// (server/src/opencode.ts in kururu); edits here are lost.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 1500;
const REPLY_MAX = 20000;
const MESSAGE_MAX = 4000;
const EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
];

// The same lookup as kururu's localtoken.mjs: access.json first, then the
// environment the pty was given.
function token(env) {
  try {
    const dir = env.KURURU_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kururu");
    const saved = JSON.parse(readFileSync(join(dir, "access.json"), "utf8"));
    if (typeof saved?.token === "string" && saved.token.length >= 16) return saved.token;
  } catch {}
  return env.KURURU_TOKEN || null;
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

// What a turn ended on: the newest assistant message since the newest user
// message, and the newest one of those with words in it, which is the reply.
export function turnEnd(messages) {
  let usage = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === "user") break;
    if (message?.type !== "assistant") continue;
    usage ??= message;
    const text = textOf(message);
    if (text) return { id: message.id, text, usage };
  }
  return usage ? { id: null, text: "", usage } : null;
}

// Why a failed turn failed, off the idle message OpenCode files for it.
export function failureOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === "user") return null;
    if (message?.type === "idle" && message.outcome === "failed") {
      const error = message.error;
      const said = error?.message ?? error?.data?.message ?? error?.type ?? (error ? JSON.stringify(error) : "");
      return String(said || "no reason given").slice(0, 600);
    }
  }
  return null;
}

function used(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = n(tokens.input) + n(tokens.cache?.read) + n(tokens.cache?.write);
  return total > 0 ? total : null;
}

function sameModel(a, b) {
  const id = (ref) => ref?.id ?? ref?.modelID ?? ref?.model;
  return !!a && !!b && a.providerID === b.providerID && id(a) === id(b) && (a.variant ?? null) === (b.variant ?? null);
}

export default {
  id: "kururu",
  async setup(ctx) {
    const options = ctx?.options ?? {};
    const session = typeof options.session === "string" ? options.session : null;
    const agent = process.env.KURURU_AGENT_ID || null;
    // Not a Kuru kururu started: a config copied somewhere else, or this
    // folder opened by hand. Nothing to report, and nobody to report it to.
    if (!session || !agent) return;
    const port = Number(options.port) || Number(process.env.KURURU_PORT) || 7717;
    const compactAt = Number(options.compactAt) || 0;
    let reported = null;
    let compacting = false;
    let chain = Promise.resolve();
    const later = (task) => {
      chain = chain.then(task).catch(() => {});
      return chain;
    };

    const report = async (body) => {
      const key = token(process.env);
      try {
        await fetch("http://127.0.0.1:" + port + "/api/report", {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
          body: JSON.stringify({ agent, session, ...body }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {}
    };

    const windows = new Map();
    const windowOf = async (ref) => {
      if (!ref) return null;
      const key = ref.providerID + "/" + (ref.id ?? ref.modelID);
      if (!windows.has(key)) {
        try {
          const found = list(await ctx.model.list()).find((m) => m.providerID === ref.providerID && (m.id === (ref.id ?? ref.modelID) || m.modelID === (ref.id ?? ref.modelID)));
          windows.set(key, typeof found?.limit?.context === "number" ? found.limit.context : null);
        } catch {
          return null;
        }
      }
      return windows.get(key);
    };

    // A turn is over: what it said, once, and how full the context is.
    const ended = async (outcome) => {
      let messages = [];
      try {
        messages = list(await ctx.session.context({ sessionID: session }));
      } catch {}
      const end = turnEnd(messages);
      const tokens = used(end?.usage?.tokens);
      const window = tokens ? await windowOf(end?.usage?.model) : null;
      const context = tokens && window ? { used: tokens, window } : undefined;
      const fresh = end?.text && end.id !== reported;
      if (outcome === "interrupted" || (!fresh && outcome !== "failed")) {
        await report({ status: "idle", context });
      } else {
        if (end?.id) reported = end.id;
        const failure = outcome === "failed" ? failureOf(messages) : null;
        const reply = fresh ? end.text : failure ? "OpenCode could not finish that turn: " + failure : "";
        await report({ status: "done", context, ...(reply ? { reply: reply.slice(0, REPLY_MAX) } : {}) });
      }
      if (compactAt && tokens && tokens > compactAt && !compacting && outcome === "succeeded") {
        compacting = true;
        try {
          await ctx.session.compact({ sessionID: session });
        } catch {
          compacting = false;
        }
      } else if (tokens && tokens < compactAt) compacting = false;
    };

    // The session kururu named may not exist yet — --session makes it — and
    // a resumed one keeps the model it was made with until told otherwise.
    let busy = false;
    try {
      const info = await ctx.session.get({ sessionID: session });
      const now = info?.data ?? info;
      busy = typeof now?.time?.busy === "number" && now.time.busy > (now.time.idle ?? 0);
      if (options.modelRef && now?.model && !sameModel(now.model, options.modelRef)) {
        await ctx.session.switchModel({ sessionID: session, model: options.modelRef }).catch(() => {});
      }
    } catch {}
    // The first word, which is how kururu knows this Kuru is up and may be
    // typed to (Harness.hear's wake).
    later(() => report({ status: busy ? "working" : "idle" }));

    const prompt = await ctx.session.hook("prompt", (event) => {
      if (event?.sessionID !== session) return;
      const text = event?.prompt?.text;
      if (typeof text === "string" && text.trim()) later(() => report({ status: "working", message: text.trim() }));
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: EVENTS, signal: controller.signal })) {
        if (controller.signal.aborted) break;
        const data = event?.data ?? event?.properties ?? {};
        const owner = data.sessionID ?? data.form?.sessionID;
        if (owner !== session) continue;
        switch (event.type) {
          case "session.execution.started":
            later(() => report({ status: "working" }));
            break;
          case "session.execution.succeeded":
            later(() => ended("succeeded"));
            break;
          case "session.execution.failed":
            later(() => ended("failed"));
            break;
          case "session.execution.interrupted":
            later(() => ended("interrupted"));
            break;
          case "permission.asked": {
            const resources = Array.isArray(data.resources) ? data.resources.slice(0, 3).join(", ") : "";
            const what = "OpenCode asks to " + (data.action ?? "do something") + (resources ? ": " + resources : "");
            later(() => report({ status: "blocked", message: what.slice(0, MESSAGE_MAX) }));
            break;
          }
          case "form.created": {
            const what = data.form?.title ?? data.form?.fields?.[0]?.title ?? "OpenCode is asking a question";
            later(() => report({ status: "blocked", message: String(what).slice(0, MESSAGE_MAX) }));
            break;
          }
          default:
            // An answer: back to work.
            later(() => report({ status: "working" }));
        }
      }
    })().catch(() => {});

    return async () => {
      controller.abort();
      try {
        await prompt?.dispose?.();
      } catch {}
    };
  },
};
`;

/** Write the plugin out, now, and say where. */
export function writeOpencodePlugin(): string {
  const dir = pluginDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), OPENCODE_PLUGIN, "utf8");
  return dir;
}

/**
 * Kuru's folder made ready for OpenCode: the plugin written, then the role
 * and the config under `.opencode/`, all of them kururu's and rewritten on
 * every start, since the role names the workspaces and the config the port.
 * The folder's own `opencode.json`, and its AGENTS.md, are the user's.
 */
export function prepareOpencodeHome(home: string, args: Omit<OpencodeHarnessArgs, "plugin" | "role">, role: string): void {
  const plugin = writeOpencodePlugin();
  const dir = join(home, ".opencode");
  mkdirSync(dir, { recursive: true });
  const rolePath = join(dir, "kururu-role.md");
  writeFileSync(rolePath, role, "utf8");
  const config = opencodeHarnessConfig({ ...args, plugin, role: rolePath });
  writeFileSync(join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Write one ordinary agent's private config outside its project and return its path. */
export function prepareOpencodeAgent(sessionId: string, args: { port: number; withToken: boolean; model: string; web: boolean }): string {
  const plugin = writeOpencodePlugin();
  const state = stateDir();
  const dir = join(state, "opencode-agents", sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  writeFileSync(path, `${JSON.stringify(opencodeAgentConfig({ ...args, sessionId, plugin }), null, 2)}\n`, "utf8");
  return path;
}
