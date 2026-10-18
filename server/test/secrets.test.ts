/**
 * The lent secrets: that a sealed value opens for its node and nothing else,
 * that the rule for what to push and take back says what it should, that
 * every secret file kururu writes is a kind or named as never shared, and —
 * end to end, with real keys and a fake link — that a grant becomes a file
 * on the child, a rotation reaches it, and a take-back removes it.
 *
 * Every value here is made up in the shape of a real one. The crypto is
 * real, for `nodes.test.ts`'s reason: a test that sealed with a stand-in
 * would pass on an envelope the server cannot open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILES, EXCLUDED } from "../../shared/backup";
import type { LinkMessage, NodeEntry } from "../../shared/nodes";
import {
  adoptGrants,
  adoptHeld,
  asSealed,
  checkValue,
  emptyGrant,
  extract,
  FIXED_KINDS,
  forgotten,
  grantState,
  hintOf,
  kindOf,
  landed,
  NEVER_SHARED,
  nextSeq,
  plan,
  sealSigned,
  webKind,
  withGrant,
  withReport,
  type GrantRecord,
  type SealedSecret,
} from "../../shared/secrets";
import { lentClaudeEnv } from "../src/logins";
import { boxPrivateKey, forgetIdentity, identity, signAsNode, verifySigned } from "../src/nodekeys";
import { digestOf, seal, unseal } from "../src/seal";
import { Secrets } from "../src/secrets";

// Made-up values in the shapes the validators want. None is anybody's.
const OPENROUTER = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
const OPENROUTER_2 = `sk-or-v1-${"fedcba9876543210".repeat(4)}`;
const TELEGRAM = `123456789:${"A".repeat(35)}`;
const FIRECRAWL = "fc-0123456789abcdef";
const CLAUDE = `sk-ant-oat01-${"x".repeat(60)}wxyz`;

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["KURURU_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kururu-secrets-"));
  for (const name of VARS) saved[name] = process.env[name];
});
afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  forgetIdentity();
  rmSync(root, { recursive: true, force: true });
});

/** Be one side: its config directory, its Codex home, and the identity in that directory. */
function as<T>(side: string, run: () => T): T {
  process.env.KURURU_CONFIG_DIR = join(root, side, "config");
  process.env.CODEX_HOME = join(root, side, "codex");
  mkdirSync(process.env.KURURU_CONFIG_DIR, { recursive: true });
  forgetIdentity();
  return run();
}

// ---------------------------------------------------------------------------

describe("seal", () => {
  it("opens for the node it was sealed to, with the value intact", () => {
    const value = { managementKey: OPENROUTER };
    const child = as("child", () => identity());
    const envelope = as("parent", () => seal(value, { kind: "openrouter", from: "n000000000001", to: child.id, seq: 7 }, child.keys.box, signAsNode));
    expect(envelope.ct).not.toContain(OPENROUTER);
    expect(JSON.stringify(envelope)).not.toContain(OPENROUTER);
    expect(as("child", () => unseal(envelope, boxPrivateKey(), identity().keys.box))).toEqual(value);
  });

  it("is signed by the parent's node key, over the whole envelope", () => {
    const child = as("child", () => identity());
    const parent = as("parent", () => identity());
    const envelope = as("parent", () => seal({ apiKey: FIRECRAWL }, { kind: "firecrawl-cloud", from: parent.id, to: child.id, seq: 1 }, child.keys.box, signAsNode));
    const { sig, ...unsigned } = envelope;
    expect(verifySigned(sealSigned(unsigned), sig, parent.keys.sign)).toBe(true);
    expect(verifySigned(sealSigned({ ...unsigned, seq: 2 }), sig, parent.keys.sign)).toBe(false);
    expect(verifySigned(sealSigned(unsigned), sig, child.keys.sign)).toBe(false);
  });

  it("does not open for another node", () => {
    const child = as("child", () => identity());
    const envelope = as("parent", () => seal({ managementKey: OPENROUTER }, { kind: "openrouter", from: "n000000000001", to: child.id, seq: 1 }, child.keys.box, signAsNode));
    expect(() => as("stranger", () => unseal(envelope, boxPrivateKey(), identity().keys.box))).toThrow();
  });

  it("does not open once any part of it is changed", () => {
    const child = as("child", () => identity());
    const envelope = as("parent", () => seal({ managementKey: OPENROUTER }, { kind: "openrouter", from: "n000000000001", to: child.id, seq: 3 }, child.keys.box, signAsNode));
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      return bytes.toString("base64");
    };
    const tampered: SealedSecret[] = [
      { ...envelope, ct: flip(envelope.ct) },
      { ...envelope, tag: flip(envelope.tag) },
      { ...envelope, nonce: flip(envelope.nonce) },
      // The header is the cipher's additional data: a kind or a node changed is an envelope that does not open.
      { ...envelope, kind: "telegram" },
      { ...envelope, to: "n000000000009" },
      { ...envelope, seq: 4 },
    ];
    for (const bad of tampered) expect(() => as("child", () => unseal(bad, boxPrivateKey(), identity().keys.box))).toThrow();
  });

  it("checks the shape before anything is opened", () => {
    expect(asSealed(null)).toBeNull();
    expect(asSealed({ v: 2 })).toBeNull();
    expect(asSealed({ v: 1, kind: "nonsense", from: "a", to: "b", seq: 1, epk: "AA==", nonce: "AA==", ct: "AA==", tag: "AA==", sig: "AA==" })).toBeNull();
    expect(asSealed({ v: 1, kind: "openrouter", from: "a", to: "b", seq: Number.NaN, epk: "AA==", nonce: "AA==", ct: "AA==", tag: "AA==", sig: "AA==" })).toBeNull();
    expect(asSealed({ v: 1, kind: "openrouter", from: "a", to: "b", seq: 1, epk: "not base64!", nonce: "AA==", ct: "AA==", tag: "AA==", sig: "AA==" })).toBeNull();
  });

  it("digests the same value the same whatever order its keys were built in", () => {
    expect(digestOf({ a: 1, b: "x" })).toBe(digestOf({ b: "x", a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });

  it("numbers pushes upward even when the clock goes back", () => {
    expect(nextSeq(0, 1000)).toBe(1000);
    expect(nextSeq(1000, 1000)).toBe(1001);
    expect(nextSeq(5000, 1000)).toBe(5001);
  });
});

// ---------------------------------------------------------------------------

describe("kinds", () => {
  it("reads the ids it names and nothing else", () => {
    for (const id of [...FIXED_KINDS, "web:other-thing", "claude-token:machine", "claude-token:0123456789ab", "codex-auth:machine"]) expect(kindOf(id)?.id).toBe(id);
    for (const bad of ["", "web:", "web:../x", "web:Firecrawl", "web:firecrawl-cloud", "claude-token:", "claude-token:../../x", "codex-auth:root", "access", 42, null]) expect(kindOf(bad)).toBeNull();
  });

  it("names a web provider's kind from its id", () => {
    expect(webKind("firecrawl-cloud")).toBe("firecrawl-cloud");
    expect(webKind("firecrawl-self")).toBe("web:firecrawl-self");
    expect(kindOf(webKind("firecrawl-self"))?.source).toEqual({ in: "config", file: "web-firecrawl-self.json" });
  });

  it("puts the two that land in one place in a group", () => {
    expect(kindOf("claude-token:machine")?.group).toBe(kindOf("claude-token:0123456789ab")?.group!);
    expect(kindOf("codex-auth:machine")?.follows).toBe(false);
    expect(kindOf("openrouter")?.follows).toBe(true);
  });

  it("lends only the secret part of the Telegram file, never its switch", () => {
    const spec = kindOf("telegram")!;
    const value = extract(spec, { token: TELEGRAM, bot: { id: "1", username: "kurubot", name: "Kuru" }, enabled: true, allowed: [{ id: "5" }] });
    expect(value).toEqual({ token: TELEGRAM, bot: { id: "1", username: "kurubot", name: "Kuru" } });
    expect(landed(spec, value, { token: "old", enabled: true })).toEqual(value);
    expect(extract(spec, { enabled: true })).toBeNull();
  });

  it("keeps the child's own Firecrawl budget beside a lent key, and leaves it when the key goes", () => {
    const spec = kindOf("firecrawl-cloud")!;
    const value = extract(spec, { apiKey: FIRECRAWL, settings: { dailyCredits: 500 } });
    expect(value).toEqual({ apiKey: FIRECRAWL });
    expect(landed(spec, value, { settings: { dailyCredits: 50 } })).toEqual({ apiKey: FIRECRAWL, settings: { dailyCredits: 50 } });
    expect(forgotten(spec, { apiKey: FIRECRAWL, settings: { dailyCredits: 50 } })).toEqual({ settings: { dailyCredits: 50 } });
    expect(forgotten(spec, { apiKey: FIRECRAWL })).toBeNull();
  });

  it("takes a Claude token for one login out of the lending file", () => {
    const spec = kindOf("claude-token:machine")!;
    expect(extract(spec, { tokens: { machine: { token: CLAUDE, account: "someone@example.com", at: 1 } } })).toEqual({ token: CLAUDE, account: "someone@example.com" });
    expect(extract(kindOf("claude-token:0123456789ab")!, { tokens: { machine: { token: CLAUDE } } })).toBeNull();
    expect(extract(spec, { tokens: { machine: { token: "sk-ant-api03-short" } } })).toBeNull();
  });

  it("refuses on a child what that kind's extract would not make", () => {
    expect(checkValue(kindOf("openrouter")!, { managementKey: OPENROUTER })).toBe(true);
    expect(checkValue(kindOf("openrouter")!, { managementKey: "x" })).toBe(false);
    expect(checkValue(kindOf("web:firecrawl-self")!, { endpoint: "http://100.64.0.2:3002", apiKey: FIRECRAWL })).toBe(true);
    expect(checkValue(kindOf("web:firecrawl-self")!, { endpoint: "http://100.64.0.2:3002", nested: { a: 1 } })).toBe(false);
    expect(checkValue(kindOf("codex-auth:machine")!, { tokens: { refresh_token: "r" } })).toBe(true);
    expect(checkValue(kindOf("codex-auth:machine")!, { hello: 1 })).toBe(false);
  });

  it("hints without the value", () => {
    const cases: Array<[string, unknown, string]> = [
      ["openrouter", { managementKey: OPENROUTER }, OPENROUTER],
      ["telegram", { token: TELEGRAM, bot: { id: "1", username: "kurubot", name: "Kuru" } }, TELEGRAM],
      ["firecrawl-cloud", { apiKey: FIRECRAWL }, FIRECRAWL],
      ["web:firecrawl-self", { endpoint: "http://100.64.0.2:3002", apiKey: FIRECRAWL }, FIRECRAWL],
      ["claude-token:machine", { token: CLAUDE, account: "someone@example.com" }, CLAUDE],
    ];
    for (const [kind, value, secret] of cases) {
      const hint = hintOf(kindOf(kind)!, value);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint).not.toContain(secret);
      expect(hint).not.toContain(secret.slice(0, -4).slice(-12));
    }
    expect(hintOf(kindOf("telegram")!, { token: TELEGRAM, bot: { id: "1", username: "kurubot", name: "K" } })).toContain("@kurubot");
    // Codex's id_token names the account; its payload is a label, never verified.
    const payload = Buffer.from(JSON.stringify({ email: "someone@example.com" })).toString("base64url");
    expect(hintOf(kindOf("codex-auth:machine")!, { tokens: { id_token: `x.${payload}.y`, refresh_token: "r" } })).toBe("someone@example.com");
  });
});

// ---------------------------------------------------------------------------

describe("grants", () => {
  const on = (holds: GrantRecord["holds"] = null, extra: Partial<GrantRecord> = {}): GrantRecord => ({ ...emptyGrant(1), on: true, holds, ...extra });
  const off = (holds: GrantRecord["holds"] = null): GrantRecord => ({ ...emptyGrant(1), holds });
  const spec = kindOf("openrouter")!;
  const codex = kindOf("codex-auth:machine")!;

  it("says how each one stands", () => {
    expect(grantState({ grant: undefined, spec, source: "d1", ready: true })).toBe("off");
    expect(grantState({ grant: off(), spec, source: "d1", ready: true })).toBe("off");
    expect(grantState({ grant: on(), spec, source: "d1", ready: true })).toBe("sending");
    expect(grantState({ grant: on(), spec, source: "d1", ready: false })).toBe("waiting");
    expect(grantState({ grant: on({ digest: "d1", seq: 1 }), spec, source: "d1", ready: false })).toBe("held");
    // A key rotated on the Mac: the node holds the old one until the push lands.
    expect(grantState({ grant: on({ digest: "d0", seq: 1 }), spec, source: "d1", ready: true })).toBe("sending");
    expect(grantState({ grant: on(null, { failed: { digest: "d1", error: "no", at: 1 } }), spec, source: "d1", ready: true })).toBe("failed");
    expect(grantState({ grant: on(null, { failed: { digest: "d0", error: "no", at: 1 } }), spec, source: "d1", ready: true })).toBe("sending");
    expect(grantState({ grant: on(), spec, source: null, ready: true })).toBe("missing");
    expect(grantState({ grant: off({ digest: "d1", seq: 1 }), spec, source: "d1", ready: true })).toBe("forgetting");
    expect(grantState({ grant: off({ digest: "d1", seq: 1 }), spec, source: "d1", ready: false })).toBe("waiting");
    // A login that refreshes itself is held whatever the Mac's copy became.
    expect(grantState({ grant: on({ digest: "d0", seq: 1 }), spec: codex, source: "d1", ready: true })).toBe("held");
  });

  it("pushes what is ticked and not held, and takes back what is held and not ticked", () => {
    const sources = new Map([
      ["openrouter", "d1"],
      ["telegram", "t1"],
      ["firecrawl-cloud", "f1"],
    ]);
    const grants = {
      openrouter: on(),
      telegram: on({ digest: "t1", seq: 1 }),
      "firecrawl-cloud": off({ digest: "f1", seq: 1 }),
      "web:firecrawl-self": on(),
    };
    expect(plan({ grants, sources, inflight: new Map(), retry: false })).toEqual([
      { op: "put", kind: "openrouter" },
      { op: "forget", kind: "firecrawl-cloud" },
    ]);
  });

  it("follows a rotated key, but not a login that refreshes itself", () => {
    const sources = new Map([
      ["openrouter", "d2"],
      ["codex-auth:machine", "c2"],
    ]);
    const grants = { openrouter: on({ digest: "d1", seq: 1 }), "codex-auth:machine": on({ digest: "c1", seq: 1 }) };
    expect(plan({ grants, sources, inflight: new Map(), retry: false })).toEqual([{ op: "put", kind: "openrouter" }]);
  });

  it("does not push twice, nor at a refusal, until asked", () => {
    const sources = new Map([["openrouter", "d1"]]);
    expect(plan({ grants: { openrouter: on() }, sources, inflight: new Map([["openrouter", "d1"]]), retry: true })).toEqual([]);
    expect(plan({ grants: { openrouter: on() }, sources, inflight: new Map([["openrouter", "d0"]]), retry: false })).toEqual([{ op: "put", kind: "openrouter" }]);
    const refused = { openrouter: on(null, { failed: { digest: "d1", error: "no", at: 1 } }) };
    expect(plan({ grants: refused, sources, inflight: new Map(), retry: false })).toEqual([]);
    expect(plan({ grants: refused, sources, inflight: new Map(), retry: true })).toEqual([{ op: "put", kind: "openrouter" }]);
  });

  it("leaves a node what it holds when the Mac clears its own copy", () => {
    expect(plan({ grants: { openrouter: on({ digest: "d1", seq: 1 }) }, sources: new Map(), inflight: new Map(), retry: true })).toEqual([]);
  });

  it("unticks the other kinds of a group when one is ticked", () => {
    let grants = withGrant({}, "claude-token:machine", true, 1);
    grants = withGrant(grants, "openrouter", true, 2);
    grants = withGrant(grants, "claude-token:0123456789ab", true, 3);
    expect(grants["claude-token:machine"]?.on).toBe(false);
    expect(grants["claude-token:0123456789ab"]?.on).toBe(true);
    expect(grants.openrouter?.on).toBe(true);
  });

  it("folds a child's report in, taking back what it holds without a grant", () => {
    const grants = withReport({ openrouter: on({ digest: "d1", seq: 1 }), telegram: on() }, new Map([["firecrawl-cloud", { digest: "f1", seq: 4 }]]), 5);
    expect(grants.openrouter?.holds).toBeNull();
    expect(grants["firecrawl-cloud"]).toMatchObject({ on: false, holds: { digest: "f1", seq: 4 } });
    expect(plan({ grants, sources: new Map([["openrouter", "d1"]]), inflight: new Map(), retry: false })).toEqual([
      { op: "put", kind: "openrouter" },
      { op: "forget", kind: "firecrawl-cloud" },
    ]);
  });

  it("reads a grants file it did not write without trusting it", () => {
    const adopted = adoptGrants({
      nodes: {
        n0123456789ab: { openrouter: { on: true, at: 1, holds: { digest: "d", seq: 2 } }, nonsense: { on: true }, telegram: "no" },
        "../etc": { openrouter: { on: true } },
      },
    });
    expect(Object.keys(adopted)).toEqual(["n0123456789ab"]);
    expect(Object.keys(adopted.n0123456789ab!)).toEqual(["openrouter"]);
    expect(adopted.n0123456789ab!.openrouter!.holds).toEqual({ digest: "d", seq: 2 });
    expect(adoptHeld({ held: { openrouter: { digest: 1 } }, seen: { openrouter: "x" } })).toEqual({ from: null, held: {}, seen: {} });
  });
});

// ---------------------------------------------------------------------------

describe("the registry", () => {
  /**
   * Every file the server writes `0600` into its config directory, read off
   * the source: `writeConfigFile(<name>, …, 0o600)` with the name a string
   * or a `const` in that file — `FILE = "x.json"`, or `FILE = providerFile(ID)`
   * with `ID = "y"`, which is `web-y.json`. A file written some other way is
   * outside what this can see, and the config directory is where kururu's
   * secrets have always lived.
   */
  function secretFiles(): Set<string> {
    const found = new Set<string>();
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    for (const path of walk(join(import.meta.dir, "..", "src"))) {
      const text = readFileSync(path, "utf8");
      const consts = new Map<string, string>();
      for (const m of text.matchAll(/const (\w+) = "([^"]+)"/g)) consts.set(m[1]!, m[2]!);
      for (const m of text.matchAll(/const (\w+) = providerFile\((\w+)\)/g)) consts.set(m[1]!, `web-${consts.get(m[2]!) ?? "?"}.json`);
      // Names imported from shared/secrets.ts.
      consts.set("CLAUDE_LEND_FILE", "claude-lend.json").set("CLAUDE_TOKEN_FILE", "claude-token.json").set("GRANTS_FILE", "grants.json").set("HELD_FILE", "secrets-held.json");
      for (const m of text.matchAll(/writeConfigFile\(\s*([\w.]+|"[^"]+")\s*,[^;]*?0o600\)/g)) {
        const arg = m[1]!;
        if (arg.startsWith('"')) found.add(arg.slice(1, -1));
        else if (consts.has(arg)) found.add(consts.get(arg)!);
        else if (arg === "file" || arg === "spec.lands.file") continue; // secrets.ts writing a kind's own file, which is a kind
        else found.add(`<unresolved ${arg} in ${path}>`);
      }
    }
    return found;
  }

  const kindFiles = (): Set<string> => {
    const files = new Set<string>();
    for (const id of [...FIXED_KINDS, "claude-token:machine"]) {
      const spec = kindOf(id)!;
      if (spec.source.in === "config") files.add(spec.source.file);
      if (spec.lands.in === "config") files.add(spec.lands.file);
    }
    return files;
  };

  const matches = (pattern: string, file: string) => new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`).test(file);

  it("knows every secret file the server writes: a kind, or named as never shared", () => {
    const never = new Set(NEVER_SHARED.map((n) => n.file));
    const kinds = kindFiles();
    const strays = [...secretFiles()].filter((file) => !kinds.has(file) && !never.has(file) && !/^web-[a-z0-9-]+\.json$/.test(file));
    expect(strays).toEqual([]);
    expect(secretFiles().size).toBeGreaterThan(5);
  });

  it("keeps every kind and every never-shared file out of the backup", () => {
    const files = [...kindFiles(), ...NEVER_SHARED.map((n) => n.file), "web-firecrawl-self.json", "web-anything.json"];
    for (const file of files) {
      expect(CONFIG_FILES).not.toContain(file);
      expect(EXCLUDED.some((e) => matches(e.what, file))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * Two `Secrets`, a parent and a child, over a link that is a queue: the real
 * keys of two identities, each in its own config directory, the frames
 * delivered one at a time with the side's environment switched in for each.
 */
describe("a parent lending to a child", () => {
  type Handler = (peer: string, message: LinkMessage) => void;

  interface Side {
    name: string;
    id: string;
    entry: NodeEntry;
    handlers: Map<string, Handler>;
    up: Array<(peer: string) => void>;
    down: Array<(peer: string) => void>;
    unpair: Array<() => void>;
    secrets: Secrets | null;
    landed: string[];
    role: "parent" | "child" | "alone";
  }

  let queue: Array<{ to: Side; from: Side; message: LinkMessage }>;
  let linked: boolean;
  let parent: Side;
  let child: Side;

  function makeSide(name: string, role: Side["role"], rank: number): Side {
    const me = as(name, () => identity());
    return {
      name,
      id: me.id,
      entry: { id: me.id, name, keys: me.keys, address: "127.0.0.1", port: 7000 + rank, rank },
      handlers: new Map(),
      up: [],
      down: [],
      unpair: [],
      secrets: null,
      landed: [],
      role,
    };
  }

  function nodesOf(side: Side, other: () => Side) {
    return {
      role: () => side.role,
      selfId: () => side.id,
      parentId: () => (side.role === "alone" ? null : parent.id),
      member: (id: string) => (side.role === "alone" ? undefined : [parent.entry, child.entry].find((e) => e.id === id)),
      linked: (id: string) => linked && id === other().id,
      send: (peer: string, message: LinkMessage) => {
        if (!linked || peer !== other().id) return false;
        queue.push({ to: other(), from: side, message: JSON.parse(JSON.stringify(message)) as LinkMessage });
        return true;
      },
      on: (type: string, handler: Handler) => void side.handlers.set(type, handler),
      onLinkUp: (hook: (peer: string) => void) => void side.up.push(hook),
      onLinkDown: (hook: (peer: string) => void) => void side.down.push(hook),
      onUnpair: (hook: () => void) => void side.unpair.push(hook),
    };
  }

  function start(side: Side, other: () => Side): void {
    side.secrets = as(side.name, () =>
      new Secrets({ nodes: nodesOf(side, other) as never, landed: (spec) => side.landed.push(spec.id), changed: () => undefined, log: () => undefined }),
    );
  }

  /** Every frame on the queue, delivered, until it is empty. */
  function flush(): void {
    for (let n = 0; queue.length && n < 100; n++) {
      const { to, from, message } = queue.shift()!;
      as(to.name, () => to.handlers.get(message.type)?.(from.id, message));
    }
  }

  function linkUp(): void {
    linked = true;
    as(parent.name, () => parent.up.forEach((hook) => hook(child.id)));
    as(child.name, () => child.up.forEach((hook) => hook(parent.id)));
    flush();
  }

  function linkDown(): void {
    linked = false;
    as(parent.name, () => parent.down.forEach((hook) => hook(child.id)));
    as(child.name, () => child.down.forEach((hook) => hook(parent.id)));
  }

  const parentFile = (name: string, value: unknown) => as("parent", () => writeFileSync(join(process.env.KURURU_CONFIG_DIR!, name), JSON.stringify(value)));
  const childPath = (name: string) => join(root, "child", "config", name);
  const childFile = (name: string): unknown => (existsSync(childPath(name)) ? JSON.parse(readFileSync(childPath(name), "utf8")) : null);
  const grantView = (kind: string) => as("parent", () => parent.secrets!.view().grants[child.id]?.find((g) => g.kind === kind));

  beforeEach(() => {
    queue = [];
    linked = false;
    parent = makeSide("parent", "parent", 1);
    child = makeSide("child", "child", 2);
  });
  afterEach(() => {
    parent.secrets?.close();
    child.secrets?.close();
  });

  it("lends a key, follows it when it changes, and takes it back", () => {
    parentFile("openrouter.json", { managementKey: OPENROUTER });
    start(parent, () => child);
    start(child, () => parent);
    linkUp();
    expect(as("parent", () => parent.secrets!.view().catalogue.find((c) => c.kind === "openrouter")?.hint)).toBe(`sk-or-v1-…${OPENROUTER.slice(-4)}`);

    as("parent", () => parent.secrets!.grant(child.id, "openrouter", true));
    flush();
    expect(childFile("openrouter.json")).toEqual({ managementKey: OPENROUTER });
    expect(statSync(childPath("openrouter.json")).mode & 0o777).toBe(0o600);
    expect(child.landed).toEqual(["openrouter"]);
    expect(grantView("openrouter")).toMatchObject({ on: true, state: "held", hint: `sk-or-v1-…${OPENROUTER.slice(-4)}` });
    const held = as("child", () => child.secrets!.view());
    expect(held.heldFrom).toBe("parent");
    expect(held.held.map((h) => h.kind)).toEqual(["openrouter"]);
    expect(JSON.stringify(held)).not.toContain(OPENROUTER);
    expect(JSON.stringify(as("parent", () => parent.secrets!.view()))).not.toContain(OPENROUTER);
    expect(as("child", () => child.secrets!.heldFrom("openrouter"))?.from).toBe("parent");
    expect(() => as("child", () => child.secrets!.refuseIfHeld("openrouter"))).toThrow(/held from parent/);

    // Rotation: a new key pasted on the Mac reaches the child on the next look.
    parentFile("openrouter.json", { managementKey: OPENROUTER_2 });
    as("parent", () => parent.secrets!.lookNow());
    flush();
    expect(childFile("openrouter.json")).toEqual({ managementKey: OPENROUTER_2 });
    expect(grantView("openrouter")?.state).toBe("held");

    as("parent", () => parent.secrets!.grant(child.id, "openrouter", false));
    flush();
    expect(existsSync(childPath("openrouter.json"))).toBe(false);
    expect(grantView("openrouter")).toMatchObject({ on: false, state: "off" });
    expect(grantView("openrouter")?.forgotAt).not.toBeNull();
    expect(as("child", () => child.secrets!.view().held)).toEqual([]);
  });

  it("waits for a child that is away, and sends on its link", () => {
    parentFile("web-firecrawl-self.json", { endpoint: "http://100.64.0.2:3002", apiKey: FIRECRAWL });
    start(parent, () => child);
    start(child, () => parent);
    as("parent", () => parent.secrets!.grant(child.id, "web:firecrawl-self", true));
    expect(grantView("web:firecrawl-self")?.state).toBe("waiting");
    expect(childFile("web-firecrawl-self.json")).toBeNull();
    linkUp();
    expect(childFile("web-firecrawl-self.json")).toEqual({ endpoint: "http://100.64.0.2:3002", apiKey: FIRECRAWL });
    // Unticked while it is away: taken back when it is next linked.
    linkDown();
    as("parent", () => parent.secrets!.grant(child.id, "web:firecrawl-self", false));
    expect(grantView("web:firecrawl-self")?.state).toBe("waiting");
    linkUp();
    expect(childFile("web-firecrawl-self.json")).toBeNull();
  });

  it("refuses a push from a node that is not its parent", () => {
    start(parent, () => child);
    start(child, () => parent);
    linkUp();
    const envelope = as("child", () => seal({ managementKey: OPENROUTER }, { kind: "openrouter", from: child.id, to: child.id, seq: 1 }, child.entry.keys.box, signAsNode));
    // Delivered to the child as if from the parent, but signed by the wrong key.
    as("child", () => child.handlers.get("secrets-put")!(parent.id, { type: "secrets-put", envelope }));
    expect(childFile("openrouter.json")).toBeNull();
    const ack = queue.find((q) => q.message.type === "secrets-ack")?.message as Extract<LinkMessage, { type: "secrets-ack" }>;
    expect(ack.ok).toBe(false);
  });

  it("lends a Claude token as the file logins.ts reads, one group at a time", () => {
    start(parent, () => child);
    start(child, () => parent);
    linkUp();
    as("parent", () => parent.secrets!.lend("machine", CLAUDE, "someone@example.com"));
    expect(statSync(join(root, "parent", "config", "claude-lend.json")).mode & 0o777).toBe(0o600);
    as("parent", () => parent.secrets!.grant(child.id, "claude-token:machine", true));
    flush();
    expect(childFile("claude-token.json")).toEqual({ token: CLAUDE, account: "someone@example.com" });
    expect(as("child", () => lentClaudeEnv())).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE });
    expect(as("parent", () => lentClaudeEnv())).toBeUndefined();
    expect(JSON.stringify(as("parent", () => parent.secrets!.view().lends))).not.toContain(CLAUDE);
  });

  it("never writes over a Codex login the child made itself", () => {
    as("parent", () => {
      mkdirSync(process.env.CODEX_HOME!, { recursive: true });
      writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { refresh_token: "parents", id_token: "a.b.c" } }));
    });
    as("child", () => {
      mkdirSync(process.env.CODEX_HOME!, { recursive: true });
      writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { refresh_token: "its-own" } }));
    });
    start(parent, () => child);
    start(child, () => parent);
    linkUp();
    as("parent", () => parent.secrets!.grant(child.id, "codex-auth:machine", true));
    flush();
    expect(JSON.parse(readFileSync(join(root, "child", "codex", "auth.json"), "utf8"))).toEqual({ tokens: { refresh_token: "its-own" } });
    expect(grantView("codex-auth:machine")).toMatchObject({ state: "failed" });
    expect(grantView("codex-auth:machine")?.error).toMatch(/Codex login of its own/);
  });

  it("puts a Codex login where there is none, and removes only that", () => {
    as("parent", () => {
      mkdirSync(process.env.CODEX_HOME!, { recursive: true });
      writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { refresh_token: "parents" } }));
    });
    start(parent, () => child);
    start(child, () => parent);
    linkUp();
    as("parent", () => parent.secrets!.grant(child.id, "codex-auth:machine", true));
    flush();
    const path = join(root, "child", "codex", "auth.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ tokens: { refresh_token: "parents" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    as("parent", () => parent.secrets!.grant(child.id, "codex-auth:machine", false));
    flush();
    expect(existsSync(path)).toBe(false);
  });

  it("lets go of everything when it leaves the roster, and on a start with no parent", () => {
    parentFile("openrouter.json", { managementKey: OPENROUTER });
    parentFile("telegram.json", { token: TELEGRAM, enabled: true, allowed: [] });
    start(parent, () => child);
    start(child, () => parent);
    linkUp();
    as("parent", () => {
      parent.secrets!.grant(child.id, "openrouter", true);
      parent.secrets!.grant(child.id, "telegram", true);
    });
    flush();
    expect(childFile("telegram.json")).toEqual({ token: TELEGRAM, bot: null });
    as("child", () => child.unpair.forEach((hook) => hook()));
    expect(childFile("openrouter.json")).toBeNull();
    expect(childFile("telegram.json")).toBeNull();

    // Held again, then the server starts as a node in no roster.
    as("parent", () => parent.secrets!.grant(child.id, "openrouter", false));
    flush();
    as("parent", () => parent.secrets!.grant(child.id, "openrouter", true));
    flush();
    expect(childFile("openrouter.json")).not.toBeNull();
    child.secrets!.close();
    child.role = "alone";
    start(child, () => parent);
    expect(childFile("openrouter.json")).toBeNull();
  });
});
