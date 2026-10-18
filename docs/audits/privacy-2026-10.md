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

## In the history, waiting on the user

All of it is pushed and public; removing any of it means rewriting history and
force-pushing, which also moves the `v0.1.0`–`v0.3.0` tags their releases were
built from. None of it is a credential.

| what | commits | severity |
|---|---|---|
| The Firecrawl deployment write-up (addresses, interfaces, firewall, containers) | `2e26930`, `96e5bc3` | medium — a map of a private network; nothing in it is reachable from outside the tailnet by its own checks |
| Client and project names, the machine's name and login, the Mac's user name and folders, a profile name, two of the user's Tailscale addresses | most commits since September | low |
| The owner's legal name and Apple team id, in a note about notarizing | removed in a later commit | informational — the same string is the public signature of every signed build |
| The commit email on every commit | all 62 | low — future commits can use GitHub's noreply address |

The DMGs and zips already on GitHub (0.3.0 checked; the earlier ones built the
same way) still carry the old source maps, with those comments in them. Replacing them means deleting release assets, which is also
the user's call.
