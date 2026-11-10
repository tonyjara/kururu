# The look

Kururu has one look, and it is hard-wired. Plus mascots and sounds, which are not
a look: what moves in the sidebar and what a notification sounds like.

It had themes, skins, packs, a styles registry and a skin studio. All of that was
removed on 2026-11-09 so the look could be started again from one set of values
with nothing to keep in step. The history is in git: the parent of the commit
that removed it ("Look: the theming system removed, one look hard-wired") has
every file, and this document as it was.

## Where the values live

In two places, kept in step by hand.

- **The chrome** is plain custom properties in the `:root` block of
  `web/src/styles.css`: Dracula's palette, and the radii, line weights, type
  ramp and icon sizes. Nothing writes a colour or a shape at run time. Two
  properties are written, and they are a person's rather than the design's:
  `--ui-font` and `--ui-scale`, the interface's face and size (below).
- **The terminal** is the constant `TERMINAL` in `shared/theme.ts`, handed to
  ghostty as an object in `web/src/terminals.ts`, because the emulator paints
  into a canvas CSS cannot reach. It is Dracula's published ANSI set with the
  cursor in the chrome's accent.

`TERMINAL.background` is `--bg`, and a change to one is a change to the other.
Two copies kept by hand was an unpayable price per theme and is a fair one for a
single palette.

Code blocks in the reader are a third thing: one syntax theme, Catppuccin Mocha,
in `server/src/markdown.ts`.

## The tokens

A rule asks for a value by name. What `:root` declares:

- **Colours:** `--bg`, `--chrome`, `--chrome-high`, `--chrome-low`, `--strip`,
  `--line`, `--line-soft`, `--line-high`, `--text`, `--text-strong`, `--dim`, `--dimmer`,
  `--accent`, `--on-accent`, the agent states `--idle`, `--working`, `--blocked`,
  `--done` and `--exited`, `--danger`, `--danger-bg`, `--on-danger`, `--scrim`
  and `--shadow`.
- **Six radii and the card's:** `--radius-xs`, `-sm`, `-md`, `-lg`, `-xl`,
  `--radius-round`, and `--radius-card` for a pane.
- **Two line weights:** `--border` and `--border-thick`.
- **Six type steps:** `--fs-xs`, `-sm`, `-base`, `-md`, `-lg`, `-xl`, with
  `--ui-line-height`. Each is its size at 13px running text times
  `--ui-scale`.
- **Three icon sizes:** `--icon-sm`, `-md`, `-lg`, scaled the same way (see
  [Icons](#icons)).
- **Two faces:** `--ui` and `--mono`. `--ui` is `--ui-font` in front of
  `--ui-system`, the system's stack.
- **The strip's measures:** `--tab-row`, `--tab-h`, `--strip-h` and `--top-h`,
  worked out from the type (see [The window as cards](#the-window-as-cards)).
- **Two shadows:** `--elev-dialog` and `--elev-menu`.
- **`--gutter`**, the gap between panes.
- **`--ws-*`**, the fourteen tag colours a board column can wear.
- **`--chart-*`**, what a chart wears.

A rule that names a colour, a radius or a font size should use one of these
rather than a literal, so that the next look is a change to `:root` and not a
search through ten thousand lines. Nothing enforces it any more: the test that
failed on a hex or a px outside `:root` went with the themes it was protecting.

A size is a token too. The stylesheet has two font sizes that are not on the
ramp, both the 16px floor below, and an icon is one of the three sizes. That
is what lets one number, `--ui-scale`, resize the interface.

**`--mono` is not the terminal's face.** A rule that names it is saying "this is
a fragment of terminal", a pid, a path, a key. `--ui` is the chrome's typeface.
The terminal's own face is the user's, in `appearance.json`, and is a third thing
again.

**The chart colours are checked.** A chart's series have to be told apart from
each other, which a palette chosen for chrome does not promise.
`shared/chartcolor.ts` works the series out from the accent and the greys, and
`web/test/usage-palette.test.ts` reads the stylesheet's `:root` and fails if the
`--chart-*` values there have drifted from what it works out.

## The window as cards

Since 2026-11-10 a pane is a card: its strip of tabs and what they show on one
surface (`--bg`), a `--radius-card` corner, a hairline round it (`--line-soft`,
a layer over the pane so it costs a terminal no pixel), and `--gutter` on each
side of it and of the well, which makes 8px between cards and at every edge,
the top included. The focused pane's hairline is the accent, mixed part of the
way out. Zen and a phone's one pane have no gutter, corner or line.

Before that the top of the window was one 38px band in a darker tone, with the
top row of pane strips flush against the window's edge inside it. The owner
asked for the cards beside Herdr's window, and for the sidebar's header and
the list under it to be one surface.

The measures that keep the columns on one line:

- `--tab-row` is what a tab holds, from the type, rounded up to an even pixel.
  `--tab-h` is a tab, 5px above and below that. `--strip-h` is a strip, 5px
  above and below a tab.
- `--top-h` is the head of a column beside the panes: the sidebar's top line,
  a drawer's head, the file tree's. It is the gutter above a card and then a
  strip, with its content centred on the strip's part. So the logo, a
  drawer's buttons and the top row of tabs stand on one line, and the rule
  under a drawer's head is level with the rule under those tabs.

The sidebar's top line holds the logo, the name and, at its right end, the
button that folds the sidebar away. The workspace's name is not there. While
the sidebar is away the toggle and the name lead the top-left pane's strip
(`.strip-lead`, `leadPane` in `Panes.tsx`).

**The window's three buttons** are drawn by the page in the Mac app
(`WindowButtons.tsx`): 12px, flat, the three plain colours, grey while the
window is not the key one, level with the top of the logo. macOS draws its own
large and glassy for an app built against the macOS 26 SDK, which Electron
44 is, and has no switch for the old ones.

The page asks before it draws. `frame.claim()` on the bridge has the main
process put the system's away (`setWindowButtonVisibility`) and answers with
the window's state, or null where the buttons are not the page's (not macOS,
or not the main window). The system's come back when that page goes: at once
for the picker and for a renderer that died, after a moment for any other
navigation or a release. The window may next show a server whose page draws
none, and a window with no way to close it is what this rules out. Full
screen always has the system's, in the title bar that slides down. An app
built before 2026-11-10 has no `frame` on its bridge and keeps the system's
buttons; the layout keeps the same room either way.

## What a person can still change

The terminal's type and cursor, the interface's face and size, and the bottom
bar's chips: preferences, not a look. They are the `Appearance` in
`shared/theme.ts`, `{ terminal: { fontFamily, fontSize, cursorStyle,
cursorBlink }, ui: { fontFamily, fontSize }, bar }`, saved in
`~/.config/kururu/appearance.json` and edited in Settings → Terminal,
Settings → Interface and Settings → Bottom bar.

**The interface's type is two custom properties.** `applyInterface` in
`web/src/fonts.ts` writes `--ui-font` (the chosen face, quoted, in front of
the system's stack) and `--ui-scale` (the chosen size over 13) on the root,
and removes each at its default. Every rule reaches them through `--ui`, the
type ramp and the icon sizes. The size is clamped to 11–18px
(`MIN_UI_FONT_SIZE`, `MAX_UI_FONT_SIZE`). A snapshot from an older server has
no `ui`, so a page reads it through `interfaceOf`. A note's window and the
pill apply it too (`useInterface`). It reaches no pty: a terminal whose box
moved by a strip's few pixels proposes a size as it does after any change of
layout.

**A font change re-measures every terminal, and nothing else here does.**
`applyTerminalAppearance` asks for a re-measure only when the family or the size
moved, because only that changes the cell: a proposal is a pty resize and a
SIGWINCH into every agent. The cursor's shape and blink restyle the emulator
where it stands.

## Why the terminal's palette is a constant

ghostty-vt resolves colour *inside the wasm as it parses*: a cell crosses back as
literal RGB channels, and the palette that decided them went to the terminal when
it was built and has no setter. `renderer.setTheme` reaches the selection and the
cursor and not one cell. So a terminal's palette is settled when it is made, and
the only way to change it for a live window would be to build every wasm terminal
again, which is a reload.

That is why `TERMINAL` is a constant rather than a setting, and it is the thing
to know before proposing a second palette. `setTheme` is still called, for the
one colour that does move: a program that sets its cursor colour (`OSC 12`) gets
the palette handed over with that one field replaced.

## The 16px floor on editable fields

iOS Safari zooms the whole page in whenever an editable element with a computed
font size under 16px takes focus, and does not zoom back out. The stylesheet has
two literals for it, and both must stay literals: 16 is the threshold Safari
checks, not a size the design chose, and the type ramp tops out at `--fs-xl`,
which is 15px.

- Under `(pointer: coarse)`, every input, textarea, select and `contenteditable`
  gets `font-size: 16px !important`: Kuru's composer, card editors, rename and
  search fields. One rule for all of them, because a size per field is a list
  somebody has to remember to extend. It is the only `!important` in the file.
- `.term textarea`, the terminal's focus-catching field, is 16px on every
  pointer. Nothing is drawn at it.

`.term` itself is `contenteditable` and is left out, since its font is the
terminal's cell and on a touch device it never holds the focus. `index.html`'s
viewport adds `maximum-scale=1` behind the floor, which stops the focus zoom on
iOS for any field it misses while Safari still lets a pinch past it.

## Icons

**An icon is a class on a span, never an `<svg>` in the tree.** `Icon.tsx` is a
`<span class="icon icon-<name>">` with no state and no reason to re-render.
`web/src/icons.ts` writes each drawing onto the root once, at import, as
`--icon-<name>-svg`; a `.icon-<name>` line in `styles.css` points `--icon-svg` at
it and a `::before` paints it as a mask over `currentColor`. A mask is what makes
a data URI take the colour of the control it sits in, and every one of these
changes colour on hover.

**An icon is one of three sizes.** `--icon-md` (16px) is a button's, and the
default. `--icon-sm` (14px) is an icon in a line of small text: a caret, a
grip, a mark beside a time, anything in the status bar. `--icon-lg` (19px) is
a thumb's, which is what `--icon-md` becomes on a phone. A rule that wants
another of the three sets `--icon-size` on the control. An icon was 1.2em of
its control's type until 2026-11-10, and the controls are set in five sizes.

The few drawings that are an `<svg>` in the tree, because the set has none (a
microphone, a speaker, the sidebar's toggle), wear `.glyph` or `.glyph-sm`:
the same sizes and the set's 2-unit line. New ones should do the same rather
than carry a width.

It is a component rather than a bare span so that the name is typed: `IconName`
is the keys of the drawings in `web/src/icons.ts`, and a name typed by hand into
a class string is one nothing checks.

The drawings are Lucide's (ISC, `web/src/icons.LICENSE`), vendored as the inner
markup of each 24×24 drawing rather than installed. They were characters, `✕`,
`▸`, `⊞`, and a character's weight and size are the font's to decide: the close
button was a hairline a few pixels across. A dependency would bring fifteen
hundred icons to use a few dozen, and would be one more `bun install`, which on
this project strips the executable bit off node-pty's spawn helper under a
running host.

**To add one:** copy the children of its `<svg>` from lucide-static into
`VECTORS` in `web/src/icons.ts` under a name, and add a `.icon-<name>` line
beside the others in `styles.css`. A solid shape rather than a line drawing also
goes in `FILLED`.

**Every `<Icon>` is `aria-hidden`, without exception and without a prop to turn
it off.** It is always inside a control that already says what it does, so a
screen reader that also read the icon would say the thing twice.

## Tag colours

**A tag colour is `var(--ws-<name>)`.** The names are the workspaces' still, from
when workspaces wore them; board columns are what do now (see
[layout](layout.md#workspace-colours-removed)).

**A column's colour is a name, never a CSS value.** `set-profile-column-color`
takes one of `WORKSPACE_COLORS` and the server refuses everything else, *leaving
the old value alone* rather than clearing it (`colorLane` in `shared/board.ts`):
a rejected write that cleared the column would read as the feature being broken
rather than as a refusal. The check is not decoration. The value ends up in a
style attribute, and kururu is reachable from the tailnet.

## Sounds

What a notification sounds like. The argument is in
[notifications](notifications.md#sounds); what belongs here is short.

There are two sources and `server/src/sounds.ts` reads both from disk on every
call: kururu's own, in `assets/sounds` (the croak), and the machine's, which on
macOS is `~/Library/Sounds`, `/Library/Sounds` and `/System/Library/Sounds`.
Kururu's come first, so a file on the machine called `croak` cannot change what
the default in `notify.json` means. An id is resolved by a lookup in that list
and never pasted into a path.

The choice is in `notify.json`, not `appearance.json`, because a noise is not a
look. An id that resolves to nothing is a 404 from `/api/sound` and silence in
the window, for as long as the mismatch lasts.

## Mascots

The badge beside a working agent (`Status.tsx`). The sheets that ship are in
`assets/spritesheets`; a user's own are in `~/.config/kururu/sheets`; the
selections are `~/.config/kururu/mascot.json`, written by Settings → Mascot. The
routes are in `server/src/http/mascot.ts`.

- **A mascot is a rectangle of cells, and there is a list of them.** It was one
  selection, which was right while picking one was the whole feature. It is not: a
  sheet holds six animations across eight facings, so what people do with the
  picker is find three they like, and a picker with no way to keep anything makes
  you re-find a selection you already made. The config is a list with a chosen
  one, never empty, because an empty list means a working agent with nothing in
  its row. Which one is the *default* is server state; which one Settings has open
  for editing is not, since a second window should not have its picker yanked.
- **Two animations and one trim.** `working` and `idle` are clips: a row, a run
  of cells, a speed. The sheet, the cell size and the trim are not in a clip,
  because they are facts about the *picture*: two clips at two cell sizes is not a
  mascot, it is two mascots. The trim especially is shared and measured across
  every frame of both, or a sitting frog and a jumping one would be scaled to the
  same badge and the sprite would change size the moment its agent stopped. The
  trim is **computed from the pixels, never typed**: where a sprite sits in its
  cell is how a sheet draws a jump, and trimming each frame to its own content
  lands them all on the floor.
- **`idle` is nullable and null is the dot.** `working` wears the working clip and
  **every other state wears the idle one**. `blocked` and `done` kept their dots
  once, and since both last until somebody types (and Claude Code's idle notice
  reports `blocked` a minute after every turn) that read as the mascot failing to
  draw. The notification is what says an agent wants you; the badge only says
  whether it is going.
- **A mascot may draw `blocked` and `done` a clip each, and most do not.** Both
  are nullable and null, the default and what an older file reads as, wears
  idle. Settings does not author them. A `mascot.json` that has them, written by
  hand or by a mascot installed while the registry existed, keeps them through
  edits because every edit goes through `adoptMascot`, and the picker's trim is
  measured across them too. Frozen under reduced motion they keep their first
  frame rather than falling to the dot.
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
- **A workspace wears a mascot by id.** `mascotId`, nullable, where null means
  the set's `default`, so "I have not chosen" and "I chose the thing that is
  currently the default" stay different, and only the first follows when the
  default moves. Nothing validates the id: one naming a deleted mascot already
  draws the default (`mascotFor`), so a check would buy a refusal where the
  fallback is the same answer.
- **An import is checked; a file you placed yourself is not.** A PNG you drop in
  `~/.config/kururu/sheets` is served exactly as you left it, and one that is not a
  PNG fails in the browser and falls back to the dot. Substituting the frog would
  read as the feature being broken rather than the file being wrong. An import is
  a client asking the server to write a file into the user's config directory over
  a socket that is on the tailnet: real PNG by magic bytes, under a megabyte,
  under a name that is a name, and it refuses to overwrite rather than replacing a
  sheet other mascots are cut from.
- **A sheet name is a name, never a path.** `isSheetName` refuses a slash or a
  dot *and* `sheetFile` checks it against the list. Every number in the config is
  clamped instead: a run that goes one cell off the edge is a drag gone too far,
  not an attack. A *name* has no nearest legal value, so it is the one field that
  falls back rather than bends.
- `guide.png` in `assets/spritesheets/` labels the animations and is skipped by
  the picker for exactly that reason.
