/**
 * `vault capture` without a server: a real command that prints a made-up
 * key, kept by a real `Vault` with its store in memory, and everything that
 * left — what the caller was sent, the use log, `vault.json`, what the pages
 * were sent, the server's log lines — searched for the key.
 *
 * Every value here is made up. The commands are `sh -c` one-liners that
 * print JSON the way `aws iam create-access-key` does, and that echo the key
 * on stderr on purpose, which is the accident the masking is for.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultAsk } from "../../shared/vaultitems";
import type { SecretStore } from "../src/keychain";
import { adoptCaptureRequest, parsePath, pick, runCapture, type CaptureRequest } from "../src/vaultcapture";
import { VaultRuns, type RunEvent } from "../src/vaultrun";
import { Vault } from "../src/vaultstore";

const KEY_ID = "AKIAFAKE0000EXAMPLE1";
const SECRET = "wJalrFAKEsecret/K7MDENG+bPxRfiCYEXAMPLEKEY";
const AWS_JSON = JSON.stringify({ AccessKey: { UserName: "kaipago-ses", AccessKeyId: KEY_ID, Status: "Active", SecretAccessKey: SECRET, CreateDate: "2026-11-20T12:00:00Z" } }, null, 4);

function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: "keychain",
    values,
    put: async (name, value) => {
      values.set(name, value);
    },
    get: async (name) => values.get(name) ?? null,
    has: async (name) => values.has(name),
    remove: async (name) => {
      values.delete(name);
    },
  };
}

describe("a capture's shape", () => {
  const base = { argv: ["true"], cwd: "/", item: "kaipago/ses" };

  it("keeps each path as ITEM/PART, or the whole output as ITEM", () => {
    const req = adoptCaptureRequest({ ...base, paths: [{ path: "AccessKey.SecretAccessKey", part: "secret" }, { path: "AccessKey.AccessKeyId", part: "id" }], print: ["AccessKey.AccessKeyId"] }) as CaptureRequest;
    expect(req.targets).toEqual([
      { path: "AccessKey.SecretAccessKey", name: "kaipago/ses/secret" },
      { path: "AccessKey.AccessKeyId", name: "kaipago/ses/id" },
    ]);
    expect((adoptCaptureRequest(base) as CaptureRequest).targets).toEqual([{ path: null, name: "kaipago/ses" }]);
    expect((adoptCaptureRequest({ ...base, paths: [{ path: "token" }] }) as CaptureRequest).targets).toEqual([{ path: "token", name: "kaipago/ses" }]);
  });

  it("refuses printing what reads as a secret, two paths into one item, and names that cannot be items", () => {
    const err = (extra: Record<string, unknown>) => (adoptCaptureRequest({ ...base, ...extra }) as { error?: string }).error;
    expect(err({ paths: [{ path: "a", part: "x" }], print: ["AccessKey.SecretAccessKey"] })).toMatch(/reads as a secret/);
    expect(err({ paths: [{ path: "a", part: "x" }, { path: "b", part: "x" }] })).toMatch(/item of its own/);
    expect(err({ paths: [{ path: "a", part: "Upper" }] })).toMatch(/part/);
    expect(err({ item: "a/b/c/d", paths: [{ path: "a", part: "x" }] })).toMatch(/four/);
    expect(err({ item: "Not An Item" })).toMatch(/ITEM/);
    expect(err({ print: ["AccessKey.AccessKeyId"] })).toMatch(/--json-path/);
    expect(err({ paths: [{ path: "a..b", part: "x" }] })).toMatch(/json-path/);
    expect(err({ use: "free" })).toMatch(/Only the owner/);
  });

  it("reads a path into objects and arrays", () => {
    expect(parsePath("Items[1].Key")).toEqual(["Items", 1, "Key"]);
    expect(pick({ Items: [{ Key: "a" }, { Key: "b" }] }, parsePath("Items[1].Key")!)).toBe("b");
    expect(pick({ a: 1 }, ["toString"])).toBeUndefined();
    expect(parsePath("")).toBeNull();
  });
});

describe("a capture", () => {
  let dir: string;
  let store: ReturnType<typeof memoryStore>;
  let vault: Vault;
  let runs: VaultRuns;
  let shown: VaultAsk[][];
  let saved: unknown;
  let logLines: string[];
  /** What the owner does with a replace dialog when it opens. */
  let onReplace: (ask: Extract<VaultAsk, { kind: "use" }>) => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-vaultcapture-"));
    // What the stand-in for the AWS CLI prints, read from a file, so the
    // key is not on the command line, as it is not on a real one.
    writeFileSync(join(dir, "made.json"), `${AWS_JSON}\n`);
    store = memoryStore();
    shown = [];
    saved = null;
    logLines = [];
    onReplace = (ask) => vault.allow(ask.id, "deny");
    vault = new Vault({
      store,
      changed: (asks) => {
        shown.push(asks);
        const replace = asks.find((a): a is Extract<VaultAsk, { kind: "use" }> => a.kind === "use" && a.replace === true);
        if (replace) queueMicrotask(() => onReplace(replace));
      },
      load: () => null,
      save: (v) => (saved = v),
      log: (l) => logLines.push(l),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    runs = new VaultRuns({
      item: (name) => vault.item(name),
      valueOf: (name) => vault.valueOf(name),
      used: (names, by) => vault.used(names, by),
      approve: (run, note, signal) => vault.approve(run, note, signal),
      askpassPath: () => join(dir, "askpass"),
      filesDir: () => join(dir, "files"),
      port: 1,
      logPath: () => join(dir, "uses.jsonl"),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const capture = async (raw: Record<string, unknown>) => {
    const req = adoptCaptureRequest({ cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, item: "kaipago/ses", ...raw });
    if ("error" in req) throw new Error(req.error);
    const events: RunEvent[] = [];
    await runCapture(req, { name: "KAI-12 (a7)", agentId: "a7" }, (ev) => events.push(ev), new AbortController().signal, {
      has: (name) => vault.has(name),
      labelOf: (name) => vault.item(name)?.label ?? null,
      confirmReplace: (run, note, signal) => vault.confirmReplace(run, note, signal),
      keep: (values, source, replace) => vault.capture(values, source, replace),
      record: (use) => runs.record(use),
    });
    const decode = (key: "o" | "e") => events.map((e) => (key in e ? Buffer.from((e as Record<string, string>)[key]!, "base64").toString() : "")).join("");
    const exit = events.find((e): e is { exit: number | null } => "exit" in e)?.exit;
    return { events, out: decode("o"), err: decode("e"), notes: events.flatMap((e) => ("note" in e ? [e.note] : [])).join("\n"), exit };
  };

  /** Everything that left the vault, as text: the caller's events, the use log, vault.json, the pages, the server's log. */
  const everywhere = (events: RunEvent[]) =>
    [
      JSON.stringify(events),
      events.map((e) => ("o" in e ? Buffer.from(e.o, "base64").toString() : "e" in e ? Buffer.from(e.e, "base64").toString() : "")).join(""),
      existsSync(join(dir, "uses.jsonl")) ? readFileSync(join(dir, "uses.jsonl"), "utf8") : "",
      JSON.stringify(saved),
      JSON.stringify(shown),
      logLines.join("\n"),
      JSON.stringify(vault.list()),
    ].join("\n");

  const awsLike = (stderr = "") => ["sh", "-c", `cat made.json\n${stderr}`];

  it("keeps the secret and the id, prints only the id, and the secret is nowhere the caller, a log or a page could see", async () => {
    const r = await capture({
      argv: awsLike(`echo "debug: signed with ${SECRET}" >&2`),
      paths: [
        { path: "AccessKey.SecretAccessKey", part: "secret" },
        { path: "AccessKey.AccessKeyId", part: "id" },
      ],
      print: ["AccessKey.AccessKeyId"],
      label: "Kaipago SES sender",
    });
    expect(r.exit).toBe(0);
    expect(store.values.get("kaipago/ses/secret")).toBe(SECRET);
    expect(store.values.get("kaipago/ses/id")).toBe(KEY_ID);
    expect(r.out).toBe(`AccessKey.AccessKeyId=${KEY_ID}\n`);
    expect(r.err).toBe("debug: signed with [vault:kaipago/ses]\n");
    expect(r.notes).toContain("kept kaipago/ses/secret, from AccessKey.SecretAccessKey");
    expect(everywhere(r.events)).not.toContain(SECRET);
    expect(everywhere(r.events)).not.toContain("FAKEsecret");
    // Nor its base64, which is how a key most often comes back in a header.
    expect(everywhere(r.events)).not.toContain(Buffer.from(SECRET).toString("base64"));
  });

  it("records who captured it, with what, when and where, in the item, the use log and the captures' history, and puts nothing on the screens", async () => {
    await capture({ argv: awsLike(), paths: [{ path: "AccessKey.SecretAccessKey", part: "secret" }], label: "Kaipago SES sender" });
    const item = vault.item("kaipago/ses/secret")!;
    expect(item.label).toBe("Kaipago SES sender · AccessKey.SecretAccessKey");
    expect(item.by).toBe("KAI-12 (a7)");
    expect(item.history![0]).toMatchObject({ how: "captured", by: "KAI-12 (a7)" });
    expect(item.history![0]!.command).toContain("sh -c");
    const [use] = runs.uses();
    expect(use).toMatchObject({ kind: "capture", by: "KAI-12 (a7)", agentId: "a7", names: ["kaipago/ses/secret"], approved: "free", code: 0 });
    const [event] = vault.captures();
    expect(event).toMatchObject({ by: "KAI-12 (a7)", cwd: dir, items: [{ name: "kaipago/ses/secret", label: "Kaipago SES sender · AccessKey.SecretAccessKey" }] });
    expect(event!.command).toContain("sh -c");
    expect((saved as { captures: unknown[] }).captures).toEqual(vault.captures());
    // Nothing for the owner to dismiss: a capture that replaces nothing asks nothing.
    expect(vault.asks()).toEqual([]);
    expect(shown).toEqual([]);
  });

  it("hands a captured item to vault run like a pasted one, masked in its output", async () => {
    await capture({ argv: awsLike(), paths: [{ path: "AccessKey.SecretAccessKey", part: "secret" }] });
    const events: RunEvent[] = [];
    await runs.run(
      { argv: ["sh", "-c", 'test "$AWS_SECRET_ACCESS_KEY" = "' + SECRET + '" && echo "have $AWS_SECRET_ACCESS_KEY"'], cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, secrets: [{ name: "kaipago/ses/secret", variable: "AWS_SECRET_ACCESS_KEY" }], files: [], askpass: null },
      { name: "KAI-12 (a7)", agentId: "a7" },
      (ev) => events.push(ev),
      new AbortController().signal,
    );
    const out = events.map((e) => ("o" in e ? Buffer.from(e.o, "base64").toString() : "")).join("");
    expect(out).toBe("have [vault:kaipago/ses/secret]\n");
    expect(events.at(-1)).toEqual({ exit: 0 });
  });

  it("keeps the whole of stdout, trimmed, when no path is named", async () => {
    const r = await capture({ item: "kaipago/token", argv: ["sh", "-c", `printf '  %s\\n' '${SECRET}'`] });
    expect(r.exit).toBe(0);
    expect(store.values.get("kaipago/token")).toBe(SECRET);
    expect(r.out).toBe("");
    expect(everywhere(r.events)).not.toContain(SECRET);
  });

  it("keeps none of the fields when one is missing, keeps the whole output instead, and says which keys were there — never a value", async () => {
    const r = await capture({ argv: awsLike(), paths: [{ path: "AccessKey.Secret", part: "secret" }, { path: "AccessKey.AccessKeyId", part: "id" }] });
    expect(r.exit).toBe(1);
    expect(store.values.has("kaipago/ses/secret")).toBe(false);
    expect(store.values.has("kaipago/ses/id")).toBe(false);
    expect(store.values.get("kaipago/ses")).toBe(AWS_JSON);
    expect(r.notes).toContain("AccessKey.Secret is not in what sh printed");
    expect(r.notes).toContain("AccessKey.SecretAccessKey");
    expect(r.notes).toContain("kept as kaipago/ses instead");
    expect(everywhere(r.events)).not.toContain(SECRET);
    expect(everywhere(r.events)).not.toContain(KEY_ID);
  });

  it("says what was lost when the whole output cannot be kept either", async () => {
    await vault.capture([{ name: "kaipago/ses", label: "old", value: "old-FAKE-value", use: null }], { by: "x", command: "x", cwd: "~" }, new Set());
    const r = await capture({ argv: ["sh", "-c", `echo 'not json ${SECRET}'`], paths: [{ path: "AccessKey.SecretAccessKey", part: "secret" }] });
    expect(r.exit).toBe(1);
    expect(r.notes).toContain("is not JSON");
    expect(r.notes).toContain("deleted or rotated");
    expect(store.values.get("kaipago/ses")).toBe("old-FAKE-value");
    expect(everywhere(r.events)).not.toContain(SECRET);
  });

  it("keeps nothing from a command that fails, exits with its code, and shows its stderr with what it printed masked", async () => {
    const r = await capture({ argv: ["sh", "-c", `echo '{"token":"${SECRET}"}'; echo "error: rejected ${SECRET}" >&2; exit 254`], paths: [{ path: "token", part: "t" }] });
    expect(r.exit).toBe(254);
    expect(store.values.size).toBe(0);
    expect(r.err).toBe("error: rejected [vault:kaipago/ses]\n");
    expect(r.notes).toContain("exited 254; nothing was kept");
    expect(everywhere(r.events)).not.toContain(SECRET);
    expect(runs.uses()[0]).toMatchObject({ kind: "capture", code: 254 });
  });

  it("says a command that is not there, and keeps nothing", async () => {
    const r = await capture({ argv: ["kururu-no-such-command-xyz"] });
    expect(r.exit).toBe(127);
    expect(r.notes).toContain("not found on the PATH");
  });

  it("asks the owner before replacing an item, and runs nothing when they say no", async () => {
    await vault.capture([{ name: "kaipago/ses/secret", label: "old", value: "old-FAKE-value", use: null }], { by: "x", command: "x", cwd: "~" }, new Set());
    const ran = join(dir, "ran");
    const r = await capture({ argv: ["sh", "-c", `touch ${ran}; cat made.json`], paths: [{ path: "AccessKey.SecretAccessKey", part: "secret" }] });
    expect(r.exit).toBe(77);
    expect(existsSync(ran)).toBe(false);
    expect(store.values.get("kaipago/ses/secret")).toBe("old-FAKE-value");
    expect(r.notes).toContain("waiting for the owner to allow replacing it");
    const asked = shown.flat().find((a) => a.kind === "use");
    expect(asked).toMatchObject({ kind: "use", replace: true, lasting: false, items: [{ name: "kaipago/ses/secret", label: "old" }] });
    expect(runs.uses()[0]).toMatchObject({ kind: "capture", approved: "denied", code: null });
  });

  it("replaces it when the owner allows, keeping the item's rule and saying so in its history", async () => {
    await vault.capture([{ name: "kaipago/ses/secret", label: "old", value: "old-FAKE-value", use: "ask" }], { by: "x", command: "x", cwd: "~" }, new Set());
    onReplace = (ask) => vault.allow(ask.id, "once");
    const r = await capture({ argv: awsLike(), paths: [{ path: "AccessKey.SecretAccessKey", part: "secret" }] });
    expect(r.exit).toBe(0);
    expect(r.notes).toContain("kept kaipago/ses/secret (replaced)");
    expect(store.values.get("kaipago/ses/secret")).toBe(SECRET);
    const item = vault.item("kaipago/ses/secret")!;
    expect(item.use).toBe("ask");
    expect(item.history!.map((h) => h.how)).toEqual(["captured", "captured"]);
    expect(runs.uses()[0]).toMatchObject({ approved: "owner", code: 0 });
    expect(everywhere(r.events)).not.toContain(SECRET);
  });

  it("refuses an item that appeared while the command ran, rather than replacing it unasked", async () => {
    const racing = capture({ argv: ["sh", "-c", "sleep 0.3; echo '{\"k\":\"" + SECRET + "2\"}'"], paths: [{ path: "k", part: "racing" }] });
    await new Promise((res) => setTimeout(res, 100));
    await vault.capture([{ name: "kaipago/ses/racing", label: "theirs", value: "theirs-FAKE", use: null }], { by: "y", command: "y", cwd: "~" }, new Set());
    const raced = await racing;
    expect(raced.exit).toBe(1);
    expect(raced.notes).toContain("kept by somebody else while the command ran");
    expect(store.values.get("kaipago/ses/racing")).toBe("theirs-FAKE");
  });

  it("keeps the captures' history in vault.json across a restart, newest first, with no value in it", async () => {
    let kept: unknown = null;
    const quiet = { store, changed: () => {}, log: () => {}, setTimer: () => 0, clearTimer: () => {} };
    const first = new Vault({ ...quiet, load: () => null, save: (v) => (kept = v) });
    await first.capture([{ name: "kaipago/x", label: "x", value: "FAKE-value-x", use: null }], { by: "KAI-12 (a7)", command: "mint", cwd: "~" }, new Set());
    await first.capture([{ name: "kaipago/y", label: "y", value: "FAKE-value-y", use: null }], { by: "Kuru", command: "mint again", cwd: "~/x" }, new Set());
    const second = new Vault({ ...quiet, load: () => kept, save: () => {} });
    expect(second.captures().map((c) => [c.by, c.command, c.cwd, c.items.map((i) => i.name)])).toEqual([
      ["Kuru", "mint again", "~/x", ["kaipago/y"]],
      ["KAI-12 (a7)", "mint", "~", ["kaipago/x"]],
    ]);
    expect(JSON.stringify(kept)).not.toContain("FAKE-value");
    // A history already begun is not begun again from the use log.
    second.seedCaptures(() => {
      throw new Error("read the use log again");
    });
    expect(second.captures()).toHaveLength(2);
  });

  it("begins the captures' history from the use log once, with the captures that kept something", () => {
    let kept: unknown = null;
    const quiet = { store, changed: () => {}, log: () => {}, setTimer: () => 0, clearTimer: () => {} };
    const old = { v: 1, items: { "kaipago/ses/secret": { label: "Kaipago SES sender", use: "free", env: [], createdAt: 1, updatedAt: 1, by: "KAI-12 (a7)", lastUse: null } } };
    const v = new Vault({ ...quiet, load: () => old, save: (x) => (kept = x) });
    const line = { by: "KAI-12 (a7)", agentId: "a7", command: "aws iam create-access-key", cwd: "~/kaipago", ms: 1 };
    v.seedCaptures(() => [
      { ...line, at: 4, names: ["vault/run"], approved: "free", code: 0 },
      { ...line, at: 3, names: ["kaipago/ses/secret"], approved: "owner", code: 0, kind: "capture" },
      { ...line, at: 2, names: ["kaipago/ses/secret"], approved: "denied", code: null, kind: "capture" },
      { ...line, at: 1, names: ["kaipago/ses/gone"], approved: "free", code: 1, kind: "capture" },
    ]);
    expect(v.captures()).toEqual([{ at: 3, by: "KAI-12 (a7)", command: "aws iam create-access-key", cwd: "~/kaipago", items: [{ name: "kaipago/ses/secret", label: "Kaipago SES sender" }] }]);
    expect((kept as { captures: unknown }).captures).toEqual(v.captures());
  });
});
