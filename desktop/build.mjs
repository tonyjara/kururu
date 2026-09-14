/**
 * Bundle the server so Electron can load it.
 *
 * Electron's main process cannot run TypeScript, and the server is TypeScript
 * that imports from `../../shared`. One esbuild pass resolves both problems and
 * produces a single file, which is also what makes the utilityProcess fork a
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
 * Two bundles, not one, because the server runs as two processes: the pty host,
 * which owns everything that cannot be recreated, and the server, which can be
 * killed and re-forked whenever its code changes. Sharing one bundle would work
 * and would also mean every restart reloaded node-pty for no reason.
 */
import { build } from "esbuild";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

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
    // Native, and resolved at runtime. `ws` could be bundled but is left external
    // alongside it so the two are found the same way.
    external: ["node-pty", "ws"],
    logLevel: "info",
  });
}

await bundle("server/src/ptyhost-main.ts", "dist/ptyhost.mjs");
await bundle("server/src/index.ts", "dist/server.mjs");

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
