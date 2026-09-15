/**
 * Which accounts a profile opens terminals as, on the two sides of that answer
 * that can be tested without an account.
 *
 * `adoptIdentity` is the one that matters. It is what stands between a path
 * typed into a box on a phone and the environment of a real pty, and its whole
 * job is a refusal: a relative path would resolve against whatever directory the
 * terminal happened to open in, so `.config` would mean a different Claude
 * account in every pane — which is the exact bug the feature exists to prevent,
 * arriving through the feature itself. It is a refusal rather than a repair for
 * the reason a sheet name is: there is no nearest legal value for a path.
 *
 * The overlay is the other half and is nearly too small to test, except for two
 * things that are easy to break later. An identity nobody has filled in must
 * produce *nothing* rather than an empty object, because `undefined` is what
 * lets `host.create` spread it and spawn exactly as it always did; and `~` has
 * to be gone by the time it is an environment variable, because the process that
 * reads it is frequently a non-interactive shell with no opinion about what `~`
 * means.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adoptIdentity, blankIdentity, hasIdentity } from "../../shared/model";
import {
  claudeDirFor,
  ensureGhConfig,
  expandHome,
  ghDirFor,
  identityEnv,
  shellQuote,
  slug,
  tildify,
} from "../src/identity";

const tmp = join(realpathSync("/tmp"), `kururu-identity-test-${process.pid}`);

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.XDG_CONFIG_HOME = tmp;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe("adoptIdentity", () => {
  it("keeps absolute paths and tilde paths as typed", () => {
    const identity = adoptIdentity({
      claudeConfigDir: "/Users/x/work/claude",
      ghConfigDir: "~/work/gh",
      gitConfigGlobal: "~",
    });
    expect(identity.claudeConfigDir).toBe("/Users/x/work/claude");
    // Unexpanded on purpose: it is what a person typed and stays readable.
    expect(identity.ghConfigDir).toBe("~/work/gh");
    expect(identity.gitConfigGlobal).toBe("~");
  });

  it("refuses a relative path rather than resolving one", () => {
    const identity = adoptIdentity({
      claudeConfigDir: ".config/claude",
      ghConfigDir: "../gh",
      gitConfigGlobal: "gitconfig",
    });
    expect(identity).toEqual(blankIdentity());
  });

  it("treats blank, whitespace, missing and wrongly-typed alike", () => {
    expect(adoptIdentity({ claudeConfigDir: "" })).toEqual(blankIdentity());
    expect(adoptIdentity({ claudeConfigDir: "   " })).toEqual(blankIdentity());
    expect(adoptIdentity({ claudeConfigDir: 7 })).toEqual(blankIdentity());
    expect(adoptIdentity({})).toEqual(blankIdentity());
    expect(adoptIdentity(null)).toEqual(blankIdentity());
    expect(adoptIdentity(undefined)).toEqual(blankIdentity());
  });

  it("trims, because a path pasted out of a terminal brings a space with it", () => {
    expect(adoptIdentity({ ghConfigDir: "  /etc/gh  " }).ghConfigDir).toBe("/etc/gh");
  });

  it("takes each path on its own, so one bad row does not clear the others", () => {
    const identity = adoptIdentity({ claudeConfigDir: "/a", ghConfigDir: "nope" });
    expect(identity.claudeConfigDir).toBe("/a");
    expect(identity.ghConfigDir).toBeNull();
  });

  it("says whether anybody has been claimed at all", () => {
    expect(hasIdentity(blankIdentity())).toBe(false);
    expect(hasIdentity(adoptIdentity({ gitConfigGlobal: "/x/.gitconfig" }))).toBe(true);
  });
});

describe("identityEnv", () => {
  it("is nothing at all when the profile has claimed nobody", () => {
    expect(identityEnv(blankIdentity())).toBeUndefined();
  });

  it("names the variable each tool actually reads", () => {
    expect(
      identityEnv(
        adoptIdentity({
          claudeConfigDir: "/w/claude",
          ghConfigDir: "/w/gh",
          gitConfigGlobal: "/w/.gitconfig",
        }),
      ),
    ).toEqual({
      CLAUDE_CONFIG_DIR: "/w/claude",
      GH_CONFIG_DIR: "/w/gh",
      GIT_CONFIG_GLOBAL: "/w/.gitconfig",
    });
  });

  it("carries only the paths that were set", () => {
    expect(identityEnv(adoptIdentity({ ghConfigDir: "/w/gh" }))).toEqual({ GH_CONFIG_DIR: "/w/gh" });
  });

  it("expands the tilde, because the shell that reads this will not", () => {
    const env = identityEnv(adoptIdentity({ claudeConfigDir: "~/work/claude" }));
    expect(env?.CLAUDE_CONFIG_DIR).toBe(`${homedir()}/work/claude`);
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("/already/absolute")).toBe("/already/absolute");
  });
});

describe("where a choice gets stored", () => {
  it("names a Claude directory after the profile, because nothing else names it", () => {
    // The account has no name until somebody has signed in to the directory, so
    // the directory is all there is to key it by.
    expect(claudeDirFor("Work Stuff")).toBe(join(tmp, "kururu", "identities", "claude", "work-stuff"));
    expect(slug("  Ünïcôde & Co.  ")).toBe("n-c-de-co");
    expect(slug("///")).toBe("profile");
    expect(slug("x".repeat(80))).toHaveLength(40);
  });

  it("refuses to let a profile name climb out of the directory", () => {
    // A name is typed by a client and this one builds a path out of it. ".."
    // survives every other rule in here as exactly the two characters that mean
    // the directory above.
    expect(slug("..")).toBe("profile");
    expect(slug(".")).toBe("profile");
    expect(slug("../..")).toBe("profile");
    expect(slug("../work")).toBe("work");
    expect(claudeDirFor("..")).toBe(join(tmp, "kururu", "identities", "claude", "profile"));
  });

  it("names a github directory after the account, because gh knows it first", () => {
    // Which is what makes two profiles picking one account share one directory
    // rather than accumulating a copy each.
    expect(ghDirFor("github.com", "tonyjara")).toBe(join(tmp, "kururu", "identities", "gh", "tonyjara"));
    expect(ghDirFor("ghe.example.com", "tonyjara")).toBe(
      join(tmp, "kururu", "identities", "gh", "ghe.example.com--tonyjara"),
    );
  });
});

describe("ensureGhConfig", () => {
  it("writes a config that names exactly one account, and no token", () => {
    const dir = ensureGhConfig("github.com", "someone", "ssh");
    const yaml = readFileSync(join(dir, "hosts.yml"), "utf8");
    expect(yaml).toBe(
      "github.com:\n    git_protocol: ssh\n    users:\n        someone:\n    user: someone\n",
    );
    // The token is gh's, in the login keyring. Nothing kururu writes is a secret,
    // which is the whole reason a config directory can be a pointer.
    expect(yaml).not.toContain("oauth_token");
  });

  it("defaults a protocol it was not told, rather than writing a blank one", () => {
    const dir = ensureGhConfig("github.com", "protoless");
    expect(readFileSync(join(dir, "hosts.yml"), "utf8")).toContain("git_protocol: https");
  });

  it("leaves a config gh has since rewritten alone", () => {
    const dir = ensureGhConfig("github.com", "settled");
    writeFileSync(join(dir, "hosts.yml"), "github.com:\n    user: somebody-else\n");
    expect(ensureGhConfig("github.com", "settled")).toBe(dir);
    // gh owns that file the moment somebody logs in or out inside one of these
    // terminals; regenerating it would throw away what gh had just recorded.
    expect(readFileSync(join(dir, "hosts.yml"), "utf8")).toContain("somebody-else");
  });

  it("refuses an account name that is a path", () => {
    // It arrives from a client and it picks a directory, which is `files.ts`'s
    // argument one directory along: a name is a name, never a path.
    expect(() => ensureGhConfig("github.com", "../../evil")).toThrow();
    expect(() => ensureGhConfig("../..", "tonyjara")).toThrow();
    expect(() => ensureGhConfig("github.com", "..")).toThrow();
    expect(existsSync(join(tmp, "kururu", "identities", "gh", ".."))).toBe(true);
  });
});

describe("tildify", () => {
  it("puts back the tilde, so what is stored reads like what was typed", () => {
    expect(tildify(join(homedir(), "work", "gh"))).toBe("~/work/gh");
    expect(tildify(homedir())).toBe("~");
    expect(tildify("/etc/gh")).toBe("/etc/gh");
    // And round-trips, which is the property the two of them are a pair for.
    expect(expandHome(tildify(join(homedir(), "x")))).toBe(join(homedir(), "x"));
  });
});

describe("shellQuote", () => {
  /**
   * The sign-in line names its own config directory and is then typed at a live
   * shell, so this is the one string in kururu that a person's own directory
   * name gets to be part of a command.
   */
  it("makes one word of a path, whatever is in it", () => {
    expect(shellQuote("/Users/x/.claude")).toBe("'/Users/x/.claude'");
    expect(shellQuote("/Users/x/My Work/.claude")).toBe("'/Users/x/My Work/.claude'");
    expect(shellQuote("/Users/x/$HOME`whoami`")).toBe("'/Users/x/$HOME`whoami`'");
  });

  it("closes, escapes and reopens the one character it cannot contain", () => {
    expect(shellQuote("/Users/o'brien/.claude")).toBe(`'/Users/o'\\''brien/.claude'`);
  });

  it("survives a shell, which is the only test that actually settles it", async () => {
    const tricky = "/tmp/it's a \"dir\"; echo pwned";
    const out = await new Promise<string>((resolve) => {
      execFile("/bin/sh", ["-c", `printf %s ${shellQuote(tricky)}`], (_err, stdout) =>
        resolve(stdout),
      );
    });
    expect(out).toBe(tricky);
  });
});
