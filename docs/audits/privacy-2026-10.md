# Privacy audit, October 2026

Done on 2026-10-17, before the release after 0.3.0, over everything a stranger
can see or download: the public repository and its whole history, the shipped
app, kururu.dev, and the GitHub releases. The question was whether anything
personal to the user, or any of their data, leaves with kururu. No secret is
repeated here.

## What was looked for

Names, emails, phone numbers, home paths, hostnames, Tailscale addresses and
tailnet names, the user's machines, their project and client names (taken from
their own workspace list, read-only), API keys and tokens of every shape
kururu handles (Anthropic, OpenRouter, Firecrawl, GitHub, Telegram, Vercel,
Cloudflare, JWTs), profile ids, and real conversations — every Kuru turn and
card title in the user's database was checked against the repository and its
history, and none appears in either.

## Secrets

**None, anywhere.** Not in the tree, not in any of the 62 commits, not in the
app bundle, not on the site. Every key-shaped string is a test fixture
(`fc-0123…`, `123456789:AAH-x_…`). Nothing needs rotating.

## Fixed in the tree

| what | where | severity |
|---|---|---|
| The self-hosted Firecrawl's deployment written up in full: its Tailscale address, a LAN address, the box's interface names, firewall rules, container names, its size and what else runs on it | `docs/web.md` | medium |
| The source maps shipped inside the app carried the whole source, every comment included — so every name below that was in a comment was also in the DMG | `desktop/build.mjs` (now `sourcesContent: false`) | medium |
| Tailscale addresses that are, or may be, the user's own, as placeholders and fixtures | `desktop/connect.html`, `desktop/servers.js`, the Firecrawl provider's placeholder and help, tests | low |
| Client and project names as examples: in the harness's role prompt (so in every harness session and the app), comments, docs and tests | `shared/harness.ts`, `shared/kuru.ts`, `server/src/harnesshome.ts`, `desktop/vite.js`, `docs/`, `server/test/` | low |
| The user's machine name and its login, the Mac's user name and project folder, a profile's name | tests, comments, `docs/machines.md`, `docs/testing.md` | low |
| A login example with the owner's first name | `CHANGELOG.md` (0.3.0), and the v0.3.0 release notes edited to match | low |
| A Developer-ID-style example name in a comment | `shared/channels.ts` | low |
| Nine `.orig` merge leftovers tracked by accident | untracked, `*.orig` ignored | low |

The deployment write-up still exists, for the user, in `docs/private/`, which
is gitignored along with `docs/research/remote-*.md`. `docs/web.md` keeps
a generic "Running your own Firecrawl".

## Clean

- **The site.** Every screenshot and the Open Graph image is the made-up
  "Acme" profile (storefront, api, mobile, docs-site); no prompt, path, real
  conversation or metadata. No analytics, no source maps served, fonts
  self-hosted. The live files match the repository byte for byte.
- **The app's defaults.** Nothing points at the user's machines: backups off
  with no remote, no Firecrawl address, no machines, Telegram off. No build-time
  environment is baked in beyond the version. No telemetry or crash reporting.
  Docs, tests and `CLAUDE.md` are not packaged.
- **Off the machine by default:** only the usage bar's request to Anthropic,
  with the user's own Claude login. Everything else — the update check, the
  styles registry, the Kokoro model download, OpenRouter, Telegram, Firecrawl,
  the backup push — waits for the user to open, set or switch something on.

## The history, rewritten

On the user's yes, the same evening, every commit and tag was rewritten with
`git filter-repo` and force-pushed (`main`, `v0.1.0`–`v0.4.0`), after a mirror
backup of the old history was taken outside the repository. Nothing else used
the repository: no worktrees, no other clones, no uncommitted work.

| what | done |
|---|---|
| The Firecrawl deployment write-up | its section replaced, in every version of `docs/web.md`, by the generic one the tree has; three commit messages that named the machine reworded |
| Client and project names, the machine's name and login, the Mac's user name and folders, a profile name, the user's Tailscale addresses, a place in a search fixture | the same neutral examples as the tree, in every commit; the newest commit's tree came out byte-identical |
| The owner's legal name in a note about notarizing | `<name>`; the team id stays, as it is in the signature anyway |
| The commit email | GitHub's noreply address on every commit and tag, and in this repository's git config |

Checked afterwards on a fresh clone of GitHub: no match for any of it in
`git log --all -p` or in any author, committer or tagger. Every rewritten tag
typechecks and passes its tests. A private LAN address remains in a QR test's
fixture, where changing it would change the expected matrix.

**GitHub still serves the old commits by their full hash** until it collects
them, which a force-push does not do; only GitHub Support can purge those
cached views. The repository has no forks and no pull requests holding them.

The 0.1.0–0.3.0 DMGs and zips, which carried the old source maps, were rebuilt
from the rewritten tags by the release workflow (dispatched from `main`, which
now replaces the files of a release that exists) and replaced in place.
