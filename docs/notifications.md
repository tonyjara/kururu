# Notifications

The policy is ghosttown's; the delivery is not.

`shared/notify.ts` is ghosttown's `notifyGate` and `notifyText`, with the same
headline words, so an agent that "needs input" here means what it means there.
Ghosttown's delivery is `terminal-notifier` with a `gt focus` baked into
`-execute`, because a TUI in somebody else's terminal has no other way to be
clicked. Kururu's client is a browser, so the card is the Web Notification API and
the click is `reveal-agent` over the socket that was already open: click-to-focus
is unconditional rather than depending on a homebrew package, and it works from
the phone, which ghosttown does not have.

Two of ghosttown's settings are deliberately absent — `program` (an OSC 9
notification the program asked for) has no kururu equivalent, and `ignore` exists
to trim exactly that source. Both come back when the source does.

## Rules

- **A notification is an event, so it is addressed and never a snapshot field.**
  Everything else the server pushes says what *is*, and a notification happens
  once — a `blocked` agent that stayed blocked would have its card raised on every
  status tick for as long as it held.
- **It is sent per client, not broadcast.** The one question the gate asks that is
  not a setting is whether *this* client can see the terminal, and the desktop
  showing a pane is not the phone in your pocket. The set consulted is `watching`,
  never `sees()`, since a warm pooled emulator is nobody looking.
- **The policy runs once, on the server, and the client applies none of it.**
  `shared/notify.ts` is pure and is the only place the decision is made; if a
  message reached the browser, it passed. A client that re-checked would be one
  rule in two places, and the half that drifted would be *invisible* — a
  notification that does not happen leaves no trace anywhere. It follows that
  `web/src/notify.ts` reads exactly two of the five settings, the sound and the
  volume, because those are the only two about making a noise rather than about
  whether to.
- **Notifications are noticed in `index.ts`, never in `agents/`.** A status is
  computed by the host, and diffing for the transition there would be the obvious
  place. It is also the half that costs the user every running agent to edit — and
  every threshold in a notification is a matter of taste, so this is a feature
  that will be tuned. `lastStatus` lives on the restartable side and is relearnt
  on a restart. The absent case and the unchanged case are deliberately separate:
  without that, a restarted server would announce every terminal sitting at `done`
  all at once.
- **A card says `claude`, never `starting…`.** `agentLabel` answers with that
  placeholder for a terminal whose program the process scan has not named yet,
  which is right in a sidebar — the row corrects itself two seconds later. A card
  does not: it is drawn once and keeps what it was handed, so it would sit in
  Notification Center saying nothing all afternoon. `announce` falls back to the
  command's basename, which is the one name a terminal has that never stops being
  true. Reachable two ways, so it is not theoretical: a report can arrive before
  the first scan, and `procs.ts` does not recognise every agent anybody runs.
- **`reveal-agent` is one verb, not four.** A click has to switch profile, switch
  workspace, focus a pane and select a tab, and the client sending those
  separately would be sending them against a layout it is by definition not
  looking at — the whole point of the card is that the agent is somewhere else. It
  uses `switchWorkspace` so the *way back* is recorded exactly as a manual switch
  is, which is not a detail: being taken somewhere by a notification is precisely
  when prefix+z has to still work. An id nothing holds moves nothing, because that
  is a card clicked after its terminal was closed.
- **`status.ts` can never produce `blocked`.** Nothing in a byte stream
  distinguishes "waiting for you" from "thinking". It arrives only via
  `POST /api/report`, and one report disables the heuristic for that agent
  permanently — a process that knows its own state beats a guess forever after.

## Sounds

**The sound is chosen on the server and played on the client, and that is the
only arrangement that works.** `/System/Library/Sounds` is the server's machine; a
phone has never heard of it and gets the sound anyway, because it fetches the
bytes like it fetches everything else.

Which forces the one piece of real work in `sounds.ts`: **Chromium cannot decode
AIFF** — measured, not assumed — and every one of macOS's alert sounds is AIFF, so
serving them as they sit on disk would put fourteen names in the dropdown that are
all silence. `afconvert` turns one into WAV in about 24ms, on the way out, behind
a year of `cache-control`. There is no transcode cache on purpose: these are the
OS's files, kururu does not own them, and a directory of copies goes stale the day
somebody updates the system.

**A sound id is resolved by lookup, never pasted into a path.** The catalogue is
built by reading directories, each entry keeps the absolute path it was found at,
and an id is matched against that list — there is nothing to traverse. It is also
why `isSoundId` is deliberately weak and allows a space: a file somebody dropped
in `~/Library/Sounds` is allowed to be called `deep bell`.

Picking a sound in Settings plays it — a list of words is not a list of noises,
and it is also where the autoplay unlock happens.

**And a third source, which is the only one anybody chose:** a `sound` entry
installed from the styles registry, so a pack can bring the noise its window
makes. It reaches the catalogue through `installedSounds` in
`server/src/styles.ts` rather than a `readdir`, it sits between kururu's own and
the machine's so that a registry entry cannot take the `croak` id out from under
every existing `notify.json`, and it is the one source whose formats are
restricted to what a browser decodes unaided — there is no `afconvert` on Linux
and an entry that needed one would be silence on half the machines that installed
it. Installing a pack with `activate` writes `notify.json`'s `sound` and nothing
else: `enabled` and `events` are a decision about being interrupted, which is not
a style's to make. See [styles](styles.md#sounds).

## macOS delivery, the expensive way

A branded dev shell **must be re-signed**, or macOS silently refuses its
notifications. `desktop/brand.mjs` stamps kururu's id into the Electron copy in
`node_modules`, and used to argue — correctly — that re-signing was unnecessary
because the prebuilt bundle is linker-signed ad-hoc and nothing we write is
sealed. That answers *will it launch*. macOS's notification service asks a
different question: it keys authorisation on the **code-signing identifier**, not
on `CFBundleIdentifier`. A bundle stamped `io.github.tonyjara.kururu.dev` whose
signature still says `Electron` is one `usernotificationsd` will not authorise —
it never prompts, it never appears in System Settings → Notifications, and every
notification fails with `UNErrorDomain error 1`. The symptom is the whole feature
working except the part you can see: the sound plays and no card appears.

`brand.mjs` does one `codesign --force --sign - --identifier`, **last**, because
the re-signed bundle *does* have sealed resources and the plist and icon it just
wrote are inside them.

Traps around that, each of which cost time:

- `codesign --verify` fails on the *stock* bundle too, so its verdict proves
  nothing. Read the `failed` event's error, or `Identifier=` from `codesign -dvvv`.
- `codesign -dv` prints to **stderr** and exits 0, so an idempotence check built
  on `execFileSync` reads an empty string and re-signs every time while reporting
  that it did not.
- **Re-signing fixes the bundle, not a window that is already open.** A Mach-O's
  identity is fixed at exec, so a window launched before `brand.mjs` re-signed
  goes on being refused for as long as it stays up — no prompt, no error, nothing
  in the page that could report it, while the sound keeps playing because that
  half is kururu's own Web Audio. It cost a morning exactly once: the fix landed
  at 00:39 and the window being tested had been running since 23:33. **Anything
  that re-signs the Electron copy ends in relaunching the window**, which is free.
- **Launch Services can hold two registrations for one bundle id**, and the stale
  one is enough to keep notifications dead — one entry reading
  `codeInfoID: Electron` and another reading the real id, with nothing on disk
  looking wrong. `lsregister -u <app>` then `lsregister -f <app>` clears it;
  `-dump | grep -A3 'identifier:.*kururu'` shows which records exist. It is at
  `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister`.
- **Do not diagnose a missing banner from `com.apple.ncprefs` or the `usernoted`
  database.** Both read exactly like "never authorised" when they are simply not
  where the answer lives: a card was raised, displayed and clicked while the
  bundle id was absent from both, and absent again afterwards while System
  Settings listed it as allowed. `log show` for `usernotificationsd` answers
  nothing from a Claude Code shell either. The one probe that cannot mislead is an
  Electron `Notification` **in the main process** with `show`, `failed` and
  `click` handlers, since a `click` is the one event no misreading can
  manufacture. Give it eighty seconds, not six.
- **Two things suppress the banner while leaving everything else working**, and
  both are worth excluding before reading a byte of kururu. A **Focus**, which
  stops the card and never the sound (an empty `storeAssertionRecords` in
  `~/Library/DoNotDisturb/DB/Assertions.json` means none is active). And
  **Notification Center being open** — macOS draws no banners at all while that
  panel is up, so an afternoon spent opening it to check whether the cards arrived
  is an afternoon during which none of them can appear. That was the actual answer
  the one time this was chased end to end.
- macOS files *every* notification into Notification Center whether or not it drew
  a banner, so a growing `record` count says only that delivery works. It cannot
  tell a presented card from a suppressed one.
