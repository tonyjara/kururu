/**
 * The broker without a server: the masker on its edges, and a real command
 * run with a made-up secret in its environment, its output read back for
 * the value, the use log read for it too, and a run that is not allowed.
 *
 * Every value is made up. The commands are `sh -c` one-liners that print
 * their environment on purpose, which is the accident the masker is for.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Masker, maskText } from "../../shared/mask";
import type { VaultItemView } from "../../shared/vaultitems";
import { adoptRunRequest, commandText, sweepRunFiles, VaultRuns, type Approval, type RunEvent, type RunRequest } from "../src/vaultrun";

const SECRET = "sk_test_FAKE_0123456789";

describe("the masker", () => {
  const secrets = [{ name: "a/key", value: SECRET }];

  it("takes out the value, its base64 and its URL-encoding", () => {
    const b64 = Buffer.from(SECRET).toString("base64");
    expect(maskText(`key=${SECRET} basic ${b64} q=${encodeURIComponent("x y" + SECRET)}`, secrets)).not.toContain("FAKE");
    expect(maskText(`key=${SECRET}`, secrets)).toBe("key=[vault:a/key]");
  });

  it("catches a value split across chunks at every byte", () => {
    const text = `before ${SECRET} after ${SECRET}`;
    for (let cut = 1; cut < text.length; cut += 1) {
      const m = new Masker(secrets);
      const out = Buffer.concat([m.push(Buffer.from(text.slice(0, cut))), m.push(Buffer.from(text.slice(cut))), m.end()]).toString();
      expect(out).toBe("before [vault:a/key] after [vault:a/key]");
    }
  });

  it("catches a value with multi-byte characters split inside one", () => {
    const value = "contraseña-FAKE";
    const bytes = Buffer.from(`x${value}y`);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const m = new Masker([{ name: "deck/sudo", value }]);
      const out = Buffer.concat([m.push(bytes.subarray(0, cut)), m.push(bytes.subarray(cut)), m.end()]).toString();
      expect(out).toBe("x[vault:deck/sudo]y");
    }
  });

  it("masks bytes as they are, split anywhere, and a pattern a megabyte long without stalling", () => {
    const bytes = Buffer.from([0x30, 0x82, 0x0a, 0xff, 0x00, 0x13, 0x37, 0x99, 0x42]);
    const text = Buffer.concat([Buffer.from("a "), bytes, Buffer.from(" b")]);
    for (let cut = 1; cut < text.length; cut += 1) {
      const m = new Masker([{ name: "c/p12", value: "", bytes }]);
      const out = Buffer.concat([m.push(text.subarray(0, cut)), m.push(text.subarray(cut)), m.end()]).toString();
      expect(out).toBe("a [vault:c/p12] b");
    }
    const big = Buffer.alloc(1024 * 1024, 7);
    big[0] = 0x30;
    const m = new Masker([{ name: "c/big", value: big.toString("base64"), bytes: big }]);
    const started = Date.now();
    const noise = Buffer.from("M".repeat(64 * 1024));
    let out = 0;
    for (let i = 0; i < 16; i += 1) out += m.push(noise).length;
    out += m.end().length;
    expect(out).toBe(16 * noise.length);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("leaves a value too short to mask, and output with nothing to mask, alone", () => {
    expect(maskText("a b c", [{ name: "x", value: "a" }])).toBe("a b c");
    expect(maskText("plain", [])).toBe("plain");
  });
});

describe("a run", () => {
  let dir: string;
  const items = new Map<string, VaultItemView>();
  const values = new Map<string, string>();
  let approval: Approval;
  let usedBy: string[];
  let runs: VaultRuns;

  const item = (name: string, use: "free" | "ask" = "free"): VaultItemView => ({ name, label: name, use, file: null, store: "keychain", env: [], createdAt: 0, updatedAt: 0, by: "", lastUse: null });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-vaultrun-"));
    items.clear();
    values.clear();
    items.set("a/key", item("a/key"));
    values.set("a/key", SECRET);
    approval = "free";
    usedBy = [];
    runs = new VaultRuns({
      item: (name) => items.get(name) ?? null,
      valueOf: async (name) => values.get(name) ?? null,
      used: (_names, by) => usedBy.push(by),
      approve: async () => approval,
      askpassPath: () => join(dir, "askpass"),
      filesDir: () => join(dir, "files"),
      port: 1,
      logPath: () => join(dir, "uses.jsonl"),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (req: Partial<RunRequest>) => {
    const events: RunEvent[] = [];
    const full: RunRequest = { argv: ["sh", "-c", "true"], cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, secrets: [{ name: "a/key", variable: "KEY" }], files: [], askpass: null, ...req };
    await runs.run(full, { name: "PYL-14 (a12)", agentId: "a12" }, (ev) => events.push(ev), new AbortController().signal);
    const text = (key: "o" | "e") => Buffer.concat(events.filter((e): e is { o: string } & { e: string } => key in e).map((e) => Buffer.from((e as Record<string, string>)[key]!, "base64"))).toString();
    return { events, out: text("o"), err: text("e"), exit: events.find((e) => "exit" in e) as { exit: number | null } | undefined };
  };

  it("gives the command the value, and gives the caller its output with the value masked", async () => {
    const r = await run({ argv: ["sh", "-c", 'test "$KEY" = "' + SECRET + '" && echo "ok $KEY" && echo "err $KEY" >&2 && exit 3'] });
    expect(r.exit?.exit).toBe(3);
    expect(r.out).toBe("ok [vault:a/key]\n");
    expect(r.err).toBe("err [vault:a/key]\n");
    expect(usedBy).toEqual(["PYL-14 (a12)"]);
  });

  it("logs who, which item, the command and how it ended — and never the value, even one typed into the command", async () => {
    await run({ argv: ["sh", "-c", `echo ${SECRET} >/dev/null`] });
    const log = readFileSync(join(dir, "uses.jsonl"), "utf8");
    expect(log).not.toContain("FAKE");
    expect(statSync(join(dir, "uses.jsonl")).mode & 0o777).toBe(0o600);
    const [use] = runs.uses();
    expect(use).toMatchObject({ by: "PYL-14 (a12)", agentId: "a12", names: ["a/key"], approved: "free", code: 0 });
    expect(use!.command).toContain("[vault:a/key]");
    runs.clearUses();
    expect(runs.uses()).toEqual([]);
  });

  it("runs nothing when the owner says no, and logs that it was denied", async () => {
    approval = "denied";
    const r = await run({ argv: ["sh", "-c", `touch ${join(dir, "ran")}`] });
    expect(r.exit?.exit).toBe(77);
    expect(() => statSync(join(dir, "ran"))).toThrow();
    expect(runs.uses()[0]!.approved).toBe("denied");
  });

  it("refuses an item that is not kept, before anything runs", async () => {
    const r = await run({ secrets: [{ name: "no/such", variable: "X" }] });
    expect(r.exit?.exit).toBe(2);
  });

  it("gives sudo's askpass a ticket good for three trades during the run, and none after", async () => {
    let ticket = "";
    const r = await run({
      secrets: [],
      askpass: "a/key",
      argv: ["sh", "-c", 'echo "$KURURU_VAULT_TICKET"; test -z "$KEY"; echo "$SUDO_ASKPASS"'],
    });
    ticket = r.out.split("\n")[0]!;
    expect(r.out.split("\n")[1]).toBe(join(dir, "askpass"));
    expect(r.exit?.exit).toBe(0);
    // The run is over, so its ticket is spent.
    expect(await runs.askpass(ticket)).toBeNull();
  });

  it("trades a live ticket for the value three times, then no more", async () => {
    const trades: (string | null)[] = [];
    let asked: Promise<void> | null = null;
    const full: RunRequest = { argv: ["sh", "-c", 'echo "$KURURU_VAULT_TICKET"; sleep 1'], cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, secrets: [], files: [], askpass: "a/key" };
    await runs.run(
      full,
      { name: "a shell", agentId: null },
      (ev) => {
        if ("o" in ev && !asked) {
          const ticket = Buffer.from(ev.o, "base64").toString().trim();
          asked = (async () => {
            for (let i = 0; i < 4; i += 1) trades.push(await runs.askpass(ticket));
          })();
        }
      },
      new AbortController().signal,
    );
    await asked;
    expect(trades.map((t) => t === SECRET)).toEqual([true, true, true, false]);
  });

  it("hands a file item over as a 0600 file under its own name, its path in the variable, and removes it after", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FAKE\n-----END PRIVATE KEY-----\n";
    items.set("c/cert", { ...item("c/cert"), file: { name: "cert.pem", size: pem.length } });
    values.set("c/cert", Buffer.from(pem).toString("base64"));
    const r = await run({
      secrets: [],
      files: [{ name: "c/cert", variable: "CERT" }],
      argv: ["sh", "-c", 'echo "$CERT"; stat -f %Lp "$CERT"; stat -f %Lp "$(dirname "$(dirname "$CERT")")"; wc -c < "$CERT"; head -2 "$CERT"; exit 4'],
    });
    const [path, mode, dirMode, size, , line] = r.out.split("\n").map((l) => l.trim());
    expect(path!.startsWith(join(dir, "files", "run-"))).toBe(true);
    expect(path!.endsWith("/cert.pem")).toBe(true);
    expect(mode).toBe("600");
    expect(dirMode).toBe("700");
    expect(Number(size)).toBe(pem.length);
    // A line of the key printed alone is masked too.
    expect(line).toBe("[vault:c/cert]");
    expect(r.out).not.toContain("FAKE");
    expect(r.exit?.exit).toBe(4);
    expect(existsSync(path!)).toBe(false);
    expect(readdirSync(join(dir, "files"))).toEqual([]);
  });

  it("gives a file item's base64 to --secret, and masks its bytes and its base64", async () => {
    const bytes = Buffer.from([0x30, 0x82, 0x01, 0x02, 0xfe, 0x46, 0x41, 0x4b, 0x45]);
    items.set("c/p12", { ...item("c/p12"), file: { name: "c.p12", size: bytes.length } });
    values.set("c/p12", bytes.toString("base64"));
    const r = await run({ secrets: [{ name: "c/p12", variable: "P12" }], argv: ["sh", "-c", 'echo "$P12"; printf "%s" "$P12" | base64 -d'] });
    expect(r.out).toBe("[vault:c/p12]\n[vault:c/p12]");
  });

  it("removes the file when the command cannot start, and when the item is gone", async () => {
    items.set("c/cert", { ...item("c/cert"), file: { name: "c.p8", size: 4 } });
    values.set("c/cert", Buffer.from("FAKE").toString("base64"));
    const r = await run({ secrets: [], files: [{ name: "c/cert", variable: "CERT" }], argv: ["/no/such/command"] });
    expect(r.exit?.exit).toBe(127);
    expect(readdirSync(join(dir, "files"))).toEqual([]);
    values.delete("c/cert");
    const r2 = await run({ secrets: [{ name: "a/key", variable: "KEY" }], files: [{ name: "c/cert", variable: "CERT" }] });
    expect(r2.exit?.exit).toBe(2);
    expect(readdirSync(join(dir, "files"))).toEqual([]);
  });

  it("sweeps run folders a dead server left, but not one a run may still be using", () => {
    const files = join(dir, "files");
    mkdirSync(join(files, "run-old"), { recursive: true });
    mkdirSync(join(files, "run-new"));
    mkdirSync(join(files, "other"));
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(join(files, "run-old"), old, old);
    expect(sweepRunFiles(files)).toBe(1);
    expect(readdirSync(files).sort()).toEqual(["other", "run-new"]);
  });

  it("reads a caller's run off the wire, and refuses one without a command or an item", () => {
    expect(adoptRunRequest({ argv: ["x"], cwd: dir, files: [{ name: "c/cert", variable: "CERT" }] })).toMatchObject({ files: [{ name: "c/cert", variable: "CERT" }] });
    expect("error" in adoptRunRequest({ argv: ["x"], cwd: dir, secrets: [{ name: "a/key", variable: "K" }], files: [{ name: "c/cert", variable: "K" }] })).toBe(true);
    expect("error" in adoptRunRequest({ argv: [], cwd: dir, secrets: [{ name: "a/key", variable: "K" }] })).toBe(true);
    expect("error" in adoptRunRequest({ argv: ["x"], cwd: "relative", secrets: [{ name: "a/key", variable: "K" }] })).toBe(true);
    expect("error" in adoptRunRequest({ argv: ["x"], cwd: dir, secrets: [] })).toBe(true);
    expect("error" in adoptRunRequest({ argv: ["x"], cwd: dir, secrets: [{ name: "a/key", variable: "1K" }] })).toBe(true);
    expect(adoptRunRequest({ argv: ["x"], cwd: dir, env: { A: "1", "bad-name": "2" }, secrets: [{ name: "a/key", variable: "K" }] })).toMatchObject({ env: { A: "1" } });
    expect(commandText(["bun", "run", "smoke test"])).toBe("bun run 'smoke test'");
  });
});
