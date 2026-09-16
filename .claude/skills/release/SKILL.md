---
name: release
description: Maintain CHANGELOG.md and cut a kururu release. Use when the user says "release", "cut a version", "ship it", "update the changelog", "what's changed since the last release", or runs /release. Drafts the Unreleased section from real changes, then on a version argument stamps it, bumps the four package.json files, tags, and pushes — which is what triggers the signed build and the GitHub release.
---

# Releasing kururu

One changelog section is read in three places: the file, the GitHub release body,
and the *What's new* dialog the app fetches from `/api/update`. So it is written
once, for a person using kururu, and never for a person reading the diff.

This skill has two modes and the argument is what picks them.

- `/release` — refresh `## [Unreleased]` so it matches what is actually on main.
  Touches one file. No git writes.
- `/release 0.2.0` — cut that version: stamp the section, bump the versions, tag,
  push. Git writes, which is fine here and only here.

## Drafting (`/release` with no version)

Find where the last release ended and read everything since:

```sh
git describe --tags --abbrev=0 2>/dev/null || echo "(no tags yet — read all of main)"
git log --oneline <last-tag>..HEAD
git diff --stat <last-tag>..HEAD
```

**Read the diff, not the subject lines.** This repo's history contains commits
called `asdf` and `a`; a changelog assembled from `git log` alone would be
worthless and would also be wrong. The subject lines say where to look. What
goes in the entry comes from what the change did.

Then write entries under `## [Unreleased]`, in these groups and this order,
omitting any group that is empty: **Added**, **Changed**, **Fixed**, **Removed**,
**Security**.

What earns an entry is anything a user could notice: a new pane type, a key that
moved, a setting, a bug that used to eat their scrollback, a default that
changed. What does not: a refactor, a test, a rename, a comment — however much
work it was. If a change is invisible, it belongs in the commit and nowhere else.

Match the register of what is already in the file and of `README.md`: a short
bolded claim, then the sentence that says what it means for you. Prose, not
fragments. Never invent an entry to fill a group, and never quietly reword a
section for a version that has already shipped — that version is out there and
its notes are on GitHub.

### Three things kururu specifically has to call out

These are not general changelog advice; they are this architecture's sharp
edges, and a user who is not told will find them the expensive way.

1. **Anything that ends their agents on upgrade.** The pty host holds every pty
   and does not pick up a new bundle without being restarted, which ends every
   agent in it. If a release changes `server/src/agents/`, `ptyhost*.ts`,
   `hostlink.ts` or `hostsock.ts`, the section says so in its own line:
   *"Picking this up needs the pty host restarted, which ends the agents running
   in it."*
2. **Anything that changes the wire.** A window and a server can be different
   versions — somebody's desktop against the box in the cupboard — so a change
   to `shared/wire.ts` or the host link is a minor at minimum and is named.
3. **Anything about the network posture.** Kururu binds loopback and mints a
   token to go further. A change to either is a **Security** entry, always, even
   when it is a tightening.

## Cutting (`/release 0.2.0`)

Refuse, and say why, if any of these is true: the working tree is dirty, the
current branch is not `main`, `## [Unreleased]` has no entries, or the tag
already exists.

1. **Pick the number off the entries, then confirm it with the user.** Breaking
   the wire or forcing a host restart is a minor while kururu is pre-1.0 and a
   major after. New features are a minor, fixes a patch.
2. **Stamp the section.** `## [Unreleased]` becomes `## [0.2.0] - YYYY-MM-DD`
   with today's real date, and a fresh empty `## [Unreleased]` goes above it.
   Add the link definitions at the foot of the file:

   ```markdown
   [Unreleased]: https://github.com/tonyjara/kururu/compare/v0.2.0...HEAD
   [0.2.0]: https://github.com/tonyjara/kururu/releases/tag/v0.2.0
   ```

3. **Bump the version in all four manifests** — `package.json`,
   `server/package.json`, `web/package.json`, `desktop/package.json`. They are
   kept identical on purpose: the app stamps its version into the server bundle
   at build time, and a server reporting a different number from the window
   drawing it is a bug report nobody can act on.
4. **Commit, tag, push.**

   ```sh
   git add CHANGELOG.md package.json server/package.json web/package.json desktop/package.json
   git commit -m "release 0.2.0"
   git tag -a v0.2.0 -m "kururu 0.2.0"
   git push origin main --follow-tags
   ```

   Git writes are normally forbidden in this repo without being asked
   (`CLAUDE.md` rule 5). Invoking this skill with a version *is* the asking, and
   it covers these commands and no others. Never `--force`, never rewrite a tag
   that has been pushed: the release is built from the tag, so a moved tag is a
   release whose notes and binary disagree.

5. **The tag is the trigger.** `.github/workflows/release.yml` builds, signs and
   notarizes the DMG, publishes the GitHub release with this section as its
   body, and updates the Homebrew tap. Watch it, and say plainly whether it
   passed:

   ```sh
   gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
   ```

   If it fails, the tag stays and the fix is a new patch version. Do not delete
   and re-push a tag to retry a build.

## After it lands

`/api/update` compares the running version against the latest release, so a
release nobody published leaves the *Check for updates* button saying the user
is current when they are not. If the workflow did not finish, say so — that
button is the only thing most people will ever see of this whole process.
