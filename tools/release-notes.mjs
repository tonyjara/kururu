/**
 * One version's section out of `CHANGELOG.md`, for whoever needs it as prose.
 *
 * A release's notes are written once, in the changelog, and read in three
 * places: the file, the GitHub release body, and the *What's new* panel the
 * About tab draws from `/api/update`. The second of those is the only one that
 * needs the section on its own rather than in context, which is the whole of
 * what this does — `.github/workflows/release.yml` pipes it into `gh release
 * create`, and `/release` uses it to show you what is about to be published
 * before it is.
 *
 * It refuses rather than falls back. An empty release body is worse than a
 * failed build: the build you notice and fix in a minute, and the empty body
 * ships, is what the updater shows every user, and is not correctable without
 * editing a release that people have already seen.
 *
 *   node tools/release-notes.mjs 0.2.0
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) {
  console.error("usage: node tools/release-notes.mjs <version>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

/**
 * The heading for this version, in either shape the file uses: `## [0.2.0]` once
 * it has been dated by `/release`, and `## [Unreleased]` before that. Matched on
 * the bracketed name rather than on the whole line, because the date is written
 * on the day and a pattern that included it would only work if you released on
 * the day you expected to.
 */
const lines = changelog.split("\n");
const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[${version.replace(/\./g, "\\.")}\\]`).test(line));
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no section for ${version}.`);
  console.error("Run /release to write one — a release with an empty body is not correctable after the fact.");
  process.exit(1);
}

const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
const body = lines
  .slice(start + 1, end === -1 ? lines.length : end)
  // Link definitions at the foot of the file belong to the file, not to the
  // release — GitHub resolves nothing from them and they read as noise.
  .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
  .join("\n")
  .trim();

if (!body) {
  console.error(`release-notes: the section for ${version} is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
