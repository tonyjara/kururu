/**
 * What version of kururu this is, available to the process rather than only to
 * whoever read `package.json`.
 *
 * Nothing needed this while kururu was a thing you ran out of a checkout: the
 * version of the code was the version of the working tree, and there was nobody
 * to tell. A downloadable build changes that in three ways at once. The *Check
 * for updates* button has to have something to compare against; a window and a
 * server can be different builds now, because one of them may be on a box in a
 * cupboard; and the pty host outlives both and can therefore be older than
 * either, which is the one that bites silently — it holds every pty, it does not
 * pick up a new bundle without being restarted, and a field added to a spawn
 * that an old host does not know about is dropped on the floor with correct code
 * on both sides of the gap. That has already happened once (see the `ptyhost.ts`
 * relay invariant in `CLAUDE.md`), and a version each half can state is what
 * turns it from a mystery into a sentence.
 *
 * Stamped in at build time by `desktop/build.mjs` rather than read off disk,
 * because a packaged app's `package.json` is somewhere else entirely — inside an
 * asar, at a path that depends on how it was packaged — and a runtime read is a
 * thing that works in the checkout and fails in the thing you shipped. The
 * fallback is what you get from `bun run src/index.ts` with no bundler in the
 * way, and it says so out loud rather than guessing at a number: an unbuilt
 * server claiming to be 0.1.0 would make *Check for updates* lie in the one
 * situation where the answer matters least.
 */

/** Replaced by `desktop/build.mjs` with a string literal; absent otherwise. */
declare const KURURU_VERSION: string | undefined;

export const VERSION: string = typeof KURURU_VERSION === "string" ? KURURU_VERSION : "0.0.0-dev";

/** A build that was run through the bundler, as opposed to a checkout. */
export const IS_RELEASE_BUILD = VERSION !== "0.0.0-dev";
