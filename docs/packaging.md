# Packaging, signing and updates

`bun run dist` produces the signed, notarized DMG + zip; `bun run dist:unsigned`
is the same bundle with nobody's name on it, for testing.

## What a downloadable kururu is made of

`desktop/electron-builder.yml`. The server, the host, `web/dist` and `assets`
travel as **resources**, not in the asar, so spawning them stays an ordinary
spawn.

- **`entitlements.mac.plist` asks for four things and nothing else:** JIT,
  unsigned executable memory, DYLD variables (that is how the server is started)
  and library validation off (node-pty).
- **`notarize.mjs` is the `afterSign` hook:** zip, submit, wait, staple — before
  the DMG and the zip are built from the app, because the zip is what the updater
  takes.
- **node-pty ships 58MB of Windows** out of 62MB total: two `conpty` builds and
  their `OpenConsole.exe`. Unfiltered they are copied into the app and handed to
  codesign — a Windows binary signed with a Developer ID for no reason and then
  notarized. The `filter` takes `lib/**` and the two darwin prebuilds and nothing
  else, which is exactly what `lib/utils.js` goes looking for.
- **node-pty needs no `@electron/rebuild`.** Its prebuilds are N-API, so the same
  binary loads in Node 24 (ABI 137) and Electron 44 (ABI 149). Do not add a
  rebuild step to "fix" a spawn failure — check the executable bit first.
- **The release workflow builds both architectures in ONE invocation.** Two would
  leave `latest-mac.yml` naming whichever ran last.

## Three things learnt the expensive way

- **electron-builder resolves its relative paths from two different places, and
  nothing says which.** `files` and `extraResources` are relative to
  `--projectDir` (`desktop/`), so `../web/dist` is how the web build is reached.
  `afterSign` and `entitlements` are relative to the **workspace root**, which the
  tool detects from the lockfile. The first fails as `Cannot find module
  '/…/kururu/notarize.mjs'` and names a path nobody wrote; the second fails as
  `entitlements.mac.plist: cannot read entitlement data`, which names the plist
  and never the path, so it reads as a malformed plist. Entitlements are not
  resolved by electron-builder at all — the string is handed to codesign, which
  resolves it against its own working directory.
- **A `mac.identity` in the config overrides `CSC_IDENTITY_AUTO_DISCOVERY=false`**,
  so a build that names one can never be asked for unsigned.
- **Naming the identity by fingerprint disambiguates nothing.** electron-builder
  resolves whatever it is given back to the certificate's *name* before shelling
  out, so two Developer ID certificates with the same name stay ambiguous and
  codesign refuses rather than choosing. The keychain is expected to hold exactly
  one.

## The version

**Stamped in by the bundler, never read off disk.** A packaged app's
`package.json` is inside an asar at a path that depends on how it was packaged, so
a runtime read is the kind of thing that works in the checkout and fails in the
thing you shipped. `desktop/build.mjs` defines `KURURU_VERSION` and
`server/src/version.ts` falls back to `0.0.0-dev`, which the update check reports
as *"running from a checkout"* rather than as up to date — the two are the same
picture and opposite facts, and only one means you can stop thinking about it. The
same rule holds the whole way down that page: `error` and `newer: false` are never
collapsed.

## Updating

**`update.ts` checks and never installs.** What installing means depends on how
kururu got onto the machine — a DMG has an updater, a cask has `brew upgrade`, a
checkout has `git pull` — and only the thing that did the installing knows which. A
page served over HTTP is also the wrong thing to be able to swap the application
serving it, which is the line `preload.js` already draws at `file:`. So the server
answers *what is out there* and the doing belongs to the window, or to the person.

**The window installs, and only for the server it started itself.** About draws
the *server's* version, so the number on that page is this bundle's exactly when
the window launched the server out of its own `Resources`. Pointed at a machine in
a cupboard — or at a `bun run dev` that answered on 7717 first — replacing this
.app would leave the page reporting what it reported before, which reads as an
update that silently did not happen. Those cases get the link to the release page,
which is also what a browser and the phone get. What a page may say is "fetch it"
and "now", and nothing else.

The feed is `app-update.yml` inside the bundle, written by electron-builder out of
the `publish` block and not addressable from a renderer. Squirrel then refuses an
archive whose signature does not satisfy the running app's designated requirement.
That requirement is bundle id, Apple anchor and team (`W4YCRC53PL`) with nothing
version-specific in it, so every release signed by the workflow satisfies every
earlier one — and an **unsigned local build satisfies none of them**, which is why
a `dist:unsigned` app cannot be used to test the install half and fails with `code
failed to satisfy specified code requirement(s)`.

**The honest gap:** nothing can auto-update *to* 0.1.1, because 0.1.0 shipped with
no updater in it. Everybody on 0.1.0 takes the link one more time. The first
release this path runs for real is 0.1.1 → 0.1.2.

## Releases

`CHANGELOG.md` has one section per release, and that section is also the GitHub
release body and the *What's new* the About tab draws. Written once.
`tools/release-notes.mjs` extracts one version's section so the release body and
the file cannot drift; it **refuses rather than falls back**, because an empty
release body ships and cannot be taken back.

`.claude/skills/release/` is how a section is drafted and a version cut:
`/release` refreshes Unreleased, `/release 0.2.0` stamps it and tags.

**Still owed:** the Homebrew tap, and a version in the host handshake — the one
piece that costs a pty host restart and is therefore batched with it.
