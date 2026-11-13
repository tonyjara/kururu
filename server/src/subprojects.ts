/**
 * Looks under each workspace's root for the projects a monorepo holds, so
 * that Kuru's conversation can be tagged by them (`shared/subprojects.ts`
 * has the argument and the rules; this is the disk).
 *
 * **A root has to say it is a monorepo first** — a `pnpm-workspace.yaml`,
 * a `turbo.json`, an `nx.json`, a `lerna.json`, a `go.work`, a package.json
 * with `workspaces`, or a Cargo.toml with `[workspace]` — and then only
 * `apps/*` and `sites/*` are read, and only a folder there with a manifest of
 * its own counts. An ordinary repository with an `apps` folder of screenshots
 * is not a monorepo, and `packages/*` is shared code, never a project.
 *
 * **Looked at again rather than watched.** On start, when a root is set, when
 * Settings asks, and every few minutes: a dozen roots, two folders each, is a
 * few dozen directory reads, and a watcher on every root of every profile
 * would be the most expensive way to notice a new site once a month. What is
 * found is laid on the workspace only when it differs, so a quiet pass sends
 * nobody anything.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { APP_DIRS, packageDomain, packageName, readmeTitle, SUBPROJECTS_MAX, type FoundProject } from "../../shared/subprojects";
import { isRemote } from "../../shared/remote";
import type { Workspaces } from "./workspaces";

/** What says a root is a monorepo. */
const MARKERS = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json", "go.work", "rush.json"];

/** What says a folder is an app of its own rather than a folder of files. */
const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pubspec.yaml", "Gemfile", "composer.json", "deno.json", "project.godot", "Package.swift"];

/** How often every root is looked at again. */
const EVERY_MS = 5 * 60_000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readSmall(path: string, max = 64 * 1024): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > max) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function json(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whether a root says it is a monorepo. */
export async function isMonorepo(root: string): Promise<boolean> {
  for (const marker of MARKERS) if (await exists(join(root, marker))) return true;
  const manifest = json(await readSmall(join(root, "package.json")));
  if (manifest && typeof manifest === "object" && "workspaces" in manifest) return true;
  const cargo = await readSmall(join(root, "Cargo.toml"));
  return cargo !== null && /^\s*\[workspace\]/m.test(cargo);
}

/** The projects under a root, in name order; none for a root that is not a monorepo or is not there. */
export async function scanRoot(root: string): Promise<FoundProject[]> {
  if (!(await isMonorepo(root))) return [];
  const found: FoundProject[] = [];
  for (const container of APP_DIRS) {
    let names: string[];
    try {
      names = (await readdir(join(root, container), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules").map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (found.length >= SUBPROJECTS_MAX) break;
      const dir = join(root, container, name);
      let manifest: string | null = null;
      for (const m of MANIFESTS) {
        if (await exists(join(dir, m))) {
          manifest = m;
          break;
        }
      }
      if (!manifest) continue;
      const pkg = manifest === "package.json" ? json(await readSmall(join(dir, "package.json"))) : null;
      const readme = (await readSmall(join(dir, "README.md"))) ?? (await readSmall(join(dir, "readme.md")));
      const heading = readme ? readmeTitle(readme) : { title: null, domain: null };
      found.push({ dir: `${container}/${name}`, title: heading.title, pkg: packageName(pkg), domain: heading.domain ?? packageDomain(pkg) });
    }
  }
  return found;
}

let started: { scanOne: (profileId: string, workspaceId: string) => Promise<void>; stop: () => void } | null = null;

/** Looks under one workspace's root now: its root was set, or Settings asked. Nothing before the scan is started. */
export function lookForProjects(profileId: string, workspaceId: string): Promise<void> {
  return started?.scanOne(profileId, workspaceId) ?? Promise.resolve();
}

export function stopSubprojectScan(): void {
  started?.stop();
  started = null;
}

/** Looks at every local workspace's root now, and then every few minutes. */
export function startSubprojectScan(workspaces: Workspaces): void {
  if (started) return;
  let running = false;
  const scanOne = async (profileId: string, workspaceId: string) => {
    const workspace = workspaces.workspaceIn(profileId, workspaceId);
    if (!workspace || isRemote(workspace.id)) return;
    const found = workspace.root && !workspace.machine ? await scanRoot(workspace.root).catch(() => null) : [];
    // A root that could not be read keeps what was found: a disk asleep is not a site deleted.
    if (found) workspaces.setFoundProjects(profileId, workspaceId, found);
  };
  const scanAll = async () => {
    if (running) return;
    running = true;
    try {
      for (const profile of workspaces.all()) for (const workspace of profile.workspaces) await scanOne(profile.id, workspace.id);
    } finally {
      running = false;
    }
  };
  void scanAll();
  const timer = setInterval(() => void scanAll(), EVERY_MS);
  timer.unref?.();
  started = { scanOne, stop: () => clearInterval(timer) };
}
