/**
 * A project's secrets, lent: what an ssh config, a known_hosts file, a key
 * and gh's hosts file are read as, and — on a scratch home — that an env
 * file, an ssh entry and a GitHub login land where their programs look and
 * leave nothing of theirs behind when taken back, and never go over what
 * was the node's own.
 *
 * Every key and token here is made up in the shape of a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSshValue,
  envPathOk,
  ghAccounts,
  ghEnv,
  ghTokenInFile,
  knownHostNames,
  lendableBlocks,
  matchKnownHosts,
  mentionedHosts,
  ownHostClash,
  parseSshConfig,
  privateKeyInfo,
  remoteOwner,
  sshConf,
  travelling,
  validGhToken,
  withInclude,
  withoutInclude,
  type SshValue,
} from "../../shared/vault";
import { findEnvFiles, hostsMentioned, placeEnv, placeGh, placeSsh, removeGh, removeSsh } from "../src/vault";
import { fakeOpenSshKey } from "./fakekey";

const GH_TOKEN = `gho_${"A1b2C3d4".repeat(4)}wxyz`;

describe("env files", () => {
  it("takes a path to an env file under the checkout and nothing else", () => {
    for (const ok of [".env", ".env.local", ".env.production.local", "apps/web/.env", "apps/web/.env.local"]) expect(envPathOk(ok)).toBe(true);
    for (const bad of ["", ".env.example", ".env.local.bak-20261016-2024", "../.env", "/etc/.env", "a/../.env", "node_modules/x/.env", "a/b/c/.env", "config.json", ".envrc", 1]) expect(envPathOk(bad)).toBe(false);
  });
});

describe("ssh config", () => {
  const CONFIG = [
    "Host *",
    "  AddKeysToAgent yes",
    "",
    "Host vps vps-old",
    "  HostName 203.0.113.7",
    "  User deploy",
    "  Port 2222",
    "  IdentityFile ~/.ssh/vps_key",
    "  UseKeychain yes",
    "  IdentityAgent ~/agent.sock",
    "  ProxyCommand nc %h %p",
    "",
    "Match host other",
    "  User nobody",
    "",
    'Host gitlab.com',
    '  IdentityFile "~/.ssh/my gitlab"',
  ].join("\n");

  it("reads the blocks that name one host, by their first name", () => {
    const blocks = lendableBlocks(parseSshConfig(CONFIG));
    expect([...blocks.keys()]).toEqual(["vps", "gitlab.com"]);
    expect(blocks.get("vps")!.names).toEqual(["vps", "vps-old"]);
  });

  it("lends only what means the same on another machine", () => {
    const block = lendableBlocks(parseSshConfig(CONFIG)).get("vps")!;
    const { lines, left } = travelling(block);
    expect(lines).toEqual(["HostName 203.0.113.7", "User deploy", "Port 2222"]);
    expect(left).toEqual(["UseKeychain", "IdentityAgent", "ProxyCommand"]);
    expect(knownHostNames(block, "vps")).toEqual(["[203.0.113.7]:2222"]);
  });

  it("finds a host's known_hosts lines, plain or hashed", () => {
    const salt = Buffer.alloc(20, 3).toString("base64");
    const hashed = createHmac("sha1", Buffer.from(salt, "base64")).update("[203.0.113.7]:2222").digest("base64");
    const text = [`|1|${salt}|${hashed} ssh-ed25519 AAAAC3one`, "[203.0.113.7]:2222,other ssh-rsa AAAAB3two", "elsewhere ssh-ed25519 AAAAC3three", "@revoked [203.0.113.7]:2222 ssh-rsa AAAA"].join("\n");
    const hmac = (s: string, name: string) => createHmac("sha1", Buffer.from(s, "base64")).update(name).digest("base64");
    expect(matchKnownHosts(text, ["[203.0.113.7]:2222"], hmac)).toEqual([`|1|${salt}|${hashed} ssh-ed25519 AAAAC3one`, "[203.0.113.7]:2222,other ssh-rsa AAAAB3two"]);
  });

  it("reads a key's type and passphrase from its preamble, not its material", () => {
    expect(privateKeyInfo(fakeOpenSshKey())).toEqual({ ok: true, encrypted: false, type: "ed25519" });
    expect(privateKeyInfo(fakeOpenSshKey("ssh-rsa", "aes256-ctr"))).toEqual({ ok: true, encrypted: true, type: "rsa" });
    expect(privateKeyInfo("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nabc\n-----END RSA PRIVATE KEY-----").encrypted).toBe(true);
    expect(privateKeyInfo("ssh-ed25519 AAAA public").ok).toBe(false);
  });

  it("writes the entry pointing at the lent key, and checks what arrives", () => {
    const value: SshValue = { alias: "vps", names: ["vps", "vps-old"], lines: ["HostName 203.0.113.7", "User deploy"], left: ["UseKeychain"], key: fakeOpenSshKey(), pub: "ssh-ed25519 AAAAC3x me@mac", knownHosts: [], keyName: "vps_key" };
    expect(checkSshValue(value)).toBe(true);
    const conf = sshConf(value, "mac");
    expect(conf).toContain("Host vps vps-old\n  HostName 203.0.113.7\n  User deploy\n  IdentityFile ~/.ssh/kururu/vps\n  IdentitiesOnly yes");
    expect(conf).not.toContain("UseKeychain yes");
    // A directive that does not travel, or a line with a newline smuggled in, is not an entry a node takes.
    expect(checkSshValue({ ...value, lines: ["ProxyCommand rm -rf ~"] })).toBe(false);
    expect(checkSshValue({ ...value, lines: ["HostName x\nProxyCommand y"] })).toBe(false);
    expect(checkSshValue({ ...value, names: ["vps", "*"] })).toBe(false);
    expect(checkSshValue({ ...value, key: "not a key" })).toBe(false);
  });

  it("brings the lent entries in with one line at the top, and takes it out again", () => {
    const own = "Host mine\n  HostName 192.0.2.1\n";
    const brought = withInclude(own);
    expect(brought.split("\n")[1]).toBe("Include ~/.ssh/kururu/*.conf");
    expect(withInclude(brought)).toBe(brought);
    expect(withoutInclude(brought)).toBe(own);
    expect(withoutInclude(withInclude(""))).toBe("");
    expect(ownHostClash(own, ["vps", "mine"])).toEqual(["mine"]);
  });
});

describe("GitHub", () => {
  const HOSTS = [
    "github.com:",
    "    users:",
    "        one-account:",
    "        other:",
    `            oauth_token: ${GH_TOKEN}`,
    "    git_protocol: https",
    "    user: other",
    "gitlab.example:",
    "    user: nobody",
  ].join("\n");

  it("lists gh's accounts on github.com and which is active", () => {
    expect(ghAccounts(HOSTS)).toEqual([
      { account: "one-account", active: false },
      { account: "other", active: true },
    ]);
    expect(ghTokenInFile(HOSTS, "other")).toBe(GH_TOKEN);
    expect(ghTokenInFile(HOSTS, "one-account")).toBeNull();
    expect(ghAccounts(`github.com:\n    oauth_token: ${GH_TOKEN}\n    user: solo\n`)).toEqual([{ account: "solo", active: true }]);
  });

  it("knows a token's shape", () => {
    expect(validGhToken(GH_TOKEN)).toBe(true);
    expect(validGhToken(`github_pat_${"x".repeat(40)}`)).toBe(true);
    expect(validGhToken("hunter2")).toBe(false);
  });

  it("points a terminal at the lent login by path, never by token", () => {
    const env = ghEnv("/home/me/.config/kururu/gh", 1)!;
    expect(env.GH_CONFIG_DIR).toBe("/home/me/.config/kururu/gh");
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_CONFIG_VALUE_2).toBe("store --file='/home/me/.config/kururu/gh/git-credentials'");
    expect(JSON.stringify(env)).not.toContain("gho_");
    expect(ghEnv("/it's", 0)).toBeNull();
  });

  it("reads whose origin a checkout is", () => {
    expect(remoteOwner('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/someone/project.git\n')).toBe("someone");
    expect(remoteOwner('[remote "origin"]\n\turl = git@github.com:other-one/x.git\n')).toBe("other-one");
    expect(remoteOwner('[remote "origin"]\n\turl = https://gitlab.com/a/b.git\n')).toBeNull();
  });

  it("finds the hosts a project's scripts name, as whole words", () => {
    expect(mentionedHosts("rsync -a dist/ vps-box:/srv\nssh github.com", ["vps-box", "github.com", "box", "vps"])).toEqual(["vps-box", "github.com"]);
  });
});

// ---------------------------------------------------------------------------

describe("on a node's disk", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kururu-vault-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const repo = (name: string) => {
    const dir = join(home, "Projects", name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  };

  it("finds a checkout's env files, but not examples, backups or dependencies", () => {
    const dir = repo("app");
    for (const file of [".env", ".env.local", ".env.example", ".env.local.bak-1", "apps/web/.env", "node_modules/x/.env", "a/b/c/.env"]) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "A=1\n");
    }
    expect(findEnvFiles(dir)).toEqual([".env", ".env.local", "apps/web/.env"]);
  });

  it("lands an env file in the checkout at 0600, and never over the node's own", () => {
    const dir = repo("app");
    const value = { folder: dir, file: ".env.local", text: "SECRET=one\n", workspace: "App" };
    const placed: string[] = [];
    const ours = (p: string) => placed.includes(p);
    placed.push(placeEnv(value, home, ours, undefined));
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe("SECRET=one\n");
    expect(statSync(join(dir, ".env.local")).mode & 0o777).toBe(0o600);
    // Its own copy, changed: written over, since it is the lent one.
    expect(placeEnv({ ...value, text: "SECRET=two\n" }, home, ours, placed[0])).toBe(placed[0]!);

    writeFileSync(join(dir, ".env"), "MINE=1\n");
    expect(() => placeEnv({ ...value, file: ".env" }, home, ours, undefined)).toThrow(/of its own/);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("MINE=1\n");
    // The same bytes as its own is taken as lent already.
    expect(() => placeEnv({ ...value, file: ".env", text: "MINE=1\n" }, home, ours, undefined)).not.toThrow();

    symlinkSync("/etc/hosts", join(dir, ".env.prod"));
    expect(() => placeEnv({ ...value, file: ".env.prod" }, home, ours, undefined)).toThrow(/link/);
    expect(() => placeEnv({ ...value, folder: join(home, "Projects", "missing") }, home, ours, undefined)).toThrow(/clone the project/);
    expect(() => placeEnv({ ...value, folder: "/tmp" }, home, ours, undefined)).toThrow(/outside home/);
    expect(() => placeEnv({ ...value, file: "apps/web/.env" }, home, ours, undefined)).toThrow(/no apps\/web/);
  });

  it("moves an env file when the lend moves to another checkout", () => {
    const one = repo("one");
    const two = repo("two");
    const first = placeEnv({ folder: one, file: ".env", text: "A=1\n", workspace: "W" }, home, () => false, undefined);
    placeEnv({ folder: two, file: ".env", text: "A=1\n", workspace: "W" }, home, () => false, first);
    expect(existsSync(join(one, ".env"))).toBe(false);
    expect(existsSync(join(two, ".env"))).toBe(true);
  });

  const SSH: SshValue = { alias: "vps", names: ["vps"], lines: ["HostName 203.0.113.7"], left: [], key: fakeOpenSshKey(), pub: "ssh-ed25519 AAAAC3x me@mac\n", knownHosts: ["203.0.113.7 ssh-ed25519 AAAAC3host"], keyName: "vps_key" };

  it("lands an ssh entry beside the node's config, and leaves the config as it was when it goes", () => {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const own = "Host mine\n  HostName 192.0.2.1\n";
    writeFileSync(join(home, ".ssh", "config"), own, { mode: 0o644 });
    placeSsh(SSH, home, "mac");
    const config = readFileSync(join(home, ".ssh", "config"), "utf8");
    expect(config).toContain("Include ~/.ssh/kururu/*.conf");
    expect(config.endsWith(own)).toBe(true);
    expect(statSync(join(home, ".ssh", "config")).mode & 0o777).toBe(0o644);
    expect(statSync(join(home, ".ssh", "kururu", "vps")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".ssh", "kururu")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, ".ssh", "kururu", "vps.known_hosts"), "utf8")).toBe("203.0.113.7 ssh-ed25519 AAAAC3host\n");
    expect(readFileSync(join(home, ".ssh", "kururu", "vps.conf"), "utf8")).toContain("IdentityFile ~/.ssh/kururu/vps");

    placeSsh({ ...SSH, alias: "box", names: ["box"] }, home, "mac");
    removeSsh(home, "vps");
    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toContain("Include ~/.ssh/kururu/*.conf");
    removeSsh(home, "box");
    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toBe(own);
    expect(existsSync(join(home, ".ssh", "kururu"))).toBe(false);

    expect(() => placeSsh({ ...SSH, alias: "mine", names: ["mine"] }, home, "mac")).toThrow(/its own Host mine/);
  });

  it("makes ~/.ssh/config when there is none, and removes only what it made", () => {
    placeSsh(SSH, home, "mac");
    expect(statSync(join(home, ".ssh", "config")).mode & 0o777).toBe(0o600);
    removeSsh(home, "vps");
    expect(existsSync(join(home, ".ssh", "config"))).toBe(false);
  });

  it("lands a GitHub login in kururu's own directory", () => {
    const config = join(home, ".config", "kururu");
    placeGh({ account: "someone", token: GH_TOKEN }, config);
    expect(readFileSync(join(config, "gh", "hosts.yml"), "utf8")).toContain("user: someone");
    expect(ghAccounts(readFileSync(join(config, "gh", "hosts.yml"), "utf8"))).toEqual([{ account: "someone", active: true }]);
    expect(readFileSync(join(config, "gh", "git-credentials"), "utf8")).toBe(`https://someone:${GH_TOKEN}@github.com\n`);
    expect(statSync(join(config, "gh", "git-credentials")).mode & 0o777).toBe(0o600);
    removeGh(config);
    expect(existsSync(join(config, "gh"))).toBe(false);
  });

  it("guesses the hosts a checkout's scripts name, never reading an env file", () => {
    const dir = repo("app");
    mkdirSync(join(dir, "ops", "deploy"), { recursive: true });
    writeFileSync(join(dir, "ops", "deploy", "sync.sh"), "ssh vps-box 'docker compose up -d'\n");
    writeFileSync(join(dir, ".env"), "HOST=other-box\n");
    expect([...hostsMentioned(dir, ["vps-box", "other-box"])]).toEqual([["vps-box", "ops/deploy/sync.sh"]]);
  });
});
