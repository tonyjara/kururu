/**
 * Settings → Vault: what an env file, a Vercel config and the grants are
 * read as, and — on a scratch home full of made-up secrets — that the page
 * names every one of them and carries none of their values out, not even a
 * piece. The private key, the Codex login and the Vercel token are made
 * unreadable first, so a page that lists them has listed them by their
 * being there.
 *
 * Every key and token here is made up in the shape of a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyHint } from "../../shared/openrouter";
import { EMPTY_SECRETS, type CatalogueEntry, type GrantView, type SecretsView } from "../../shared/secrets";
import { envLentTo, envNames, isVercelDir, lentRows, lentTo, vercelTeam } from "../../shared/vaultview";
import { vaultView, type VaultDeps } from "../src/vaultview";
import { fakeOpenSshKey } from "./fakekey";

const NODES = [
  { id: "n0123456789ab", name: "omarchy" },
  { id: "nba9876543210", name: "spare" },
];

function grant(kind: string, over: Partial<GrantView> = {}): GrantView {
  return { kind, on: true, state: "held", hint: "…wxyz", heldSince: 1_700_000_000_000, error: null, forgotAt: null, older: false, ...over };
}

function entry(kind: string, label: string, project: CatalogueEntry["project"] = null): CatalogueEntry {
  return { kind, family: "openrouter", label, unlocks: "", revoke: "", follows: true, hint: null, note: null, project };
}

describe("what a file is read as", () => {
  it("takes an env file's names in its order, and never a value", () => {
    const text = ["# a comment", "DATABASE_URL=postgres://u:hunter2@db/app", "export API_KEY='sk-live-123'", 'MULTI="one', 'two"', "EMPTY=", "DATABASE_URL=again"].join("\n");
    expect(envNames(text)).toEqual(["DATABASE_URL", "API_KEY", "MULTI", "EMPTY"]);
    expect(JSON.stringify(envNames(text))).not.toContain("hunter2");
  });

  it("reads a Vercel config's team by its slug, else its id", () => {
    const id = "team_ABCDEFGHIJKLMNOPQRSTUVWX";
    expect(vercelTeam({ currentTeam: id, cachedTeamSlugs: { [id]: { slug: "acme", savedAt: 1 } } })).toBe("acme");
    expect(vercelTeam({ currentTeam: id })).toBe(id);
    expect(vercelTeam({ currentTeam: id, cachedTeamSlugs: { [id]: { slug: "a b/../c" } } })).toBe(id);
    for (const none of [null, {}, { currentTeam: 7 }, "team", { currentTeam: "x".repeat(101) }]) expect(vercelTeam(none)).toBeNull();
  });

  it("takes vercel-<name> folders as Vercel logins, and nothing else", () => {
    for (const ok of ["vercel-storefront", "vercel-a.b_c"]) expect(isVercelDir(ok)).toBe(true);
    for (const bad of ["vercel", "vercel-", "vercel-a/b", "my-vercel-x", "Vercel-x"]) expect(isVercelDir(bad)).toBe(false);
  });
});

describe("what is lent", () => {
  const secrets: Pick<SecretsView, "catalogue" | "grants"> = {
    catalogue: [entry("openrouter", "OpenRouter management key"), entry("env:0123456789ab", "Env file", { node: NODES[0]!.id, workspace: "storefront", file: ".env.local", from: "~/code/storefront", to: "/home/u/storefront" })],
    grants: {
      [NODES[0]!.id]: [
        grant("openrouter"),
        grant("env:0123456789ab"),
        grant("telegram", { on: false, state: "off", forgotAt: 5 }),
        grant("firecrawl-cloud", { on: false, state: "forgetting" }),
      ],
      [NODES[1]!.id]: [grant("openrouter", { state: "failed", error: "no room" })],
    },
  };

  it("lists what is on or still in a node's hands, node by node, by what it is", () => {
    const rows = lentRows(secrets, NODES);
    expect(rows.map((r) => [r.node.name, r.kind, r.label, r.on])).toEqual([
      ["omarchy", "openrouter", "OpenRouter management key", true],
      ["omarchy", "env:0123456789ab", ".env.local of storefront", true],
      ["omarchy", "firecrawl-cloud", "Cloud Firecrawl key", false],
      ["spare", "openrouter", "OpenRouter management key", true],
    ]);
    expect(rows[0]!.text).toBe("held by omarchy · …wxyz");
    expect(rows[3]!.bad).toBe(true);
  });

  it("says which nodes a key and an env file are switched on for", () => {
    expect(lentTo("openrouter", secrets, NODES)).toEqual(["omarchy", "spare"]);
    expect(lentTo("telegram", secrets, NODES)).toEqual([]);
    expect(envLentTo("~/code/storefront", ".env.local", secrets, NODES)).toEqual(["omarchy"]);
    expect(envLentTo("~/code/storefront", ".env", secrets, NODES)).toEqual([]);
  });
});

describe("the page, off a scratch home", () => {
  let home: string;
  let config: string;
  const saved = { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

  const OPENROUTER = `sk-or-v1-${"0f".repeat(28)}wxyz`;
  const ENV_VALUE = "postgres://app:p4ssw0rd-from-env@db.internal/app";
  const ENV_KEY = "sk_live_51EnvSecretValue000000";
  const GH_TOKEN = `gho_${"A1b2C3d4".repeat(4)}ghtk`;
  const VERCEL_TOKEN = "vca_VercelTokenValue1234567890abcdef";
  const CODEX_REFRESH = "rt_CodexRefreshTokenValue0987654321";
  const KEY = fakeOpenSshKey();
  const SECRETS = [OPENROUTER, ENV_VALUE, ENV_KEY, GH_TOKEN, VERCEL_TOKEN, CODEX_REFRESH, KEY.split("\n")[2]!];

  const write = (path: string, text: string, mode = 0o600) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, { mode });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kururu-vaultview-"));
    config = join(home, ".config", "kururu");
    delete process.env.GH_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;

    write(join(config, "openrouter.json"), JSON.stringify({ managementKey: OPENROUTER }));
    write(join(config, "node.json"), JSON.stringify({ private: "made-up" }));
    write(join(config, "access.json"), JSON.stringify({ token: "made-up-share-token" }));

    // A checkout with two env files, an example that is never offered, a deploy script that names a host, and an origin on github.com.
    const repo = join(home, "code", "storefront");
    write(join(repo, ".env.local"), `DATABASE_URL=${ENV_VALUE}\nSTRIPE_KEY=${ENV_KEY}\n`);
    write(join(repo, "apps", "web", ".env"), "NEXT_PUBLIC_URL=http://localhost:3000\n");
    write(join(repo, ".env.example"), "EXAMPLE_ONLY=\n");
    write(join(repo, "scripts", "deploy.sh"), "rsync -a dist/ vps-prod:/srv/app\n");
    write(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:someone/storefront.git\n');

    write(join(home, ".ssh", "config"), "Host vps-prod\n  HostName 203.0.113.7\n  IdentityFile ~/.ssh/vps_key\n\nHost agent-only\n  IdentityAgent ~/agent.sock\n  IdentityFile ~/.ssh/missing\n");
    write(join(home, ".ssh", "vps_key"), KEY);
    write(join(home, ".config", "gh", "hosts.yml"), `github.com:\n    users:\n        someone:\n            oauth_token: ${GH_TOKEN}\n    oauth_token: ${GH_TOKEN}\n    user: someone\n`);

    write(join(home, ".config", "vercel-acme", "auth.json"), JSON.stringify({ token: VERCEL_TOKEN, userId: "user_secretish" }));
    write(join(home, ".config", "vercel-acme", "config.json"), JSON.stringify({ currentTeam: "team_X", cachedTeamSlugs: { team_X: { slug: "acme-team" } } }), 0o644);
    write(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: CODEX_REFRESH } }));

    // Listed by their being there: none of these can be opened now.
    for (const path of [join(home, ".ssh", "vps_key"), join(home, ".config", "vercel-acme", "auth.json"), join(home, ".codex", "auth.json")]) chmodSync(path, 0o000);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const deps = (over: Partial<VaultDeps> = {}): VaultDeps => ({
    home,
    configDir: config,
    role: "parent",
    hints: { openrouter: keyHint(OPENROUTER), telegram: null, anthropic: null, web: [{ id: "firecrawl-cloud", label: "Firecrawl", hint: null }] },
    secrets: { ...EMPTY_SECRETS, lends: [{ login: "machine", account: "someone@example.com", hint: "…tokn", at: 1_700_000_000_000 }] },
    workspaces: [
      { id: "w1", name: "storefront", profile: "Work", root: join(home, "code", "storefront"), pinned: null },
      { id: "w2", name: "notes", profile: "Work", root: null, pinned: null },
    ],
    claude: [{ name: "this Mac", dir: null, profiles: ["Work"], account: "someone@example.com", signedAt: 1_700_000_000_000 }],
    codex: [{ name: "this Mac", home: join(home, ".codex"), login: "machine", profiles: ["Work"] }],
    ...over,
  });

  it("names everything and carries no value out, not even a piece of one", () => {
    const view = vaultView(deps());
    const json = JSON.stringify(view);
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret);
      expect(json).not.toContain(secret.slice(6, 18));
    }
    expect(json).not.toContain("user_secretish");
    expect(json).not.toContain("made-up");
  });

  it("lists kururu's keys by the hint their page already holds, with where and when", () => {
    const keys = vaultView(deps()).keys;
    const openrouter = keys.find((k) => k.id === "openrouter.json")!;
    expect(openrouter).toMatchObject({ set: true, hint: keyHint(OPENROUTER), where: "~/.config/kururu/openrouter.json", kind: "openrouter", page: "openrouter", never: null });
    expect(openrouter.changed).toBeNumber();
    expect(keys.find((k) => k.id === "telegram.json")).toMatchObject({ set: false, hint: null, changed: null, kind: "telegram" });
    expect(keys.find((k) => k.id === "firecrawl.json")).toMatchObject({ label: "Firecrawl key", set: false, kind: "firecrawl-cloud", page: "web" });
    expect(keys.find((k) => k.id === "claude-token:machine")).toMatchObject({ set: true, hint: "…tokn · someone@example.com", kind: "claude-token:machine" });
    // The Admin key is listed whether or not it is set; the records that never leave only once they exist.
    expect(keys.find((k) => k.id === "anthropic.json")).toMatchObject({ set: false, kind: null, never: expect.stringContaining("Admin key") });
    expect(keys.find((k) => k.id === "node.json")).toMatchObject({ label: "This node's keys", set: true, hint: null, kind: null });
    expect(keys.find((k) => k.id === "access.json")).toMatchObject({ label: "Share token", page: null });
    expect(keys.find((k) => k.id === "grants.json")).toBeUndefined();
  });

  it("lists each workspace's env files by name, and what it seems to use", () => {
    const [storefront, notes] = vaultView(deps()).workspaces;
    expect(storefront).toMatchObject({ name: "storefront", profile: "Work", checkout: "~/code/storefront" });
    expect(storefront!.env.map((e) => [e.file, e.names])).toEqual([
      [".env.local", ["DATABASE_URL", "STRIPE_KEY"]],
      ["apps/web/.env", ["NEXT_PUBLIC_URL"]],
    ]);
    expect(storefront!.ssh).toEqual([{ alias: "vps-prod", why: "scripts/deploy.sh names it" }]);
    expect(storefront!.github).toEqual({ account: "someone", signedIn: true });
    expect(notes).toMatchObject({ checkout: null, env: [], ssh: [], github: null });
  });

  it("puts the host a workspace is pinned to first, said once", () => {
    const view = vaultView(deps({ workspaces: [{ id: "w1", name: "storefront", profile: "Work", root: join(home, "code", "storefront"), pinned: "vps-prod" }] }));
    expect(view.workspaces[0]!.ssh).toEqual([{ alias: "vps-prod", why: "its shells are pinned to it" }]);
  });

  it("lists ssh hosts by their key file's name and gh's accounts by name, neither opened", () => {
    const view = vaultView(deps());
    expect(view.ssh).toEqual([
      { alias: "vps-prod", key: "vps_key", note: null },
      { alias: "agent-only", key: null, note: expect.stringContaining("IdentityAgent") },
    ]);
    expect(view.github).toEqual([{ account: "someone", active: true }]);
  });

  it("lists the other logins by their files being there, Vercel's team out of its settings", () => {
    const logins = vaultView(deps()).logins;
    expect(logins.map((l) => [l.tool, l.name, l.signedIn, l.account, l.team])).toEqual([
      ["claude", "this Mac", true, "someone@example.com", null],
      ["codex", "this Mac", true, null, null],
      ["vercel", "vercel-acme", true, null, "acme-team"],
    ]);
    expect(logins[1]!.kind).toBe("codex-auth:machine");
    expect(logins[2]!.where).toBe("~/.config/vercel-acme");
  });

  it("on a child, says which keys are held from the parent and lists no lending tokens", () => {
    const secrets: SecretsView = { ...EMPTY_SECRETS, heldFrom: "mac", held: [{ kind: "openrouter", label: "OpenRouter management key", hint: "…wxyz", since: 1, updated: 2 }, { kind: "claude-token:machine", label: "Claude login, as a token", hint: "…tokn", since: 1, updated: 3 }] };
    const keys = vaultView(deps({ role: "child", secrets })).keys;
    expect(keys.find((k) => k.id === "openrouter.json")!.heldFrom).toBe("mac");
    expect(keys.find((k) => k.id === "claude-token.json")).toMatchObject({ heldFrom: "mac", hint: "…tokn", changed: 3 });
    expect(keys.some((k) => k.id.startsWith("claude-token:") || k.id === "claude-lend.json")).toBe(false);
  });
});
