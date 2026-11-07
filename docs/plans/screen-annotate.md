# A pen on the whole screen, tied to what was said

A plan, written 2026-11-06 from a read of the tree at `1074bd0` (browser
phases 0 and 1 built), of `docs/voice.md`, and of the prior art below; the
user's answers folded in the same day ([what they decided](#what-the-user-decided)).
**Phase 1 is built** (9833330 server, d404743 desktop and web) and not yet
pressed in the real app: it needs a rebuilt app and Screen Recording granted.
**Phase 2 is built** too (2026-11-06, [below](#phase-2-kururu-aware-marks-and-the-pen-made-pleasant)),
and is as unpressed. Phases 4 and 5 are not.
It is written so that an agent can take one phase, read the files it names,
and know what "done" is.

**The ask, in the user's words (by voice):** a pen on the voice pill, "like
drawing on a shared screen in Slack", for pointing at things *outside* the
built-in browser: kururu itself, other apps, other browsers, a tab switched to
mid-sentence. Kururu gets the drawings on a timeline. If at second 10 they say
"this button" and circle it, the circle and that part of the screen go with
those words, so Kuru or an agent knows what was meant. No video of every
frame, which is wasteful; optimised. Possibly a better road than the browser
marks of [browser-annotate](browser-annotate.md).

## What the user decided

Answered on card KUR-241, 2026-11-06, and approved with "start the plan now".
Each answer below replaces the question that stood here; the phases are
written to them.

1. **Where a session goes:** straight to Kuru as the user's turn, through the
   outbox, with no stop in Kuru's box to review it.
2. **How the pen is held:** ⌃⌥⌘D toggles it, and the pill has a pen button.
   **And in phase 1, a pen with no voice:** a pencil beside the microphone in
   the Kuru drawer's box, added the way that mic was. Tapping it turns the pen
   on over the screen with no recording; the marks it makes go into the box as
   chips (`[marks N on screen (…)]` and a `[mark n …]` line each), and the user
   types about them and sends — for the times they cannot talk. So the pen is
   not tied to a recording; a recording is one of the two ways to have it.
   Hold-to-draw on a key is still phase 2's, and only if wanted.
3. **The ink fades** about three seconds after the pen last lifted, like a
   laser pointer — in phase 1, not phase 2.
4. **What is kept of the screen:** the whole display shrunk to 1568 px on its
   long edge, and the crop around the ink at full resolution, both inked.
5. **Other browsers' addresses: off.** [Phase 3](#phase-3-addresses-in-other-browsers-dropped)
   is not built. The window's title is what a mark on another browser carries.
6. **Browser-annotate's phase 7 (the Chrome extension) is dropped.**
7. **The built-in browser stays** for now (its removal is a card of its own).
   The screen pen shares its marks folder, sweep, chips and Send, as below.

## Verdict

- **Build it, beside the browser marks, on their plumbing.** The browser's
  marks know *what an element is* (its selector, its role, its source line),
  which pixels never will; the screen pen reaches *everything*, which the
  browser never will. One folder, one sweep, one gate, one chip grammar, one
  Send. Not a replacement.
- **No video, and not even a stream.** One still per *burst* of ink, taken at
  the burst's **first pen-down**, of that display only, with kururu's own
  overlay windows excluded by ScreenCaptureKit's filter. The ink is vectors,
  drawn onto the still afterwards, so the picture is the screen as it was when
  you started pointing, with exactly your ink on it.
- **The words are already timed.** `yap`, which hears every clip today, takes
  `--json --word-timestamps` and gives each word its start and end (below). The
  server calls it with `--txt` and throws the times away.
- **The overlay exists only while a session is on**, one transparent panel per
  display, made at the start and closed at the end. Not a window that sits over
  every display for the life of the app.
- **A small Swift helper does the two things Electron cannot do well**: a
  still of one display excluding given windows, and "which app and window is
  under this point" with its title. It is `talkkey`'s pattern: a bare Mach-O,
  a process of its own, JSON lines on stdio.
- **Screen Recording is the one new permission**, asked once, on the first
  pen. Denied, the pen says so and does nothing; there is no half-mode.
- **The result is a set in `data/marks/<id>/`**, `kind: "screen"`, whose
  `marks.md` is the transcript with `[mark n …]` inline at the words they went
  with, and whose pictures are the crops and the frames. Kuru gets the header
  line and the transcript; the existing chips draw it unchanged.

## Prior art

Short, as asked. Three tools already do almost exactly this, which is
reassuring about the idea and useful for the details. All are Mac apps aimed
at coding agents; all record **video** and pick frames afterwards.

| tool | what it does | what to take |
|---|---|---|
| [voice-annotate](https://github.com/andropar/voice-annotate) (MIT, Swift, 2 stars) | Menu-bar app: talk and draw; a **Snapshot** mode freezes every display and you draw on the still, a **Walkthrough** mode records the screen and draws laser ink that fades (hold ⌃⌥ to draw). Whisper on device with word times. Output: `capture.md` with marks cited at the word being spoken, e.g. "This best `[#1 circled (301,290)-(450,340) in frame 1]` accuracy says 312%.", the frames, `events.json`, audio, the recording; pruned after 14 days. | **One clock for everything** (`mach_absolute_time`); the mark placed at the word being spoken; a shape word (circled, boxed, arrow) and the box in image pixels; native-resolution detail crops on 4K/6K; "a burst of strokes is one reference, placed where you started". Its Walkthrough keyframe picker (64×40 luminance diffs, settle/click/speech-onset candidates, ≥1.2 s apart, ≤30) is what you need *if* you record video; we don't. |
| [Hex](https://github.com/anomalyco/hex) Annotate (MIT, Rust + Swift, the opencode people) | Dictation app with an Annotate feature: records the screen while you draw and talk, hands an agent "its keyframes, your drawing and a transcript". `crates/capture-core` is a ScreenCaptureKit recorder: each source to its own H.264, everything on Mach host time, a versioned `capture.json`, overlay windows **excluded through `SCContentFilter`**, keys kept only as ⌘/⌃ chords and **dropped while secure input is on**. | The exclusion by filter, not by `sharingType`; secure input as the "a password is being typed" signal; `screenshot(&Source, &Exclusions, long_edge)` through `SCScreenshotManager` is exactly our helper's one verb. Its routing (guessing which agent session gets the capture) is a problem kururu does not have: Kuru gets it. |
| [Annotate](https://www.aat.ee/projects/annotate) (free, closed) | Narrated, annotated screen sessions read by the agent over MCP: "frames and speech, not a giant video dump". | The agent pulling pictures on demand rather than all of them pushed in, which is what `marks.md` naming files does. |
| Doodler ([Product Hunt](https://www.producthunt.com/products/doodler-co)), Scrawl, VoiceInk [PR #75](https://github.com/LuisUrrutia/VoiceInk/pull/75) | The same shape again: one shortcut, draw and talk, annotated screenshots plus a timeline to the agent. VoiceInk's PR records H.264 at up to 60 fps and plans keyframes later. | Nothing new beyond the above. |
| Slack huddles, Zoom annotate, Loom's drawing tool, Presentify, ScreenBrush, Epic Pen, CleanShot | Ink over a shared or recorded screen for *people*. The sharer may disallow drawing; ink fades or is cleared; a coloured border says "this screen is live". | The border (a thin tint round every display while the pen is on, so the mode is never in doubt) and fading ink. None pipes anything to a model. |

**Can we use one?** Not as a dependency. Each is a whole app with its own
recogniser, its own permission story and its own idea of where the result
goes, and kururu already has the microphone, the recogniser, the outbox, the
panel and the receiver. What is worth lifting is small and is lifted as ideas:
the one clock, the at-the-word placement, the shape word, the filter
exclusion, secure input. If phase 1's helper fights ScreenCaptureKit, Hex's
`screenshot.rs` and voice-annotate's capture code are MIT and the place to
read.

**Where kururu differs from all of them:** they record continuously and throw
most of it away. The user's own marking is a better keyframe signal than any
luminance diff: a person who circles something is telling you, at that
moment, which frame matters. So we take one picture there and nothing else.

## What is there today

**The pill** is `web/src/components/VoicePill.tsx`, drawn in the main window
and, while the talk key is hooked system-wide, in a panel of its own:
`desktop/talkkey.js` `ensurePanel` makes a frameless, transparent,
non-focusable `type: "panel"` `BrowserWindow` at the `floating` level, on all
spaces including full-screen ones, shown while the pill has something to say.
That page is then the one voice client on the Mac (`setVoiceRemote`): it holds
the microphone and the player.

**Recording** is `web/src/voice.ts`: PCM off an `AudioWorklet`, 16 kHz mono,
a hand-written WAV (`encodeWav`), `recording.startedAt = performance.now()` at
the start. Hold to talk sends on release; a tap opens the microphone until the
next tap. At five minutes (`CLIP_ROLL_MS`) what there is goes as a message of
its own and recording carries on. Every clip is stashed in IndexedDB
(`unsent.ts`) before it is posted to `POST /api/voice/hear` under an id the page
minted.

**Transcription** is `server/src/outbox.ts` → `Voice.transcribe`
(`server/src/voice.ts:351`), which runs `yap transcribe --locale <l> <wav>
--txt` once per language the user speaks and keeps the likelier transcript
(`pickTranscript`). The outbox keeps the clip until Kuru's session confirms
the words, retries a failed transcription and an unconfirmed delivery.

**Word-level timestamps: yes, unused.** `yap transcribe --help` lists
`--json --word-timestamps`. Tried on a clip made with `say` (4.4 s, 0.5 s to
transcribe):

```json
{ "metadata": { "duration": 4.38, "language": "en-US" },
  "segments": [ { "start": 0, "end": 1.98, "text": "Look at this button here, then move it",
      "words": [ { "start": 0, "end": 0.3, "text": "Look" }, { "start": 0.3, "end": 0.48, "text": "at" },
                 { "start": 0.48, "end": 0.54, "text": "this" }, { "start": 0.54, "end": 0.72, "text": "button" },
                 { "start": 0.72, "end": 1.26, "text": "here" }, … ] }, … ] }
```

Synthetic speech is kinder than a person; the times on a real voice, and on
Spanish, are owed in phase 1's done. Segments are cut at 40 characters by
default (`--max-length`), which does not matter: the words carry the times.

**Browser marks** (phase 1 of browser-annotate) already give: `shared/marks.ts`
(the set, its redaction, `marksMessage`, `marksMarkdown`, `sweepable`),
`server/src/marks.ts` (`keepMarks` writing `data/marks/<id>/` at 0700/0600, the
30-day sweep with a `lifecycle.log` line per set, the picture judged by its
bytes), `POST /api/marks` and `GET /api/marks/<id>/<file>` behind the gate, and
`shared/chips.ts`'s `marks` and `mark` chips. The `MARK` pattern
(`\[mark n label\]`) matches anywhere in a line, so a mark *inside* a sentence
is already a chip; the `MARKS` header takes any word without spaces or
brackets as its page, so `[marks 3 on screen (…/marks.md)]` is too.

## The design

### The session

A **session** is one recording with the pen available, and it is what is
sent. Phase 1 keeps it to one clip:

- **Starting.** The shortcut, the tray's **Annotate**, or the pill's pen
  button. Any of them opens the microphone in the tap grammar if it is not
  already open, makes the overlays and turns the pen on. A press of the talk
  key that is already recording just gains a pen.
- **During.** The pen toggles (the shortcut, the pill's button). Pen off, the
  overlays ignore the mouse and the apps get their clicks; the ink stays, or
  fades (question 3). Pen on again, the next stroke is a new burst.
- **Finishing.** The talk key's tap, the pill's **Send**, or the shortcut held
  for half a second. **Escape** with the pen on lifts the pen; Escape with the
  pen off is today's Escape, which throws the clip away, and with it the ink.
  (Escape is seen, not swallowed — `docs/voice.md#escape` — so it also reaches
  the app in front; that is today's edge, unchanged.)
- **The roll.** At `CLIP_ROLL_MS` the clip that ends takes the marks drawn
  so far as a set of its own, and the session carries on with the pen, the
  next clip's marks numbered from one (phase 2; phase 1 ended the session
  there).
- **One session at a time**, on this Mac, in the one voice client.
- **A session with no voice** (question 2's pencil): started from the pencil
  in the Kuru drawer's box, with no microphone. The same overlays, pen,
  bursts and pictures; it ends on the pencil again, the overlay's Done, or the
  shortcut's toolbar, and its set goes into *that window's* box as the header
  line and a `[mark n …]` line per burst, for the user to type around and
  send. ⌃⌥⌘D during it toggles the pen as in any session.
- **The toolbar.** Every session draws a small bar of its own at the top of
  the display it started on — the pen's state, Done, ✕ — in the overlay, so
  there is always a way out that does not depend on the pill being up (the
  pill is a panel only while the talk key is hooked; without it the voice
  client is the main window, under the ink). With the pen off the overlay
  ignores the mouse except over the bar (`setIgnoreMouseEvents(true,
  { forward: true })`, the page saying when the pointer is on it).

**Why not "hold the talk key and draw"?** It would be lovely and it fights
itself: a hold is one hand on right Control and the other on the trackpad,
and the pen has to *take* the mouse, so nothing could be clicked while you
talked. The tap grammar is hands-free, which is what pointing wants.

### The overlay

`desktop/ink.js`, a module of main's (listed in `electron-builder.yml` by
name — [the trap](../../desktop/electron-builder.yml)). One `BrowserWindow`
per display in `screen.getAllDisplays()`, at the display's `bounds` (not its
`workArea`, so the menu bar and the Dock can be drawn on):

- `frame: false`, `transparent: true`, `hasShadow: false`, `type: "panel"`,
  `focusable: false` (the pill panel's ✕ shows a non-focusable panel still
  takes mouse events), `skipTaskbar`, `setVisibleOnAllWorkspaces(true,
  { visibleOnFullScreen: true })`.
- **Level:** `screen-saver` while the pen is on, so the ink is over the menu bar
  and every app's own floating windows; the pill panel is raised to the same
  level and `moveTop` for the session so its buttons stay reachable over the
  ink. Back to `floating` after.
- **Pen off:** `setIgnoreMouseEvents(true)`; **pen on:** `false`, and a pen
  cursor and a thin accent border on every display (Slack's "this is live").
- **The page** is `desktop/ink.html`, a file the app ships, with a preload of
  its own (`desktop/inkpreload.js`) — not the web build in a one-thing mode,
  as this plan first said. It needs nothing from a server: a full-window
  `<canvas>`, pointer handlers and the toolbar. A served page would be one
  more thing a server restart under `bun run dev`, a stale `web/dist` or a hot
  update could break mid-session, and a stuck overlay is the one failure here
  that costs the whole Mac. It draws locally for zero latency and sends each
  stroke to main as it goes: `pointerdown` → `begin`, coalesced `pointermove`
  (`getCoalescedEvents`, so a fast circle is round) → `points`, `pointerup` →
  `end`. `pointerType` and `pressure` are kept, for a Pencil on Sidecar later.
- **Fading** (question 3): a burst's ink fades out over half a second, three
  seconds after its last stroke lifted. Its picture is already taken.
- **Displays changing** (`display-added`, `-removed`, `-metrics-changed`)
  closes and remakes the overlays; the ink is main's, so it is drawn again.
  `talkkey.js` `watchDisplays` is the precedent and its gotchas apply.
- **Made at the session's start, closed at its end.** Rejected: one overlay
  per display for the life of the app, click-through until needed. It is a
  transparent window over everything all day, composited by the window server,
  in every space and over every full-screen app, for a feature used for a
  minute at a time; Electron's transparent click-through windows have a long
  tail of hit-testing bugs, and a stuck one is a Mac where nothing can be
  clicked. Making four windows takes well under a second, and the first stroke
  can begin while they load because the shortcut's moment is when the session
  starts, not when the pen is first down.

**The way out is never in doubt:** Escape, the shortcut, the pill, the tray,
and a watchdog in main that closes the overlays if the voice client that owns
the session goes (`render-process-gone`, a reload) — the pill's own
`render-process-gone` handler is the model. A session can never leave a
display that takes the mouse and does not give it back.

### The strokes

Held in main, as vectors, on one clock:

```ts
interface InkPoint { x: number; y: number; t: number; p?: number }  // display points; ms from the session's start
interface InkStroke { display: number; tool: "pen"; points: InkPoint[] }
interface InkBurst { n: number; display: number; strokes: InkStroke[]; t0: number; t1: number;
                     box: { x: number; y: number; width: number; height: number };  // display points
                     frame?: string; crop?: string; under?: Under }
```

- **The clock.** Main's: every event is stamped with `performance.timeOrigin +
  performance.now()` *in the renderer that saw it* (the overlay page for ink,
  the voice client for the microphone's first sample), which are epoch-based
  high-resolution times on the same machine, and main subtracts the session's
  start. The error is a few milliseconds plus the microphone's own latency
  (tens of ms); a spoken word is 200–500 ms. Hex and voice-annotate use Mach
  host time throughout, which is better and needs native code in every piece;
  this does not.
- **Thinned** with Ramer–Douglas–Peucker at about half a point, so a two-second
  circle at 120 Hz is a few dozen points, not 240. A session's ink is
  kilobytes.
- **Bursts.** Strokes on the same display less than 1.2 s apart (pen-up to the
  next pen-down) are one burst, and a burst is one mark: an arrow drawn as a
  shaft and two heads is one thing pointed at, as is a circle and an underline
  drawn together. voice-annotate arrived at the same rule.
- **The shape word** (phase 2) is a pure classifier in `shared/ink.ts`: closed
  and roundish → circled, four corners → boxed, a line with a head → arrow to
  its tip, flat → underlined, otherwise drawn. It is a hint in the label, never
  load-bearing.

### The pictures

**One still per burst, at the burst's first pen-down, of that display only.**

- **Why pen-down and not pen-lift (the starting idea).** What you point at is
  what was there when you *started* pointing. The pen keeps clicks from the
  app, but not time: by the lift a video, a log or a toast may have moved on,
  and a long stroke is two seconds late. At pen-down the screen is the one you
  were looking at.
- **Why not one per stroke.** A circle and the arrow out of it are one thing;
  the second picture is a near-duplicate that costs tokens and adds nothing.
  Per burst is per *thing pointed at*.
- **Clean, then inked by us.** The helper is asked for the display *excluding*
  kururu's overlays and the pill panel (their window numbers, from
  `getMediaSourceId()`'s `window:<id>:0`), so the still has no ink at all,
  including earlier bursts' still on screen. The helper keeps the still in
  memory until the burst ends, then draws the burst's own strokes onto it
  with Core Graphics and writes the two files itself (`ink`, below) — rather
  than the overlay page compositing on an `OffscreenCanvas`, as first
  planned, which would carry a 5K still across two process boundaries and
  back as PNG bytes for every burst:
  - `mark-<n>.png`: the burst's box plus a margin (about 25% and at least 120
    points), at the display's **native pixels**. On a 5K display a crop is
    where text is still readable.
  - `frame-<n>.jpg`: the whole display, the same ink, shrunk to 1568 px on the
    long edge (Anthropic's guidance: an image past about 1.15 megapixels is
    scaled down anyway, and costs roughly width × height / 750 tokens — about
    2,000 for a full frame, 100–300 for a crop).
  - The ink is drawn at about 80% opacity in the accent colour, three points
    wide at the frame's scale, so what is under it can still be read.
- **Rejected: relying on `setContentProtection` / `NSWindow.sharingType`.**
  It was the old way to keep a window out of a capture, and ScreenCaptureKit
  has not reliably honoured it; the content filter is the documented
  mechanism, and Hex uses it. Rejected too: hiding the overlay for a frame and
  using Electron's `desktopCapturer` (a flicker at every pen-down, a race with
  the window server, a thumbnail API never meant for full resolution, and no
  exclusion).
- **The cost of no video**, honestly: what moves is lost. "When I click this
  the menu flickers" is a motion bug, and one still says nothing about it.
  Phase 2's **snap** (a key that takes a still of the display under the
  pointer, no ink, at that moment in the words) covers "and now look at this";
  a short clip around a burst is [not planned](#not-planned).

**For comparison:** a one-minute session at 1 fps of video frames is sixty
images, about 120,000 tokens if all were read; a minute with four bursts is
four crops (about 1,000 tokens) and four frames Kuru opens only if a crop is
not enough. That is the optimisation the user asked for, and it comes from
letting the pen choose the frames.

### The helper

`desktop/glance/glance.swift` → `desktop/dist/glance`, built by
`desktop/glance/build.mjs` beside `talkkey`'s (Xcode's `swiftc`; without it the
pen is missing and Settings says so). A long-lived process started with the
first session and kept until the app quits, so `SCShareableContent` is warm and
a still costs tens of milliseconds, not a cold start. JSON lines:

| in | out |
|---|---|
| `{"op":"access"}` | `{"screen":"granted"\|"denied"\|"unknown"}` — `CGPreflightScreenCaptureAccess` |
| `{"op":"ask"}` | `CGRequestScreenCaptureAccess`, the system prompt, once |
| `{"op":"shot","id":…,"display":<CGDirectDisplayID>,"exclude":[<windowNumber>…],"path":…}` | `{"id":…,"ok":true,"width":…,"height":…,"scale":…}` — `SCScreenshotManager.captureImage` with an `SCContentFilter(display:excludingWindows:)`, written as a PNG at a path main chose under the set's temporary folder, at the display's native pixels |
| `{"op":"under","x":…,"y":…}` (global points) | `{"app":"Safari","bundle":"com.apple.Safari","pid":…,"window":"Stripe — Payments","bounds":{…},"display":…}` — the topmost on-screen window at that point that is not ours, from `CGWindowListCopyWindowInfo` (its title needs Screen Recording, which we have) |
| `{"op":"secure"}` | `{"secure":true}` — `IsSecureEventInputEnabled()`: something has a password field focused |
| `{"op":"ink","id":…,"strokes":[[[x,y],…],…],"box":{…},"crop":…,"frame":…}` | the still `shot` kept under that id, with the strokes drawn on it, written as the crop PNG and the shrunk frame JPEG at the paths given; the still is then let go |
| `{"op":"drop","id":…}` | a kept still let go unused (a cancelled session) |

- **"Under the stroke", not "frontmost".** You can circle something on the
  second display while the app in front is on the first; the window under the
  burst's centre is the one you meant. `NSWorkspace.frontmostApplication` is
  recorded beside it for "where the keyboard was".
- **Electron's `display.id` is taken to be the `CGDirectDisplayID`** on macOS.
  That is how Chromium fills it, but it is **unverified** here; phase 1's done
  includes two displays, and if they differ the helper maps by bounds.
- **Secure input skips the picture**, not the mark: the mark keeps its place in
  the words and its app, and says "no picture: a password field was focused".
  Hex drops keys on the same signal.
- **A deny list** (phase 2): bundle ids whose windows are excluded from every
  still, by the same filter (`excludingApplications`) — 1Password, Keychain
  Access, Messages to begin with — editable in Settings → Voice. Their pixels
  never reach the disk.
- **Why a helper and not Electron**, again: Electron has no "a still of this
  display without these windows" and no "the window at this point". Both are a
  page of Swift each. A process of its own, on `talkkey`'s reasoning: it costs
  the pen and not the app when it dies, and it is restarted on the next
  session.

### Permissions

- **Screen Recording**, once, asked by the helper on the first pen with the
  system prompt. macOS attributes it to the responsible app, Kururu.app (or
  the dev shell, which `brand.mjs` re-signs as its own, so approved once per
  bundle — `talkkey`'s Input Monitoring precedent). macOS wants the app
  relaunched after granting; the pill says "Granted — relaunch kururu to draw"
  and the tray's Quit and Relaunch does it.
- **Denied, or not yet granted:** the pen is off, the pill says so with a
  button to the right pane of System Settings
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`).
  Rejected: a pen with no pictures (strokes and app names only). The words
  "this button" and a box in the coordinates of a screen nobody kept tell an
  agent nothing.
- **The periodic confirmation.** Since Sequoia, macOS asks again from time to
  time whether an app may keep recording the screen. It is the system's and
  the user's; nothing is done about it. (`SCContentSharingPicker` avoids it by
  asking every time, which is worse.)
- **Microphone:** the voice already has it.
- **Automation** for other browsers' URLs, [phase 3](#phase-3-addresses-in-other-browsers),
  behind a switch. **Accessibility** is never asked: the URL can be had
  without it, and swallowing keys (which would need it) is not wanted.

### What each mark knows

| where the burst landed | what goes with it | phase |
|---|---|---|
| any app | app name, bundle id, window title, the window's box; the frontmost app | 1 |
| a kururu window | the pane, its tab: an agent's title (never a bare id, per the harness's own rule), a reader's document and heading, a card's code and title, the Dashboard; asked of the page by main ("what is at this point"), answered by `elementFromPoint` → the nearest pane and tab | 2 |
| a kururu browser tab | the page's URL **and the element under the burst's centre**, by the marking script (`desktop/markscript.js`) in its isolated world: the same label (`button "Pay now"`), selectors and, after browser phase 3, source line as a browser mark | 2 |
| Safari, Chrome, Arc, Brave | the front tab's URL, by AppleScript — **dropped** (question 5); the window title only | — |

The kururu rows are where this and browser-annotate meet: a circle on a
kururu browser tab is as good as a browser mark, with the words around it for
a comment.

### The words and the marks

After the clip is heard, `alignMarks(words, bursts)` in `shared/ink.ts`, a
pure function, decides where each `[mark n …]` goes in the transcript:

1. **A pointing word nearby wins.** People say "this" a little before, during
   or just after they draw (gesture research has the gesture's onset near or
   slightly ahead of the word it goes with). So: the first deictic word —
   *this, that, these, those, here, there, it*; *esto, eso, este, ese, aquí,
   ahí, allí* — whose start lies in [t0 − 1.0 s, t1 + 1.5 s], and the mark goes
   right after it and the noun that follows if there is one ("this button
   [mark 1 …]").
2. **Otherwise at the word being said at t0**, after it; in a silence, at the
   next word's start ("… [mark 2 …] and then …").
3. **Never two marks on one word**: the second goes after the next word.
   **Never a mark lost**: one after the last word goes at the end, one with no
   words at all gives a transcript that is the marks in a row and
   "(nothing said)".
4. Each mark keeps its time and the six words either side, verbatim, in
   `marks.json`, so an agent that doubts the placement can judge.

The words can be misheard; the role prompt's `[voice]` caveat already covers
that. The alignment is tested on the cases above with hand-made word lists,
both languages, no recogniser in the test.

### The set and the message

**The same folder as browser marks**, `data/marks/<id>/`, the same id format,
the same 0700/0600, the same exclusion from backups and the same 30-day sweep —
so `sweepable` and the chips' "cleaned up" work unchanged. `marks.json` gains
`kind: "screen"` (absent means `"page"`, so every set already written reads
the same) and `MARKS_VERSION` goes to 2.

- `marks.md` — for an agent:

  ```md
  ## Marks on the screen, 0:38, 2026-11-06 22:41

  ### What was said
  So the sidebar here [mark 1 kururu: sidebar] is too wide, and this button
  [mark 2 circled in Safari "Stripe — Payments"] should be green like that
  one [mark 3 arrow in Safari "Stripe — Payments"].

  ### 1. kururu: the sidebar, workspace "kururu" — 0:02.1–0:03.0
  Said around it: "So the sidebar here is too wide, and"
  Underlined, box 22×380 at (10, 120) in frame-1.jpg.
  Pictures: mark-1.png (the ink and around it, full resolution), frame-1.jpg (the whole display).
  …
  ```

  The window titles and any page text are fenced and labelled as the screen's
  words, as browser marks label the page's: a window title is somebody else's
  string.
- `marks.json` — the record: words with times, bursts with strokes, `under`,
  display sizes, files.
- `mark-<n>.png`, `frame-<n>.jpg` — as above. **No audio**: the outbox keeps the
  clip until Kuru has the words and then ages it as it does today; the set
  holds what was *seen*.
- **Redaction** is `redactSet`'s, applied to the titles, URLs and the
  element facts: a `?token=` in a URL, anything shaped like a secret in a
  title. Pixels are not redacted; the secure-input skip and the deny list are
  what keep passwords out of them.

**The message** is the header and the transcript, with the marks inline:

```
[voice] [marks 3 on screen (~/.local/share/kururu/marks/m1a2b3c4d5e6f/marks.md)]
So the sidebar here [mark 1 kururu: sidebar] is too wide, and this button [mark 2 circled in Safari "Stripe — Payments"] should be green like that one [mark 3 arrow in Safari "Stripe — Payments"].
```

`chips.ts` draws the header as a `marks` chip and each `[mark n …]` as a `mark`
chip already. A label is cut at 48 characters (`LABEL_WORDS_MAX`) and carries
the shape word only from phase 2.

### The flow, end to end

1. Session starts: main makes the overlays and starts the helper; the voice
   client opens the microphone and tells main its start time.
2. Pen-down: main asks the helper for a still of that display (excluding ours)
   and `under` at the point; the stroke draws meanwhile. Pen-up and 1.2 s:
   main sends the burst's strokes and the still to its overlay page, which
   composites the crop and the frame.
3. Finish: main posts the set — strokes, bursts, pictures, start time, clip id
   — to `POST /api/marks` with `kind: "screen"`; the server writes the folder
   with no transcript yet and answers its id. The voice client posts the clip
   to `/api/voice/hear` as today, carrying `marks: <id>`.
4. The outbox gets the clip, transcribes it — with `--json --word-timestamps`
   when the entry has a set — aligns, writes `marks.md`, and hands Kuru the
   message above as it hands any words: typed as the user's, kept until Kuru
   confirms, retried.
5. A set whose clip never comes (the window died between 3 and 4) is swept
   with the rest at 30 days; the outbox never names a set it cannot find.

The order is the set first because the outbox is what must never lose words:
it is the durable half, and it should only ever *point at* a folder that
exists.

## Fit with browser-annotate

**Recommendation: beside it, sharing its plumbing, and reshaping its later
phases.** Not a replacement:

- **What only the browser marks have:** the element. A selector, a role, an
  accessible name, the React source line (browser phase 3), the console and
  network errors, a pin that follows the element when the page re-renders, and
  (browser phase 5) an agent that can click it by that selector. From pixels an
  agent can guess "the blue button"; from a mark it *knows* `src/Checkout.tsx:42`.
  For the user's own apps, which is most of the point of kururu, that is the
  difference between a fix and a guess.
- **What only the screen pen has:** reach. Kururu itself, Xcode, a simulator,
  Figma, Slack, another browser, the moment between two tabs. And speech as
  the comment, which the browser's popover only has as dictation per mark.
- **Shared, built once:** the folder and sweep, the gate and its routes, the
  chip grammar, `marks.md`'s conventions, the redaction, and **Send**: browser
  phase 4 (to an agent, to a card, the paste-size rule, the chips on cards and
  the phone) is written for "a set", and serves both kinds.
- **Where they meet:** a burst on a kururu browser tab asks the marking script
  for the element at that point (phase 2 here), so the pen on the built-in
  browser is a browser mark with a spoken comment.

**Changes to [browser-annotate](browser-annotate.md)'s phases:**

| browser phase | becomes |
|---|---|
| 2: a window of its own, and the Pencil on Sidecar | the window stays; the Pencil part is covered better here (the pen on a Sidecar display draws over *anything*), so its verification moves to [phase 5](#phase-5-the-pencil-on-sidecar) |
| 3: the source | unchanged, and screen bursts on a browser tab get it for free |
| 4: to an agent, to a card, chips everywhere | unchanged in scope, written for both kinds; [phase 4](#phase-4-the-same-send-as-the-browsers-marks) here is its use |
| 5: agents see the page and act | unchanged |
| 6: a CDP relay | unchanged (optional) |
| 7: a Chrome extension, marking only | **dropped** (question 7). Its reason was pointing at pages in the user's own Chrome; the pen does that, and phase 3's URL says which page. The DOM facts in Chrome are what is lost, and the built-in browser has them for anything that is not a Google sign-in. |

## Phases

| phase | what | rough size | costs on the machine |
|---|---|---|---|
| 1 | the pen, the pictures, the words, to Kuru | L | `desktop/` (window relaunch), `web/` (repaint), server (reconnect), a new Swift helper; **no host change** |
| 2 | kururu-aware marks, shapes, snap, fading, deny list, hold-to-draw | M | `desktop/`, `web/`, `desktop/talkkey/` (a second key) |
| 3 | ~~addresses in other browsers~~ dropped (question 5) | — | — |
| 4 | the same Send as the browser's marks | S (once browser phase 4 is built) | server, `web/` |
| 5 | the Pencil on Sidecar | S, and the user's iPad | none, if it works |

S is a day of an agent's work with verification, L about a week; guesses.
**No phase touches the pty host.** Nothing is in `server/src/agents/`,
`ptyhostd.ts` or the host link. The desktop app only: the phone and the web
client draw the chips and open the pictures (browser phase 4), and never get a
pen.

### Phase 1: the pen, the pictures, the words, to Kuru

The smallest thing the user can try: tap the shortcut, talk, draw on anything
on any display, tap the talk key, and Kuru gets the sentence with the marks in
it and can open each picture.

**Build:**

- `desktop/glance/`: the helper with `access`, `ask`, `shot`, `under`,
  `secure`; its `build.mjs`; `dist/glance` in `electron-builder.yml`'s
  resources and signed as `talkkey` is.
- `desktop/ink.js` (listed in `electron-builder.yml`): the session, the
  overlays per display, the pen toggle, the shortcut through `globalShortcut`
  (⌃⌥⌘D), Escape while the pen is on, the levels, the watchdog, display
  changes, bursts, stills at pen-down, `under`, the bundle the owning page
  posts to `/api/marks`.
- `desktop/ink.html` and `desktop/inkpreload.js` (both listed): canvas,
  pointer capture with coalesced events, the pen cursor and border, the
  toolbar, the fade. **One tool, one colour, no undo.**
- The pill: a pen button while a session is on, **Send**, the permission line;
  the tray's **Annotate**.
- The Kuru drawer: the pencil beside the mic, a session with no voice whose
  set goes into the box as chips.
- `web/src/voice.ts`: a session is a tap-grammar recording that tells main its
  start, carries the set id on the post, and finishes at the roll.
- `shared/ink.ts`: bursts, thinning, `alignMarks`, the screen message;
  `shared/marks.ts`: `kind`, version 2, `marksMarkdown` for a screen set.
- `server/src/marks.ts`: a screen set (`frame-<n>.jpg` judged by its bytes like
  the rest); `server/src/voice.ts` `transcribe` returning words when asked;
  the outbox entry's `marks`, the alignment and `marks.md` written after the
  words.
- Kuru's role: two sentences on `[marks … on screen]` — the file says
  everything, open the crop before the frame.

**Pure and tested:** bursts from strokes (gaps, displays), the thinning,
`alignMarks` on hand-made word lists in English and Spanish (a pointing word
before, during and after; silence; two marks on one word; a mark after the
last word; no words), the message read back by `chips.ts`, `marksMarkdown` for
a screen set, and `marks.json` version 1 still read.

**Done when:**

- With the dev shell granted Screen Recording **by the user** (an agent asks;
  it does not click through System Settings): a session on two displays,
  three bursts — one on kururu's window, one on another app, one on the second
  display — gives a folder whose crops show the ink at native resolution and
  whose frames show the whole display with no overlay or pill in them, and a
  message to a **stand-in** Kuru (an isolated instance whose harness command
  is `cat` to a file, per [testing by hand](../testing.md#testing-by-hand))
  with the three marks at the right words.
- The same with real speech in English and in Spanish: each mark is within a
  word of where a person reading it would put it. Written up with the word
  times, so the 1.0 s / 1.5 s window can be tuned.
- Escape, the shortcut, a reload of the voice client and a killed helper each
  leave every display clickable; no overlay is left behind in any of them.
- Pen off, a click reaches the app under the ink; pen on, it does not.
- With a password field focused, a burst keeps its place and says "no
  picture", and no still is on the disk.
- Denied Screen Recording: the pen does not turn on, and the pill says why.
- A set is swept at 30 days with the browser's sets, by the same rule.
- The drawer's pencil: three bursts with no microphone open give the header
  and three mark lines in the box as chips, and nothing is sent until the
  user sends it.

### Phase 2: kururu-aware marks, and the pen made pleasant

**Build:**

- the page's "what is at this point" in the main window and in a note window:
  pane, tab, agent title, document, card, Dashboard; the marking script's
  element at a point on a browser tab, with its label and selectors
- the shape word; the label's shape prefix
- undo (⌘Z with the pen on, the last burst, its picture dropped), a
  highlighter, two colours (fading moved to phase 1)
- **snap**: a key that takes a still of the display under the pointer with no
  ink, as a mark at that moment in the words
- the deny list, in Settings → Voice
- hold-to-draw (question 2): the talk-key hook watches a second key; held, the
  pen is on
- several clips in one session, if five minutes proves short

**Done when:** a burst on an agent's tab says that agent's title; one on a
kururu browser tab carries the same label and selectors a browser mark made
on the same element would; a 1Password window is absent from a frame taken
over it; an undone burst leaves no picture in the folder.

**Built, 2026-11-06, not yet pressed** (it needs the same rebuilt app and
Screen Recording as phase 1, and the talk-key hook rebuilt for hold-to-draw):

- *Kururu-aware marks.* At a burst's end main asks the window the helper
  found under the pen (by its window number, which `under` now returns, or
  by this process's pid and the bounds) what is at the ink's centre. The
  page answers from `data-ink-what`/`-name`/`-detail`/`-workspace`, which
  `Panes.tsx`, the boards' cards and a note window carry, and names the
  sidebar, the drawers, the file tree and Settings by class
  (`web/src/whatat.ts`). On a shown browser tab the marking script's
  `factsAt` reads the element as a mark does (`BrowserPool.elementAt` →
  `TabMarks.elementAt`, one isolated-world look, no script left on new
  documents) — three methods, so the browser's removal cuts them out whole.
  A page that does not answer in 1.5 s costs the mark its facts, never the
  mark.
- *The shape word* is the server's (`shapeOf` in `shared/ink.ts`), never the
  body's: highlighter-only → highlighted; a main stroke that closes on
  itself → circled, or boxed when it fills ≥ 86% of its bounds; a straight
  shaft with up to three short strokes at one end, or one stroke whose
  longest corner-to-corner run ends in a sharp turn back → arrow, with its
  tip; flat and level → underlined; otherwise no word.
- *Undo, a highlighter, two colours:* red and blue pens and a yellow
  highlighter, per stroke to the helper, which draws the highlighter under
  the pens with multiply. ⌘Z is registered only while the pen is down, as
  Escape is. An undone burst's still is dropped and its files removed; files
  are named by burst id, never by number, so a new mark 3 never meets an old
  one's pictures.
- *Snap* is ⌃⌥⌘S, registered only while a session is on, and the toolbar's
  Snap: the display under the pointer, no ink, the frame only (no crop), with
  the window under the pointer; the overlay flashes.
- *The never-capture list* defaults to 1Password (both ids), Keychain
  Access, Passwords, Bitwarden and Messages, is kept in `desktop.json`
  (`inkDeny`, null for the default) and edited in Settings → Voice → Screen
  pen. The helper leaves those applications out with
  `excludingApplications`, letting kururu's own windows that are not the
  overlays or the pill back in by `exceptingWindows`, and does not read a
  denied application's window title.
- *Hold-to-draw:* the right ⌘, held alone, through the talk-key hook's new
  `--draw` argument (a hook from before ignores it); the pen goes down while
  held and back as it was, only during a session; another key pressed with
  it lets go.
- *Several clips:* at the roll, as above.

**After the first press (2026-11-06).** The user tried phases 1 and 2 in the
real app; it worked, and four things changed:

- *The tools moved to the pill.* The toolbar at the top of the first display
  could not be moved. A session the floating pill owns has every tool in the
  pill now; any other gets `desktop/inkbar.html`, a small non-focusable panel
  of its own over the overlays, dragged by its background and put back where
  it was left (`inkBar` in `desktop.json`, used while it is wholly on a
  display). Showing the pill for those instead was rejected: the pill's page
  is the one voice client while it exists, and a pill made for a pen would
  be a second microphone and a second mouth. The overlays lost the bar and
  the mouse forwarding it needed.
- *Draw with every recording,* on by default (`inkWithVoice`, Settings →
  Voice → Screen pen): a clip to Kuru that opens asks main for a pen
  (`penWithRecording` in `web/src/voice.ts`); one that comes after the clip
  ended is let go, and a refusal stops the asking until a pen is started by
  hand. Dictation never asks.
- *The window is asked at the ink.* A line drawn down onto the drawer's
  header began on the desktop, and `under` was asked only at the first
  pen-down, so the mark was "the screen". The helper is now asked under the
  ink's centre, then where the pen last lifted, then where it began, and the
  page is asked at the point that found a window — or at the centre with
  none, since the floating pill is no window to the helper and `inkWhatAt`
  asks the pill's page first.
- *Kuru's drawer and the pill say which part* (`whatat.ts`): the header,
  the search, a line by whose, when and its first words, the box, the live
  line; the pill what it is saying. A place with no name of its own puts its
  control, or else its part, in the label.

### Phase 3: addresses in other browsers (dropped)

**Not built** — question 5's answer. What it would have been, for the record:

**Build:** in the helper, `url <bundle>` by AppleScript for Safari, Chrome,
Arc, Brave and Edge (the front window's current tab, the one under the burst
when the window matches), behind a switch in Settings → Voice that asks each
browser's Automation prompt when first used; `cleanUrl` and redaction on what
comes back.

**Done when:** a burst on each installed browser's page carries its URL with
the query's secrets redacted; with the switch off, no Automation prompt ever
appears.

### Phase 4: the same Send as the browser's marks

Once browser phase 4 is built, a screen set goes the same three ways: Kuru
(as now), an agent (the card's first, typed as `send_agent` types, the
paste-size rule), or a card. No "Send to box instead": question 1 chose
straight to Kuru, and the drawer's pencil is the road through the box.

**Done when:** a stand-in agent receives exactly the lines; a card shows the
chips and opens a crop on the phone's web client.

### Phase 5: the Pencil on Sidecar

With the iPad as a Sidecar display, it is a display like any other: it gets an
overlay, and the Pencil is the pointer. This phase is verification: the
overlay on the Sidecar display, `pointerType "pen"` and pressure through
Electron's Chromium (Patrick Lauke's pen tracker in a kururu browser tab
first), and a session drawn with the Pencil on the iPad and spoken at the
Mac. **The user's iPad and the user's to run**; written up for them.

A native iPad app, or drawing from the phone over a picture of the Mac, is
**never**: the phone is for watching and steering agents, and Sidecar already
makes the iPad the Mac's screen.

## Not planned

- **Video.** Not a stream, not a ring buffer of low-resolution frames "just
  in case", not a clip around each burst. If motion bugs turn out to be the
  thing the user most wants to show, a short clip of one display, started by a
  key and stopped by the next, is the honest version — and a question then,
  not now.
- **The audio in the set.** The outbox has it for as long as it is needed.
- **Linux or Windows.** The voice's ears are Apple's, and so is this.
- **Cloud transcription** to get better timestamps. `yap`'s are the ones we
  have; if they prove too coarse, WhisperKit (voice-annotate's choice) is the
  local alternative and a separate decision.

## Risks

- **A stuck overlay is a Mac nobody can click.** The watchdog, the shortcut,
  Escape and the tray all close it, and phase 1's done kills each owner in
  turn. If Electron's level or click-through misbehaves over a full-screen app
  or Mission Control, that is found in phase 1 and is the first thing fixed.
- **Word times on real speech** may be coarser than on `say`'s. The pointing
  word rule is robust to ±300 ms; worse than that and the window widens or a
  mark is placed by its burst's start alone.
- **Screen Recording under the signed app**, like the talk key's Input
  Monitoring, is approved per bundle and was never pressed in a DMG for
  `talkkey`. The same unverified edge, the same check.
- **What is on the screen is the user's and other people's.** A frame of a
  display can hold a chat, a mail, a balance. It goes to the disk at 0600, never
  into a backup, is swept at 30 days, and reaches the model only when Kuru opens
  it; the deny list and the secure-input skip keep the worst out. Question 4 is
  the user's say on the rest.
- **`display.id` and `CGDirectDisplayID`** may not be the same number; mapped
  by bounds if not.
- **Scope.** Shape recognition, a palette, text boxes, a whiteboard. The pen is
  for pointing; one tool covers that.
