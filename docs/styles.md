# Themes, skins, the registry and the studio

Two axes. A **theme** is the palette; a **skin** is the shape, and now also what
the window is *made of*. Plus mascots and sounds, which are neither — what moves
in the sidebar and what a notification sounds like.

## One palette, and a theme names both halves

It was two, kept in step by hand: the chrome in `styles.css`, the emulator's in a
`THEME` constant in `terminals.ts`, because ghostty paints into a canvas CSS
cannot reach. That was a fair price for one hand-sync and an unpayable one per
theme. `shared/theme.ts` holds the chrome tokens, the sixteen ANSI slots and the
eight workspace tags together; `web/src/theme.ts` writes the first onto `<html>`
as custom properties and hands the second to every pooled emulator.

**Never write a hex into `styles.css` or a component.** A rule that names a
colour is a rule that stays one colour while the window changes around it.
`web/test/theme.test.ts` fails on one, and also fails if a token the CSS asks for
is one no theme answers — that seam is held together by a string on both sides
and drifting it is invisible in the default theme.

**Never write a px either.** A rule naming `border-radius: 6px` or
`font-size: 11px` is the same bug in a different dimension, which is what a
hundred and eighty of them were until `shared/skin.ts` existed. The scale is six
radii, two border widths and six type steps; if you need a step that is not
there, add it to `SkinTokens` and let every skin answer for it. The test fails on
a token the CSS asks for that no skin fills in, on one a skin fills that no rule
asks for, and on a `:root` default that has drifted from the default skin — that
last one matters more than its theme equivalent, because a stale shape in `:root`
reflows every pane the moment the snapshot lands, and a reflow costs the agents a
SIGWINCH rather than a wrong colour for a frame.

**A theme that is spelled right can still be unreadable, and that is checked
too.** Both rules above pass happily on a palette whose label is dark grey on
dark grey — the tokens line up, the rules ask for them, and nobody can read the
statusbar. `shared/contrast.ts` holds the arithmetic and, more to the point, a
floor per token: what each one is held to *when it is used as ink*, exhaustively,
so adding a token to `UiTokens` makes somebody answer "and can this be read".
Two floors and they are WCAG AA's — 4.5 for text somebody reads, 3 for a mark
whose shape already carries the meaning. Not one blanket 4.5, because the blanket
version flags what is deliberate: ANSI `black` is 1.8:1 on the ground in every
dark theme and that is what ANSI black *is*, and `dimmer` exists precisely to sit
below `dim`. A check that cries about those gets ignored inside a week, and then
it is worse than nothing because it makes the next person think the palettes were
audited.

**The pairs are extracted from `styles.css`, never listed.** A rule naming both a
`color` and a `background` has written a pair down; there are 51, and they are
the only pairs written down anywhere. The other 167 rules name an ink and inherit
their ground from whatever they sit inside, which needs the cascade and therefore
a live window — so this sweep sees about a third of the chrome and every pair it
sees is exact. A hand-kept list would be one more thing kept in step with the
stylesheet by hand, which is the failure this whole test file exists to catch.

**`CONTRAST_KNOWN` is a record of the shipped state, not an approval of it.**
Nineteen pairs are under their floor today and **Latte owns eleven** — a light
theme built by inverting a dark one is exactly where "text on a bright fill"
stops meaning what it meant, which is why `onAccent` is 2.31:1 on its `blocked`
badge and `accent` is 2.17:1 as text on raised chrome. Each line carries the
ratio it had when it was written, and that number is what makes it a ratchet
rather than a blanket: a pair that slides *further* under fails, so a palette
cannot degrade under cover of its own exemption, and a pair that climbs back over
its floor fails as stale, so a fix forces its line out rather than leaving a note
about a bug that is gone.

**A translucent ground is declined, not guessed.** Two colours and a ratio is the
whole model; `scrim` composites over the entire window and extending the model to
"and whatever is underneath" means modelling the stacking order, which is a live
window's job. A skipped pair comes back *in the list* — a pair that left the
sweep quietly is how a theme ends up looking audited when part of it was never
looked at.

**Changing the theme must never resize a pty.** `applyTerminalAppearance`
re-measures only when the *font* moved. Paying a SIGWINCH to go from Mocha to
Macchiato would make choosing a colour scheme repaint everybody's work. A font
change *does* re-measure, through the same 60ms settle a dragged divider uses.

**Changing the theme reloads the window, and has to.** ghostty-vt resolves
colour *inside the wasm as it parses*: a cell crosses back as literal
`fg_r/fg_g/fg_b` and `getFgColorMode()` is `return -1` unconditionally, because
there is no index left to report. The palette that decided it went to
`ghostty_terminal_new_with_config` and has no setter. So `renderer.setTheme`
reaches the selection and the cursor and *not one cell* — for a year it looked
like a theme change applied, and what applied was the chrome. The only lever is
a new wasm terminal, and the only way to pull it across a window is
`location.reload()`, which `App` does when `applyAppearance` reports the palette
moved. It is affordable for the reason ⌘R is: the client owns nothing, so the
agents and the arrangement both survive it. It costs a backlog refetch per
visible pane and the scroll position, on a deliberate act. `App` stashes the
open Settings tab in `sessionStorage` across it, or browsing themes would close
the picker on every pick.

Two traps if you touch this. The **first application is never a change** — the
module declares Mocha and the first snapshot almost always moves it, so
reloading for that would reload forever; `dressed` is the guard. And the reload
must stay on the *snapshot*, not on the click: the server has already persisted
the appearance by then, which is what makes the window come back agreeing with
itself.

**A skin is the inversion of that rule, and changing one *does* resize a pty.** A
skin moves the line weight and the type ramp, so applying one changes the box
every pane holds. That is correct and intended — it is what picking a chunkier
chrome means. It also needs **no code**: every pooled emulator is already watched
by a `ResizeObserver`, so the resize arrives through the path a dragged divider
uses. Do not add an explicit sweep in `web/src/skin.ts` to "make sure" — a second
path to the same place is the one that rots, and it would double every proposal.
`applySkin` runs *before* `applyTerminalAppearance` by exactly one frame, so the
box measured is the one the window is about to have.

**A theme is complete; a skin is a difference.** The asymmetry looks like an
inconsistency and is not. Skin tokens compose — "kururu, with square corners" is a
real thing to mean, and such a skin should inherit an elevation shadow improved
later. A palette does not compose: a Dracula missing `blocked` draws Catppuccin's
yellow, which is a colour from a different palette chosen against a different
ground, near enough right that nobody would file it. Forward compatibility is
handled at the other end — `adoptThemeManifest` fills a token the manifest
predates from the default theme.

**A theme is picked, not edited, and what is stored is its id.** Same argument
the keymap makes: a saved palette would freeze kururu's tokens at the version you
first opened Settings in. `themeFor` falls back rather than refusing — a name from
a downgrade draws the default, which is the same answer a check would have
bought — and a flavour restyled later restyles everywhere.

**`themeFor` and `skinFor` take the installed set; `adoptAppearance` no longer
resolves an id.** It used to write back whatever this version could draw, which
was right while every theme was in `shared/theme.ts` and is exactly wrong once one
can be uninstalled: removing a theme would rewrite the choice to the default and
reinstalling it would not bring the choice back. The file keeps the id,
resolution happens at the moment of drawing, and the fallback lasts a frame
rather than forever. It follows that removing a style touches nothing in
`appearance.json`.

**A workspace tag is `var(--ws-<name>)`, not a lookup.** `colors.ts` used to find
the theme again from `data-theme`. That broke the day a theme could be installed:
the id then names something `shared/theme.ts` has never heard of, `themeFor`
falls back, and the eight tags come out in plausible colours from the wrong
palette. `applyTheme` writes them onto the root instead.

**A workspace colour is a name, never a CSS value.** `set-workspace-color` takes
one of `WORKSPACE_COLORS` and the server refuses everything else, *leaving the
old value alone* rather than clearing it — a rejected write that untagged the
workspace would read as the feature being broken rather than as a refusal. The
check is not decoration: the value ends up in a style attribute, and kururu is
reachable from the tailnet.

## Parts: a skin may paint

The first `shared/skin.ts` refused pictures because a nine-slice carries its own
colours and a pane framed with one stops following the theme. True, and it
produced skins nobody wanted: a radius and a scanline over the terminals is three
flavours of the same chrome, and the scanline's most visible effect was making
the work harder to read.

So a skin paints **parts** — thirteen regions named for what they are (`pane`,
`statusbar`, `row-on`), each taking one PNG as a `nine`-slice, a `tile` or a
`stretch` at an integer scale — and a skin that paints may override the chrome's
`UiTokens` through `colors`, written after the theme's on every snapshot. What it
may never touch is the terminal's palette: **the terminal is the work, the skin
is the frame**, and a pack is how the two ship together.

`partVars` compiles a part to three custom properties (`--p-<part>-frame`, a
complete `border-image`; `-w`, the `border-width` that makes it take room; `-bg`,
one background layer) and the *Parts* block at the foot of `styles.css` reads
them. A state part (`pane-on`, `tab-on`) left unpainted compiles to
`var(--p-pane-…)` rather than `none`, and `web/test/theme.test.ts` holds the
`:root` block to exactly what `partVars` says for a skin that painted nothing — a
`none` where it should say `var(…)` is a focused pane losing its bezel for the
frame before the snapshot lands.

**A frame is the element's own border, so that it takes room — except on the two
sidebar rows.** A bezel with `border-width` set to the slice moves the tab strip
and the terminal inward and the grid is proposed again: a SIGWINCH per pane when
a picture skin goes on, which is the same cost a heavier border always had. A
picture laid *over* the edge would keep the layout and cover the first row of
text. The selected workspace and agent rows are the exception and draw theirs on
`::after` with `z-index: -1` inside `isolation: isolate` — a row's width is the
sidebar's, so a frame that took room would make the selected row a different
height from its neighbours, and without the negative z-index the nine-slice's
filled middle paints over the row's name. The tab strip's block of pane controls
wears the strip's picture through `border-image-width: 0`, which makes `fill`
paint the middle over the whole box, and its gradient fade is hidden by
`@container not style(--p-tabstrip-frame: none)` — the one place the stylesheet
asks whether a custom property is `none`.

## Icons and fonts

**An icon is a custom property, never a component that reads the skin.**
`Icon.tsx` is a `<span>` with a class on it — no state, no context, no reason to
re-render. `web/src/skin.ts` writes the icon onto the root and a `::before` in
`styles.css` draws it, so changing skin moves a property and every icon in the
window follows in the same frame with React not involved. It is a component
rather than a bare span so that `ICON_NAMES` is the same set in both halves: a
name typed into a class string is a name nothing checks, while a typed `name`
makes a skin restyling an icon nobody draws a type error.

Three layers, and a glyph is the lesser one:

- **Kururu's own vectors** (`web/src/icons.ts`) are the default. They were
  characters — `✕`, `▸`, `⊞` — and a character's weight and size are the font's
  to decide: the close button was a hairline a few pixels across and the split
  buttons were whatever the Nerd Font stack happened to hold. Fine under a mouse,
  and not a thing a thumb can find. They are Lucide's (ISC, `web/src/icons.LICENSE`),
  vendored as the inner markup of each 24×24 drawing rather than installed — a
  dependency would bring fifteen hundred icons to use fourteen, and would be one
  more `bun install`, which on this project strips the executable bit off
  node-pty's spawn helper under a running host.
- **A skin's `iconSheet`** is every icon at once: a strip of `ICON_NAMES.length`
  square cells in that order. `mask` draws each cell in the button's own text
  colour so it follows hover and the theme; `image` draws the pixels as they are,
  for a skin whose icons have colours of their own.
- **A skin's `glyphs`** are the icons it drew as text on purpose, which win over
  the strip because a glyph is a per-icon decision and the strip is a blanket one.
  Recorded rather than worked out by comparing against `BASE_ICONS`: a pixel skin
  writing `+` for `add` — the base's own glyph — has still asked for a `+` in its
  own face beside its other ASCII, and a comparison would hand it one smooth
  vector among them.

They reach the page as `mask-image` on a `::before`, not as `<svg>` in the TSX. A
mask is what makes a data URI take `currentColor` — an SVG drawn as an image
cannot see the colour of the element it sits in, and every one of these changes
colour on hover. To add one, copy the children of its `<svg>` from lucide-static
and give it a name in `shared/skin.ts` first.

**`null` in a skin's `icons` means "keep the base's", and is not the same as
leaving the name out.** Leaving it out is silence; writing null is a skin that
has *considered* this icon and decided the default was right — a pixel chrome
that finds no ASCII character reading as "restart" writes null there, and the
null is the sentence. After the merge every name has a glyph, so nothing
downstream carries a fallback.

**Every `<Icon>` is `aria-hidden`, without exception and without a prop to turn it
off.** It is always inside a control that already says what it does, so a screen
reader that also read the glyph would say it twice — and say it as whatever
character the current skin happens to use. "Close tab, X" is worse than "Close
tab", and under a skin that draws it as `x` it is worse again.

A glyph is quoted on the way into `content`, so `cssString` escapes it. That
escape is theoretical while every glyph is ours and stops being theoretical the
day skins arrive from the registry.

**`--mono` is nobody's and stays nobody's.** A skin sets `--ui`, because the
chrome's typeface is a question of shape. It does not set `--mono`: a rule that
names it is saying "this is a fragment of terminal" — a pid, a path, a key — and
it should go on looking like one whatever the chrome is set in. The terminal's own
face is the user's, in `appearance.json`, and is a third thing again.

**A font a skin names is installed and served locally, never linked.** A skin
ships its `.woff2` with a licence beside it; installing copies both into
`~/.config/kururu/styles`, and `web/src/skin.ts` writes the `@font-face` at
runtime pointing at `/api/styles/asset`. A manifest that names a URL is refused by
the registry's CI and refused again at install, because a window that fetches a
face from a third party tells that third party when somebody is working. It is
`font-display: block` and not `swap` for a kururu-specific reason: the chrome's
face decides the size of every label, so swapping it in late would reflow every
pane and hand every pty a SIGWINCH a second after the window settled.

## The registry

`../kururu-styles` (remote `tonyjara/kururu-styles`) is kururu's styles registry —
themes, skins, mascots, sounds and packs as data. **It is ours and editing it is
in scope**; its `AGENTS.md` is the brief and `node tools/validate.mjs` is the
whole review. Two rules cross the boundary:

- `schema/tokens.json` there is generated from `shared/theme.ts`,
  `shared/skin.ts` and `shared/styles.ts` here by `bun run schema`. Adding a
  token, a part or an audio format is a change to **kururu first** and a rerun of
  that second.
- `index.json` is generated by its CI on merge. Never hand-edit it and never
  regenerate it in a branch; a scratch copy under `/tmp` is how a new entry is
  tested.

Its picture skins and its four people are drawn by `tools/art.mjs` there and its
five sounds are synthesised by `tools/sfx.mjs`, so change the script,
not the PNGs.

**The server fetches the registry; the browser never does.** A phone on the
tailnet has no business reaching GitHub, the server is the only thing that can
write to `~/.config/kururu`, and it sidesteps CORS. That extends to the one
picture a browser would otherwise want directly: a mascot nobody has installed is
previewed through `/api/styles/preview`, which proxies the sheet and checks it
against the index's digest, so a preview cannot show one thing and an install put
another on disk.

**An installed style is a copy with its version pinned, never a link.** Three
reasons and each is sufficient: a style that changed under you mid-session would
be a window redrawing itself while you read it; kururu has to come up with no
network; and *check for updates* means nothing without a pinned version to compare
against. So an update is always something somebody pressed. The pin is a **semver
and a digest** doing different jobs — the version is what the row computes "newer"
from, because it is a sentence for a person; the digest says the bytes that landed
are the bytes the registry has. The registry's CI refuses a changed entry under an
unchanged version, which is the load-bearing half: without it an edit ships and
every install says it is current, forever, with no symptom.

`KURURU_STYLES_URL` points the registry somewhere else. It is not a debugging
hook so much as how a style is tested before it is opened as a pull request:
serve the sibling checkout (`python3 -m http.server 8899 --bind 127.0.0.1`) and
the Styles tab is that working copy. Do it in an isolated instance — see
[testing](testing.md).

`measureImage` in `server/src/styles.ts` reads a PNG's size off its IHDR, because
a tile is drawn at its size times its scale and only this side has the file.

## The studio

**A skin of yours is an installed skin, and that is the whole design.**
`server/src/studio.ts` writes `~/.config/kururu/styles/skins/<id>/` in the
registry's own format with `local: true` on its record, so `readLibrary` reads
it, the asset endpoint serves its pictures, `remove` deletes it and the phone
wears it — with nothing downstream telling yours from a stranger's. Publishing is
copying the folder.

Two things do know the difference: `install` refuses to fetch a registry entry
over a local one of the same id, and `annotate` does not offer to update one.

A skin that has not moved anything yet is kept (`adoptSkinManifest`'s `lenient`)
because the studio has to be able to wear an empty skin to show you what touching
something does; a registry entry that moves nothing is still refused. Every
studio route ends in `readLibrary()` and a snapshot, and every save *wears* the
skin, on the Styles tab's reasoning that picking is installing. Uploads are the
mascot import's three checks — a name, a cap, the magic bytes — and overwrite,
because a file in a skin of yours is referenced by that skin alone; the answer
carries a `stamp` the page appends to the URL, since the asset endpoint caches for
a year on the assumption a file cannot change under its name.

`SettingsStudio.tsx` holds the manifest it is editing and nothing about how the
window looks; saves are debounced 150ms.

## Sounds

A **`sound` entry is a style like a theme is**, so a pack can name the noise its
window makes along with its palette and its sprite. It is the thinnest kind in
the format — an id, a name and one file — because a sound is not something the
client *draws*: it is bytes fetched by id, and the only thing worth adopting is
which file the id means.

**A sound lands in `notify.json`, not `appearance.json`**, which is the one
placement worth defending. A noise is not a look — that is the same sentence
`server/src/notify.ts` already makes about why that file exists at all — so `put`
has a third destination rather than two. Wearing a pack writes `sound` and **does
not touch `enabled` or `events`**: those are a decision about being interrupted,
and a style choice that quietly started interrupting somebody would be the
feature exceeding its remit.

**`SOUND_FORMATS` is narrower than what `sounds.ts` will play, and deliberately
so.** That module transcodes the machine's own alert sounds on the way out with
`afconvert`, which is how fourteen AIFFs become a usable dropdown — and it cannot
do that for a registry entry, because a Linux box has no `afconvert`. An entry in
a format that needed one would be silence on half the machines that installed it
while working perfectly on the Mac that contributed it, with nothing anywhere
saying so. So it is wav, mp3 and m4a; Ogg and Opus are out because
`decodeAudioData` on iOS is not reliable about them and the phone is the client
this is most for.

**An installed sound sits between kururu's own and the machine's in the
catalogue, and that order is an argument.** It is *after* kururu's because these
ids come from the registry and `croak` is what `DEFAULT_NOTIFY` names — an entry
merged under that id must not change what every existing `notify.json` means. It
is *before* the machine's because installing one is a deliberate act and
`/System/Library/Sounds` is merely what the OS happens to contain. It is also the
one source whose path is not a `readdir`: `installedSounds` resolves it against
`installed.json`, so the two-sided name check every other style asset gets applies
to this one too.

**The card in the Styles tab is a button that plays it**, proxied through
`/api/styles/preview` like a mascot's sheet. Same argument
[notifications](notifications.md#sounds) already makes about the picker — *a list
of words is not a list of noises* — with the one difference that the bytes have
not been downloaded yet, which is what the proxy is for.

**Removing a sound leaves the choice in `notify.json`**, exactly as removing a
theme leaves `themeId`. The id then resolves to nothing, `/api/sound` answers
404, and `load()` in `web/src/notify.ts` turns that into silence — which is the
fallback lasting as long as the mismatch does, and reinstalling puts the noise
back.

## Packs

A pack is **a handful of ids and a font name**, and nothing else. Installing one
installs what it names; removing one deliberately leaves its parts alone, because
a pack is a *reference* and taking away the recommendation is not taking away the
theme.

**Installing and wearing stopped being the same gesture, and that is the whole of
what `wear` is for.** They were the same for as long as the only way to arrive at
a style was to press its row in the Styles tab — *picking is installing*. A pack
broke it: it is five decisions somebody made in one click, and there was no way
back to them. Change the skin, try another mascot, and *put the pack back on* meant
removing it and downloading it again over a network you may not have. So
`POST /api/styles/wear?kind=<kind>&id=<id>` takes an id and nothing else, touches
no network, and reads the copy already on disk — `installedPack` resolves the
manifest against `installed.json` the way every other style asset is resolved.
`install?activate=1` now calls it too, so what it means to wear a pack is written
down once instead of once per caller.

**One `Look`, written once.** A pack is up to five settings across three files —
`appearance.json`, `mascots.json` and `notify.json` — and doing them a saver at a
time would push three snapshots for one click and repaint the window three times
on the way to the look somebody asked for. `put` folds each installed part into a
`Look`; `saveLook` writes whichever of the three actually moved and pushes once.

**A part the machine has not got is skipped, not refused.** That is the same rule
`installOne` applies to a part that would not download, arriving from the other
end: most of a pack is most of the look, and one missing sprite is not worth
losing the palette over. A mascot is the one that can decline silently — it is
worn by *its row in the user's list* rather than by its registry id, so a record
from before `mascotId` was written down, or one whose row has since been deleted
in Settings, has nothing to point at, and leaving the current mascot up beats a
badge that goes blank.

**A pack names a font and kururu installs none.** A typeface is a licence and a
hundred kilobytes a weight, and the machine it has to exist on is the one drawing
the glyphs — which, for somebody watching agents on a phone, is not the machine
the agents are on. So `font` is a single family name written into the same field
the box in Settings writes, prepended to kururu's stack exactly as a name typed
there is. A machine without that face keeps the font it had, which is not a silent
failure but the behaviour `web/src/fonts.ts` already exists because of. A pack
with no `font` leaves the setting alone rather than clearing it: the empty string
means *kururu's own stack*, and writing it would make wearing a pack quietly undo
a choice the pack declined to have an opinion about. The registry refuses a
`font` containing a comma, because kururu quotes the name whole and a list would
match nothing.

**Settings → Appearance lists the installed packs as buttons, not as a
radiogroup**, and the distinction is real: nothing records which pack you are in,
and the moment you change the skin you are no longer quite in any of them — which
is the entire reason the control exists. The Styles tab says the same thing on an
installed row, where the word *Installed* used to be a state and is now an offer.

## Mascots

The badge beside a working agent (`Status.tsx`).

- **A mascot is a rectangle of cells, and there is a list of them.** It was one
  selection, which was right while picking one was the whole feature. It is not: a
  sheet holds six animations across eight facings, so what people do with the
  picker is find three they like — and a picker with no way to keep anything makes
  you re-find a selection you already made. The config is a list with a chosen
  one, never empty, because an empty list means a working agent with nothing in
  its row. Which one is the *default* is server state; which one Settings has open
  for editing is not — a second window should not have its picker yanked. The one
  migration is a file from the version that held a single config: it has no
  `list`, and it becomes one entry rather than being thrown away.
- **Two animations and one trim.** `working` and `idle` are clips — a row, a run
  of cells, a speed. The sheet, the cell size and the trim are not in a clip,
  because they are facts about the *picture*: two clips at two cell sizes is not a
  mascot, it is two mascots. The trim especially is shared and measured across
  every frame of both, or a sitting frog and a jumping one would be scaled to the
  same badge and the sprite would change size the moment its agent stopped. The
  trim is **computed from the pixels, never typed**: where a sprite sits in its
  cell is how a sheet draws a jump, and trimming each frame to its own content
  lands them all on the floor.
- **`idle` is nullable and null is the dot.** `working` wears the working clip and
  **every other state wears the idle one** — `blocked` and `done` kept their dots
  once, and since both last until somebody types (and Claude Code's idle notice
  reports `blocked` a minute after every turn) that read as the mascot failing to
  draw. The notification is what says an agent wants you; the badge only says
  whether it is going.
- **An idle animation that cannot animate becomes the dot again.** Under
  `motion: never` a frozen idle sprite and a frozen working one are the same
  picture, so idle would cost the one distinction the badge exists to draw. This
  is a choice of *element*, which is why it is in `Status.tsx` and not a media
  query.
- **The mascot animates by default, whatever the system says.** Only
  `motion: "system"` opts into `prefers-reduced-motion`. This was a bug first: a
  blanket rule froze the badge on frame one for anybody with Reduce Motion on,
  which is a status indicator that has stopped indicating. A 16px sprite is in the
  class of a spinner, not the sliding parallax that preference exists to stop, so
  it is offered in Settings instead of obeyed silently.
- **A workspace wears a mascot the way it wears a colour.** `mascotId`, nullable,
  where null means the set's `default` — so "I have not chosen" and "I chose the
  thing that is currently the default" stay different, and only the first follows
  when the default moves. Nothing validates the id: one naming a deleted mascot
  already draws the default, so a check would buy a refusal where the fallback is
  the same answer.
- **An import is checked; a file you placed yourself is not.** A PNG you drop in
  `~/.config/kururu/sheets` is served exactly as you left it, and one that is not a
  PNG fails in the browser and falls back to the dot — substituting the frog would
  read as the feature being broken rather than the file being wrong. An import is
  a client asking the server to write a file into the user's config directory over
  a socket that is on the tailnet: real PNG by magic bytes, under the size cap,
  under a name that is a name, and it refuses to overwrite rather than replacing a
  sheet other mascots are cut from.
- **A sheet name is a name, never a path.** `isSheetName` refuses a slash or a
  dot *and* `sheetFile` checks it against the list. Every number in the config is
  clamped instead: a run that goes one cell off the edge is a drag gone too far,
  not an attack. A *name* has no nearest legal value, so it is the one field that
  falls back rather than bends.
- `guide.png` in `assets/spritesheets/` labels the animations and is skipped by
  the picker for exactly that reason.
