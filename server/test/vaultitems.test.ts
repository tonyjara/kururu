/**
 * The vault's dialog end to end without a window: an ask checked, opened,
 * answered and written — the store in memory, env files in a scratch home —
 * and the edits to an env file on their own, since those are edits to a file
 * kururu does not own.
 *
 * Every value here is made up. The one test that greps output for them is
 * the point of the rest: nothing that leaves the vault carries a value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envShape, quoteEnv, setVariable } from "../../shared/envfile";
import { adoptAskRequest, adoptValues, defaultUse, outcomeLines, validItemName, type AskRequest, type VaultAsk } from "../../shared/vaultitems";
import { decodePieces, encodePieces, type SecretStore } from "../src/keychain";
import { envPath, writeEnvVariable } from "../src/vaultfile";
import { Vault } from "../src/vaultstore";

const PUBLIC = "pk_test_FAKE0123456789abcdef";
const PRIVATE = "sk_test_FAKE'with$odd\"chars";

describe("env files", () => {
  it("replaces only the named variable, keeping export and every other byte", () => {
    const before = "# Pylink, local\nexport DATABASE_URL=postgres://x\nBANCARD_PUBLIC_KEY=old\n\nOTHER='a b' # note\n";
    const after = setVariable(before, "BANCARD_PUBLIC_KEY", PUBLIC);
    expect(after).toBe(`# Pylink, local\nexport DATABASE_URL=postgres://x\nBANCARD_PUBLIC_KEY=${PUBLIC}\n\nOTHER='a b' # note\n`);
    expect(setVariable("export K=1\n", "K", "two")).toBe("export K=two\n");
  });

  it("appends a variable that is not there, after a final newline", () => {
    expect(setVariable("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(setVariable("", "B", "2")).toBe("B=2\n");
  });

  it("replaces every line that sets it, and a quoted value over several lines whole", () => {
    const before = 'K=1\nKEY="-----BEGIN\nabc\n-----END"\nK=2\nZ=9\n';
    expect(setVariable(before, "K", "x")).toBe('K=x\nKEY="-----BEGIN\nabc\n-----END"\nK=x\nZ=9\n');
    expect(setVariable(before, "KEY", "y")).toBe("K=1\nKEY=y\nK=2\nZ=9\n");
  });

  it("refuses a file that is not an env file, and a value with a line break", () => {
    expect(() => setVariable("alias ll='ls -l'\nexport A=1\n", "A", "2")).toThrow(/line 1/);
    expect(() => setVariable('A="never closed\n', "A", "2")).toThrow(/line 1/);
    expect(() => setVariable("", "A", "two\nlines")).toThrow(/line break/);
    expect(() => setVariable("", "1A", "x")).toThrow();
  });

  it("quotes only as needed, and so that a shell reads it back", () => {
    expect(quoteEnv("abc-123_./:+=@,%")).toBe("abc-123_./:+=@,%");
    expect(quoteEnv("a b")).toBe("'a b'");
    expect(quoteEnv(`it's $x "y" \`z\``)).toBe(`"it's \\$x \\"y\\" \\\`z\\\`"`);
    expect(envShape(`A=${quoteEnv(PRIVATE)}\n`).ok).toBe(true);
  });
});

describe("the ask's shape", () => {
  const good = {
    title: "Bancard staging keys for Pylink",
    reason: "Pylink's local checkout reads them.",
    fields: [
      { label: "Public key", name: "pylink/bancard-staging-public", env: { file: "~/.config/pylink-local/env", variable: "BANCARD_PUBLIC_KEY" } },
      { label: "Private key", name: "pylink/bancard-staging-private", env: { file: "~/.config/pylink-local/env", variable: "BANCARD_PRIVATE_KEY" }, use: "ask" },
    ],
  };

  it("takes the Bancard ask", () => {
    const req = adoptAskRequest(good) as AskRequest;
    expect(req.fields.map((f) => f.name)).toEqual(["pylink/bancard-staging-public", "pylink/bancard-staging-private"]);
    expect(req.fields[1]!.use).toBe("ask");
  });

  it("refuses what cannot be an item or a destination", () => {
    const bad = (fields: unknown[]) => "error" in adoptAskRequest({ ...good, fields });
    expect(bad([{ label: "x", name: "Has Spaces" }])).toBe(true);
    expect(bad([{ label: "x", name: "a/../b" }])).toBe(true);
    expect(bad([{ label: "x", name: "a/b/c/d/e" }])).toBe(true);
    expect(bad([{ label: "x", name: "a" }, { label: "y", name: "a" }])).toBe(true);
    expect(bad([{ label: "x", name: "a", env: { file: "relative/env", variable: "A" } }])).toBe(true);
    expect(bad([{ label: "x", name: "a", env: { file: "~/env", variable: "A-B" } }])).toBe(true);
    expect(bad([])).toBe(true);
    expect("error" in adoptAskRequest({ fields: good.fields })).toBe(true);
    expect(validItemName("deck/sudo")).toBe(true);
  });

  it("asks before each use of a sudo password or a production key, by default", () => {
    expect(defaultUse("deck/sudo", "Steam Deck password")).toBe("ask");
    expect(defaultUse("pylink/bancard-prod-private", "Private key")).toBe("ask");
    expect(defaultUse("pylink/bancard-staging-private", "Private key")).toBe("free");
    expect(defaultUse("x/products-api", "Products")).toBe("free");
  });

  it("reads values off the wire as field ids to strings, and nothing else", () => {
    expect([...adoptValues({ "0": "a", "1": 2, x: "b", "10": "c" })!]).toEqual([["0", "a"]]);
    expect(adoptValues(null)).toBeNull();
  });
});

describe("the Keychain's pieces", () => {
  it("keeps a short printable value as itself, anything else as base64 in pieces", () => {
    expect(encodePieces(PUBLIC)).toEqual([PUBLIC]);
    const pem = `-----BEGIN KEY-----\n${"A".repeat(3000)}\n-----END KEY-----`;
    const pieces = encodePieces(pem);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 1800 && /^[\x20-\x7e]*$/.test(p))).toBe(true);
    expect(decodePieces(pieces)).toBe(pem);
    expect(decodePieces(encodePieces("ñandú"))).toBe("ñandú");
    expect(decodePieces(encodePieces("kururu-b64:looks-encoded"))).toBe("kururu-b64:looks-encoded");
  });
});

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

describe("an ask, opened and answered", () => {
  let home: string;
  let log: string[];
  let shown: VaultAsk[][];
  let saved: unknown;
  let store: ReturnType<typeof memoryStore>;
  let vault: Vault;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kururu-vault-"));
    mkdirSync(join(home, ".config", "pylink-local"), { recursive: true });
    writeFileSync(join(home, ".config", "pylink-local", "env"), "DATABASE_URL=postgres://local\nBANCARD_PUBLIC_KEY=old\n", { mode: 0o644 });
    log = [];
    shown = [];
    saved = null;
    store = memoryStore();
    vault = new Vault({
      store,
      changed: (asks) => shown.push(asks),
      checkEnv: (file) => envPath(file, { home }),
      writeEnv: (file, variable, value) => writeEnvVariable(file, variable, value, { home, backups: join(home, "backups") }),
      load: () => null,
      save: (value) => {
        saved = value;
      },
      log: (line) => log.push(line),
      home,
      setTimer: () => 0,
      clearTimer: () => {},
    });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const bancard = () =>
    adoptAskRequest({
      title: "Bancard staging keys for Pylink",
      reason: "For PYL-14.",
      fields: [
        { label: "Public key", name: "pylink/bancard-staging-public", env: { file: "~/.config/pylink-local/env", variable: "BANCARD_PUBLIC_KEY" } },
        { label: "Private key", name: "pylink/bancard-staging-private", env: { file: "~/.config/pylink-local/env", variable: "BANCARD_PRIVATE_KEY" } },
      ],
    }) as AskRequest;

  it("puts each value in the store and its variable, backs the file up, keeps it 0600, and says saved", async () => {
    const { id, done } = vault.ask(bancard(), "Kuru");
    const view = shown.at(-1)![0]!;
    expect(view.kind).toBe("values");
    if (view.kind === "values") expect(view.fields[1]!.env).toEqual({ file: "~/.config/pylink-local/env", variable: "BANCARD_PRIVATE_KEY" });
    const answered = await vault.answer(
      id,
      new Map([
        ["0", PUBLIC],
        ["1", PRIVATE],
      ]),
      new Map([["1", "ask"]]),
    );
    expect(await done).toEqual(answered);
    expect(answered.map((o) => o.outcome)).toEqual(["saved", "saved"]);
    expect(store.values.get("pylink/bancard-staging-private")).toBe(PRIVATE);
    const env = join(home, ".config", "pylink-local", "env");
    const text = readFileSync(env, "utf8");
    expect(text.startsWith(`DATABASE_URL=postgres://local\nBANCARD_PUBLIC_KEY=${PUBLIC}\nBANCARD_PRIVATE_KEY=`)).toBe(true);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    // The first write backed up the file as it was; the second, the file after the first.
    const backups = readdirSync(join(home, "backups"));
    expect(backups.length).toBe(2);
    expect(backups.map((b) => readFileSync(join(home, "backups", b), "utf8"))).toContain("DATABASE_URL=postgres://local\nBANCARD_PUBLIC_KEY=old\n");
    expect(vault.item("pylink/bancard-staging-private")!.use).toBe("ask");
    expect(vault.item("pylink/bancard-staging-public")!.env).toEqual([{ file: "~/.config/pylink-local/env", variable: "BANCARD_PUBLIC_KEY" }]);
    expect(shown.at(-1)).toEqual([]);
    // Nothing that left the vault — what the pages were sent, what was
    // logged, what was kept, what the caller is told — has a value in it.
    const out = JSON.stringify({ shown, log, saved, answered, text: outcomeLines(answered, new Map()) });
    expect(out).not.toContain(PUBLIC);
    expect(out).not.toContain("FAKE");
  });

  it("skips an empty field, and Cancel saves nothing", async () => {
    const one = vault.ask(bancard(), "Kuru");
    expect((await vault.answer(one.id, new Map([["0", PUBLIC]]), new Map())).map((o) => o.outcome)).toEqual(["saved", "skipped"]);
    const two = vault.ask(bancard(), "Kuru");
    await vault.answer(two.id, null, new Map());
    expect((await two.done).map((o) => o.outcome)).toEqual(["cancelled", "cancelled"]);
    expect(store.values.has("pylink/bancard-staging-private")).toBe(false);
    await expect(vault.answer(two.id, null, new Map())).rejects.toThrow(/closed/);
  });

  it("refuses an env file outside home, in ~/.ssh or through a link, before the dialog opens", () => {
    const ask = (file: string) => () =>
      vault.ask(adoptAskRequest({ title: "t", fields: [{ label: "x", name: "a", env: { file, variable: "A" } }] }) as AskRequest, "Kuru");
    expect(ask("/etc/env")).toThrow(/home folder/);
    expect(ask("~/../env")).toThrow(/home folder/);
    expect(ask("~/.ssh/env")).toThrow(/never writes/);
    symlinkSync("/tmp", join(home, "out"));
    expect(ask("~/out/env")).toThrow(/links/);
    writeFileSync(join(home, "real"), "A=1\n");
    symlinkSync(join(home, "real"), join(home, "link"));
    expect(ask("~/link")).toThrow(/symlink/);
    expect(shown).toEqual([]);
  });

  it("keeps the Keychain's copy and says so when the env file refuses", async () => {
    writeFileSync(join(home, "rc"), "alias x=y\n");
    const req = adoptAskRequest({ title: "t", fields: [{ label: "x", name: "a/b", env: { file: "~/rc", variable: "A" } }] }) as AskRequest;
    const { id } = vault.ask(req, "Kuru");
    const [o] = await vault.answer(id, new Map([["0", PUBLIC]]), new Map());
    expect(o!.outcome).toBe("failed");
    expect(store.values.get("a/b")).toBe(PUBLIC);
    expect(readFileSync(join(home, "rc"), "utf8")).toBe("alias x=y\n");
    expect(JSON.stringify(o)).not.toContain(PUBLIC);
  });

  it("closes as cancelled when the caller hangs up", async () => {
    const hangup = new AbortController();
    const { done } = vault.ask(bancard(), "PYL-14 (a12)", hangup.signal);
    hangup.abort();
    expect((await done).map((o) => o.outcome)).toEqual(["cancelled", "cancelled"]);
    expect(vault.asks()).toEqual([]);
  });

  it("never lets a caller make an item free that the owner made ask", async () => {
    const first = vault.ask(bancard(), "Kuru");
    await vault.answer(first.id, new Map([["1", PRIVATE]]), new Map([["1", "ask"]]));
    vault.ask(adoptAskRequest({ title: "t", fields: [{ label: "x", name: "pylink/bancard-staging-private", use: "free" }] }) as AskRequest, "Kuru");
    const view = vault.asks()[0]!;
    expect(view.kind === "values" && view.fields[0]!.use).toBe("ask");
  });
});
