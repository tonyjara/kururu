/**
 * Reading a `config.toml` well enough to know which port to knock on.
 *
 * This is the whole of what can go wrong quietly. The walk up the tree either
 * finds a directory or does not, and the probe either connects or does not —
 * both are visible the moment somebody looks at the button. Reading the *wrong*
 * port out of the config is the failure that looks like a working feature: the
 * row says the database is down while it is up, or up while it is down, and
 * there is nothing on screen to suggest the number came from `[db.pooler]`.
 *
 * `config.toml` has at least four `port` keys in the shape the CLI generates,
 * which is why every case below is really the same case: does the section header
 * still apply to the line being read.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSupabase, parseConfig, supabaseCommand } from "../src/supabase";

/** The generated file, cut down to the sections that carry a `port`. */
const CONFIG = `
# For detailed configuration reference documentation, visit:
# https://supabase.com/docs/guides/local-development/cli/config
project_id = "fastermenu"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]

[db]
port = 54322
shadow_port = 54320
major_version = 17

[db.pooler]
enabled = false
port = 54329

[studio]
port = 54323
`;

describe("parseConfig", () => {
  it("takes the port under [db] and not one of the other three", () => {
    expect(parseConfig(CONFIG)).toEqual({ project: "fastermenu", port: 54322 });
  });

  /**
   * The one that would be wrong in a way nobody sees: `[db.pooler]` comes after
   * `[db]` and also has a `port`, so a reader that matched a section by prefix
   * would take 54329 and report a running database as stopped.
   */
  it("does not let a subsection answer for its parent", () => {
    const pooler = "[db.pooler]\nport = 54329\n";
    expect(parseConfig(pooler)).toBeNull();
  });

  it("reads project_id only above the first section", () => {
    // A `project_id` inside a section is somebody else's key with the same name.
    expect(parseConfig('[auth]\nproject_id = "nope"\n[db]\nport = 5432\n')).toEqual({
      project: "",
      port: 5432,
    });
  });

  it("ignores what is commented out", () => {
    expect(parseConfig('project_id = "x"\n[db]\n# port = 1\nport = 54322\n')?.port).toBe(54322);
  });

  /**
   * Null rather than a default, on `parseColor`'s reasoning in `contrast.ts`: a
   * config this cannot read is one where the honest answer is "no button", and a
   * fallback to 54322 would be a probe of whichever *other* project happens to
   * be on the standard port.
   */
  it("declines a config with no [db] port rather than assuming the usual one", () => {
    expect(parseConfig('project_id = "x"\n[api]\nport = 54321\n')).toBeNull();
    expect(parseConfig("")).toBeNull();
  });

  it("refuses a port that is not a port", () => {
    expect(parseConfig("[db]\nport = zero\n")).toBeNull();
    expect(parseConfig("[db]\nport = \n")).toBeNull();
    expect(parseConfig("[db]\nport = 99999\n")).toBeNull();
  });
});

describe("findSupabase", () => {
  it("finds the project from a directory inside it, not just at its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-sb-"));
    await mkdir(join(root, "supabase"), { recursive: true });
    await writeFile(join(root, "supabase", "config.toml"), CONFIG);
    const deep = join(root, "apps", "web", "src");
    await mkdir(deep, { recursive: true });

    expect(await findSupabase(deep)).toEqual({ root, project: "fastermenu", port: 54322 });
  });

  it("finds nothing above a directory with nothing above it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-sb-"));
    expect(await findSupabase(root)).toBeNull();
  });
});

describe("supabaseCommand", () => {
  /**
   * The user's own script wins, because the CLI is a devDependency in most
   * projects and `supabase start` on its own is the line that fails. Matched on
   * what the script *runs* rather than on what it is called: the name varies
   * between projects and the body does not.
   */
  it("prefers the project's own script, named however it is named", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-sb-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "db:start": "supabase start", "db:stop": "supabase stop", "db:reset": "supabase db reset" } }),
    );
    expect(await supabaseCommand(root, "start")).toBe("npm run db:start");
    expect(await supabaseCommand(root, "stop")).toBe("npm run db:stop");
  });

  it("runs it with whatever the lockfile says the project is run with", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-sb-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { up: "supabase start" } }));
    await writeFile(join(root, "bun.lock"), "");
    expect(await supabaseCommand(root, "start")).toBe("bun run up");
  });

  /** `supabase db reset` mentions neither verb; it must not be the stop button. */
  it("does not take a script that merely mentions the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-sb-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { reset: "supabase db reset" } }));
    expect(await supabaseCommand(root, "stop")).toBe("supabase stop");
  });

  it("falls back to the CLI on PATH when the project says nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kururu-sb-"));
    expect(await supabaseCommand(root, "start")).toBe("supabase start");
  });
});
