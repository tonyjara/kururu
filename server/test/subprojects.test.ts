/**
 * The projects inside a workspace: which folders count, what they are called
 * until the owner says otherwise, the owner's edits, and the look under a
 * real folder on disk — Shared Landings' shape, and Platypost's, which is one
 * product in parts and must give no projects.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject,
  adoptProjectEdits,
  adoptSubprojects,
  editProject,
  namesOf,
  parseAliases,
  readmeTitle,
  removeProject,
  slugOf,
  spaceOfKey,
  splitProjectKey,
  subprojectsOf,
  visibleProjects,
  type FoundProject,
} from "../../shared/subprojects";
import { scanRoot } from "../src/subprojects";

const found = (dir: string, extra: Partial<FoundProject> = {}): FoundProject => ({ dir, title: null, pkg: null, domain: null, ...extra });

const LANDINGS = [
  found("apps/agualomas", { title: "O&D Lomas", pkg: "agualomas", domain: "agualomas.com" }),
  found("apps/parqueguasu", { title: "Parque Guasu", pkg: "parqueguasu", domain: "parqueguasu.org" }),
  found("apps/tonyjara", { title: "tonyjara", pkg: "tonyjara", domain: "tonyjara.com" }),
  found("apps/yetapa", { title: "Yetapa Tours", pkg: "yetapa", domain: "yetapatours.com" }),
];

describe("readmeTitle", () => {
  test("a name with its domain in brackets", () => {
    expect(readmeTitle("# Yetapa Tours (yetapatours.com)\n\nAn app.")).toEqual({ title: "Yetapa Tours", domain: "yetapatours.com" });
  });
  test("a heading that is a domain is its label", () => {
    expect(readmeTitle("# tonyjara.com\n")).toEqual({ title: "tonyjara", domain: "tonyjara.com" });
  });
  test("a heading that is a sentence gives no name", () => {
    expect(readmeTitle("# This is the landing page we built for the client in March of last year").title).toBeNull();
    expect(readmeTitle("no heading at all")).toEqual({ title: null, domain: null });
  });
});

describe("subprojectsOf", () => {
  test("a monorepo of sites: each is a project, named by its README, answering to its folder, package and domain", () => {
    const projects = subprojectsOf("wksl", { found: LANDINGS, edits: [] });
    expect(projects.map((p) => [p.key, p.name, p.hidden])).toEqual([
      ["wksl/agualomas", "O&D Lomas", false],
      ["wksl/parqueguasu", "Parque Guasu", false],
      ["wksl/tonyjara", "tonyjara", false],
      ["wksl/yetapa", "Yetapa Tours", false],
    ]);
    expect(namesOf(projects[3]!)).toEqual(["Yetapa Tours", "yetapa", "yetapatours"]);
  });
  test("a product in parts: every folder is a role, so none is shown", () => {
    const parts = ["browser", "desktop", "landing", "mcp", "mobile", "native", "server"].map((name) => found(`apps/${name}`));
    expect(visibleProjects("wkpl", { found: parts, edits: [] })).toEqual([]);
    expect(subprojectsOf("wkpl", { found: parts, edits: [] }).every((p) => p.quiet === "role")).toBe(true);
  });
  test("one site among the parts is the product itself, and stays off", () => {
    const pasapy = [found("apps/collector"), found("apps/native"), found("apps/web"), found("apps/pasapy")];
    const projects = subprojectsOf("wkpa", { found: pasapy, edits: [] });
    expect(projects.find((p) => p.slug === "pasapy")?.quiet).toBe("alone");
    expect(visibleProjects("wkpa", { found: pasapy, edits: [] })).toEqual([]);
  });
  test("the owner's name, other names and switch win; an added one is listed after", () => {
    const edits = [
      { slug: "yetapa", name: "Yetapá" },
      { slug: "parqueguasu", name: "Parque Guasú", aliases: ["Guasu"] },
      { slug: "tonyjara", hidden: true },
      { slug: "mbaracayu", name: "Mbaracayú", added: { dir: null } },
    ];
    const projects = subprojectsOf("wksl", { found: LANDINGS, edits });
    expect(projects.find((p) => p.slug === "yetapa")?.name).toBe("Yetapá");
    expect(projects.find((p) => p.slug === "parqueguasu")?.aliases).toEqual(["Guasu"]);
    expect(projects.find((p) => p.slug === "tonyjara")?.hidden).toBe(true);
    expect(projects.at(-1)).toMatchObject({ key: "wksl/mbaracayu", name: "Mbaracayú", added: true, dir: null });
  });
  test("a role folder can be turned on by hand", () => {
    const projects = visibleProjects("wkpl", { found: [found("apps/web"), found("apps/server")], edits: [{ slug: "web", hidden: false }] });
    expect(projects.map((p) => p.slug)).toEqual(["web"]);
  });
});

describe("the owner's edits", () => {
  test("an edit that says nothing any more is dropped", () => {
    const one = editProject([], "yetapa", { name: "Yetapá" });
    expect(one).toEqual([{ slug: "yetapa", name: "Yetapá" }]);
    expect(editProject(one, "yetapa", { name: "" })).toEqual([]);
  });
  test("adding finds a free slug; removing takes only an added one", () => {
    const first = addProject([], ["yetapa"], "Yetapa")!;
    expect(first.slug).toBe("yetapa-2");
    expect(removeProject(first.edits, "yetapa-2")).toEqual([]);
    expect(removeProject([{ slug: "yetapa", name: "Y" }], "yetapa")).toEqual([{ slug: "yetapa", name: "Y" }]);
    expect(addProject([], [], "  ")).toBeNull();
  });
  test("aliases: comma-separated, each once with accents aside", () => {
    expect(parseAliases("Guasu, guasú ,Parque Guasu,, x")).toEqual(["Guasu", "Parque Guasu"]);
  });
  test("read back from a file: bad entries left out, a slug kept to its shape", () => {
    expect(
      adoptProjectEdits([
        { slug: "yetapa", name: "Yetapá", aliases: ["Yetapa", 3] },
        { slug: "Bad Slug", name: "x" },
        { slug: "added", added: { dir: "../etc" } },
        { slug: "added", name: "Added", added: { dir: "../etc" } },
        { slug: "empty" },
        "nope",
      ]),
    ).toEqual([
      { slug: "yetapa", name: "Yetapá", aliases: ["Yetapa"] },
      { slug: "added", name: "Added", added: { dir: null } },
    ]);
    expect(adoptSubprojects({ found: [{ dir: "/abs" }, { dir: "apps/x" }] }).found).toEqual([found("apps/x")]);
  });
  test("keys and slugs", () => {
    expect(slugOf("Parque Guasú!")).toBe("parque-guasu");
    expect(splitProjectKey("wksl/yetapa")).toEqual({ space: "wksl", slug: "yetapa" });
    expect(spaceOfKey("wksl/yetapa")).toBe("wksl");
    expect(spaceOfKey("wksl")).toBe("wksl");
  });
});

describe("scanRoot", () => {
  const base = mkdtempSync(join(tmpdir(), "kururu-subprojects-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  test("a pnpm monorepo's apps, never its packages, and only folders with a manifest", async () => {
    const root = join(base, "landings");
    write(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    write(join(root, "apps/yetapa/package.json"), JSON.stringify({ name: "yetapa" }));
    write(join(root, "apps/yetapa/README.md"), "# Yetapa Tours (yetapatours.com)\n");
    write(join(root, "apps/tonyjara/package.json"), JSON.stringify({ name: "@me/tonyjara", homepage: "https://tonyjara.com/" }));
    write(join(root, "apps/notes/todo.txt"), "not an app");
    write(join(root, "packages/db/package.json"), JSON.stringify({ name: "db" }));
    expect(await scanRoot(root)).toEqual([
      { dir: "apps/tonyjara", title: null, pkg: "tonyjara", domain: "tonyjara.com" },
      { dir: "apps/yetapa", title: "Yetapa Tours", pkg: "yetapa", domain: "yetapatours.com" },
    ]);
  });
  test("a folder that is not a monorepo has none, apps or not", async () => {
    const root = join(base, "plain");
    write(join(root, "package.json"), JSON.stringify({ name: "plain" }));
    write(join(root, "apps/a/package.json"), "{}");
    expect(await scanRoot(root)).toEqual([]);
    expect(await scanRoot(join(base, "missing"))).toEqual([]);
  });
});
