/**
 * Bundle the server and the pty host into files node can run.
 *
 * Both are TypeScript that imports from `../../shared`, and neither node nor
 * Electron runs TypeScript. One esbuild pass resolves both problems and produces
 * a single file each, which is also what makes starting either of them a
 * one-liner: there is nothing to resolve at runtime.
 *
 * ESM output, not CJS, because the server uses `import.meta.url` to find the
 * built web app when nothing has told it where that is. Bundling that to CJS
 * would leave a reference esbuild has to fake.
 *
 * `node-pty` stays external. It is a native module — the bundler would have to
 * inline a `.node` binary, which it cannot — so it is required at runtime from
 * node_modules like any other native dependency.
 *
 * Two bundles, not one, because this is two processes: the pty host, which owns
 * everything that cannot be recreated, and the server, which is killed and
 * started again whenever its code changes. Sharing one bundle would work and
 * would also mean every restart reloaded node-pty for no reason.
 *
 * The output still lands in `desktop/dist` although Electron no longer starts
 * either of them — the desktop is a viewer now and the server is something you
 * run. Moving it is a rename nobody is asking for; what matters is that the two
 * bundles sit beside each other, because that is how `index.ts` finds the host
 * to spawn.
 */
import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * The version, stamped into both bundles as a constant.
 *
 * Read from the root manifest because that is the one `/release` bumps first and
 * the one the four workspaces are kept equal to. It is a *define* rather than a
 * runtime read for the reason `server/src/version.ts` gives: a packaged app's
 * manifests are inside an asar at a path that depends on how it was packaged, so
 * a read that works in the checkout is exactly the kind that fails in the thing
 * you shipped.
 */
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

/** Both halves are built the same way; only the entry and the name differ. */
async function bundle(entry, outfile) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(here, outfile),
    bundle: true,
    format: "esm",
    platform: "node",
    // Electron 44 ships Node 24; there is no older runtime to be kind to.
    target: "node22",
    sourcemap: true,
    define: { KURURU_VERSION: JSON.stringify(VERSION) },
    // Native, and resolved at runtime. `ws` could be bundled but is left external
    // alongside it so the two are found the same way.
    external: ["node-pty", "ws"],
    logLevel: "info",
  });
}

await bundle("server/src/ptyhostd.ts", "dist/ptyhostd.mjs");
await bundle("server/src/index.ts", "dist/server.mjs");
// What a Claude Code hook runs. Beside the server so `hooks.ts` can find it, and
// bundled so the packaged app can run it with no checkout and no `bun`.
await bundle("server/src/report-cli.ts", "dist/report.mjs");

/**
 * node-pty spawns a small helper binary rather than forking the host process,
 * and `bun install` does not preserve its executable bit — the prebuilt
 * `spawn-helper` lands as 0644 and every spawn fails with a bare
 * "posix_spawnp failed" that names nothing.
 *
 * Cheap to fix, invisible to diagnose, and it comes back on every reinstall,
 * which is why it lives in the build rather than in a README.
 */
for (const dir of ["darwin-arm64", "darwin-x64"]) {
  const helper = join(root, "node_modules/node-pty/prebuilds", dir, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
