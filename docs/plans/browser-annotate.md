# A browser in kururu, and marks on a page for the agents

A plan, first written 2026-11-06 from a read of the tree at `0ce67bd` and of
the research in [browser-annotate-research.md](browser-annotate-research.md),
then **revised the same day around the user's answers** to its open questions
(see [what the user decided](#what-the-user-decided)). **Nothing was built.**
It is written so that an agent can take one phase, read the files it names,
and know what "done" is.

**The ask, in the user's words:** a browser inside kururu, as a pane or a tab
beside the agents, with "tools for me to select things on the screen and add
comments about it so that you understand better what I'm talking about, I know
that things like orca already do this, so do a little research and figure out
the best way to implement this."

**Scope.** It is **the desktop app only**. The phone never gets a browser or
the tools, and neither does a web-client iPad. **The iPad is the Mac's own
screen, through Sidecar:** a browser tab can be detached into a window of its
own and dragged there, where the Pencil is a pointer that marks. The web
client only shows what comes out of the browser: a message, or a card quote
that carries marks. A browser extension for the user's own Chrome was weighed
against the built-in browser ([the comparison](#the-built-in-browser-or-an-extension));
it is a later, optional complement, not the first thing.

This plan is two items of CLAUDE.md's "Where we're going": **the preview as a
pane type** (1) and **the element picker** (4). PLAN.md's version of the
picker, injected by the preview proxy, is overtaken. On the desktop the page
is a real browser view and needs no proxy, and the phone is out. The line in
`web/src/preview.ts` that says "the picker is worth a hop" should go when this
lands.

## Verdict

**The browser:**

- **The browser is a `WebContentsView` that the Electron main process owns, one
  per browser tab, pooled by tab id and moved between panes, never rebuilt.**
  That is the terminals' rule ([terminals](../terminals.md#the-pool)) applied to
  pages.
- **It is not a `<webview>`.** Moving one in the DOM creates a new guest. Orca
  uses `<webview>`, which is why its in-renderer overlays are easy and why its
  pages reload when moved; kururu takes the other side of that trade.
- **It is not an iframe.** It would be cross-site to a window at
  `127.0.0.1:7717`, so a dev app's logins would break inside it, and it has no
  CDP of its own.
- **Its session is its own, `persist:kururu-browser`, and never
  `defaultSession`.** `desktop/main.js` strips every CSP from `defaultSession`.
- **Any website.** `http:` and `https:`, nothing else.

**Marking is done on the live page, the way Orca and Cursor do it. Pick live,
write over a still:**

- **Mark** (button or ⌘⇧M) injects a small marking script into the page **in an
  isolated world**. It draws the hover box, the numbered pins, the region and
  the pen strokes in a **closed shadow root promoted to the browser's top
  layer**, so nothing in the page sits over them. Clicks are taken before the
  page sees them; the pointer's movement, hover states and scrolling are not,
  so a hover menu stays open while you pick inside it and a long page just
  scrolls.
- **The comment is kururu's own popover, not something in the page.** When a
  pick opens it, the view is swapped for a still of itself for as long as the
  popover is open, the same swap every kururu overlay already needs (VS Code's
  `overlayManager`). The page holds still while you write, and what you type
  never passes through the page's process. The field is the composer's
  `ChipField`, with the quote popover's dictation.
- **Several marks per message, numbered.** Each mark is a numbered pin on the
  page and a row in the tray under the tab, up to 20, refused out loud past
  that.
- **The z-order alternatives were weighed and set aside:** a transparent view
  stacked on the page works but doubles the renderers, has to forward hover and
  scroll by hand, and gives nothing an extension could reuse. The DevTools
  Overlay domain draws outside the page, but its inspect mode swallows hover
  and cannot draw pins. See [the z-order](#the-z-order-when-marking).
- **The freeze stays, small:** a key that holds the hover state under the
  pointer (`CSS.forcePseudoState`), for a CSS menu that would close when the
  pointer leaves. The full screenshot-and-snapshot freeze of the first draft
  is dropped.

**What a mark carries.** The best of what the research found
([§2](browser-annotate-research.md#2-what-matters-to-an-agent-in-order)):

- the comment
- **the source `file:line` and the component chain**, checked against the
  checkout
- a selector to grep for, and the visible text
- role and accessible name
- the box
- a crop taken at the moment of the mark, plus the viewport at Send with the
  numbered pins on it
- the console errors since the page loaded

Styles and HTML go in the bundle's file, not the message.

**Delivery is kururu's existing grammar, into Kuru's box, unsent:**

- **The message.** Each mark becomes one line in the box,
  `[mark 2 button "Pay now" (src/Checkout.tsx:42)] make it the accent`, as each
  quote already is.
- **The folder.** Everything else goes in a folder beside `drops/`, and the
  first line hands over its path.
- **Where it goes.** Kuru's box, unsent, is the default (decided). Sending to
  an agent (typed as `send_agent` types) and putting it on a card are the
  other two ways.
- **On other clients.** The phone and the web client draw these lines as
  chips, which is all they ever do with this feature.

**The iPad is Sidecar and a detached window.** A browser tab can leave its
pane for a `BrowserWindow` of its own, the same pooled view moved from one
window to another, and come back the same way. Dragged onto a Sidecar iPad,
the Pencil is the pointer: a tap picks, a drag boxes a region or draws. It
replaces the first draft's web-client iPad phase, at less cost.

**Agents look at the tab and act in it, with the user's logins** (decided).
A handful of kururu MCP tools at `/mcp/browser`: tabs, look, console, the
marks' reply-and-resolve loop, and act. There is no switch. What stays is a
badge naming the agent that is driving, a Stop, and a log in the tab. A raw
CDP relay for Playwright MCP or chrome-devtools-mcp is an optional last phase.

**A Chrome extension is a complement, later, and only for marking.** The
marking script and `POST /api/marks` are written so a Chrome extension could
reuse them, paired to kururu by a single-use code. It is not built first
because the ask was a browser beside the agents, and because agents driving
the user's real Chrome means the debugger banner and every login the user
has. Safari is not planned.

**Before any of it: the browser's own pages must not be able to talk to
kururu.** Today they can (see [Security](#security)). Phase 0 closes that
for the browser's session, and only for it (decided).

## What the user decided

Answers given 2026-11-06 to the first draft's questions:

| question | answer |
|---|---|
| freeze-then-mark or live | **live**, as Orca and Cursor; a freeze only as a cheap extra for hover |
| where Send goes | **Kuru's box, unsent** |
| agents in the user's tab | **yes, look and click, with the user's logins**; no per-workspace switch |
| which sites | **any website** |
| tighten `originOk` for every browser | **no**; only the block on the built-in browser's own session |
| the iPad | **Sidecar, not a web-client iPad**: detach the browser into its own window; weigh a browser extension honestly |

## What is there today

| piece | where | what it gives this |
|---|---|---|
| tabs of any kind in a pane | `shared/layout.ts`: `BOARD_TAB`, `docTab` (`doc:` + JSON) | a browser tab is a third id kind: drag, split, merge for free |
| the trap in that | `terminalsOf`, `activeTerminal` treat *every* id that is not the board or a `doc:` as a terminal | a `web:` id must be added to both, or it is killed, watched and typed into |
| pane state beside the tabs | `ReaderState` on `PaneState` | the shape a tab's URL and title can take, persisted as structure |
| dev servers found | `server/src/devservers.ts`, a card's own in `carddev.ts`, `serverIn` in `web/src/preview.ts` | "Open in browser" on a dev-server row and on a card |
| the Electron shell | `desktop/main.js` (`BrowserWindow`, `contextIsolation`, `setWindowOpenHandler`, `context-menu`) | where the pool, the session and the debugger live |
| windows of their own | `desktop/notes.js`: a `BrowserWindow` per note loading the web build in a one-thing mode (`?note=<card>`), its place kept in `desktop.json`, put back on a screen that exists (`fitOnScreen`) | the shape a detached browser window takes |
| the window's bridge | `desktop/preload.js` | bounds, still, capture and detach verbs between page and main |
| packaging | `desktop/electron-builder.yml` lists `desktop/*.js` **by name** | a new `browser.js` left out crashes the DMG |
| quotes and references | `quoteReference`, `cardReference` in `shared/kuru.ts`; `fileReference` in `web/src/filequote.ts` | the grammar a mark follows |
| chips | `shared/chips.ts` (`ChipKind`), `ChipField`, `SentWords` | a `mark` chip in the box, in the drawer, on the phone |
| files handed over | `shared/drops.ts`, `server/src/drops.ts`, `POST /api/drop` | the folder-of-the-server pattern, 0700/0600, never backed up |
| typing into an agent | `send_agent`, `typingPieces` in `shared/harness.ts` | how a mark message reaches an agent other than Kuru |
| MCP for agents | `server/src/mcp.ts` (five methods, no SDK), `/mcp/web` and its launch flags | the shape a `/mcp/browser` takes |
| the gate | `originOk`, `decide` in `server/src/access.ts` | what the Security section is about |

## The design

### The browser tab

- **The tab id.** `web:<id>`, a random id rather than the URL, because the
  URL changes with every click. `isWebTab` and `parseWebTab` go beside
  `isDocTab`. `terminalsOf` and `activeTerminal` learn to skip it; that is the
  one line everywhere that matters.
- **Pane state.** The pane keeps `web?: Record<tabId, { url, title }>`, like
  `reader`. The server holds it and persists it.
- **Restoring.** `persist.ts` restores structure, so a restored tab knows its
  URL and loads nothing until it is shown. Loading a page is not a process,
  but loading four dev URLs at start is four GETs nobody asked for.
- **The pool in main.** `desktop/browser.js` keeps
  `Map<tabId, WebContentsView>`. The page sends the tab's rect, in CSS
  pixels, from an empty stub `div` (ResizeObserver plus rAF) over the bridge.
  Main does the `setBounds`, snapped to whole pixels as VS Code does.
  - Hidden tabs get `setVisible(false)`.
  - A tab dragged to another pane moves its rect and nothing else.
  - A tab detached into its own window is removed from one window's
    `contentView` and added to another's: the same view, no reload (see
    [detached](#a-window-of-its-own-and-the-ipad)).
  - Closing the tab is the only thing that destroys the view.
- **The other clients.** The phone and the web client get a tab they cannot
  draw. They show the title, the URL and "Open on the Mac", nothing else.
  - The layout is the server's, so they see the tab.
  - The page is the Mac window's, so they don't see the page.
  - Two Electron windows on one layout share the one view in main. The
    focused window shows it, and the other gets the placeholder.

**kururu's UI over the page.** This is VS Code's answer, copied
([research §4](browser-annotate-research.md#4-embedding-a-page-in-electron)).
A small `overlays.ts` in `web/` watches kururu's own overlays:

- `Menu`
- the Kuru, Needs and Settings drawers
- dialogs
- the quote popover, and **the mark's comment popover**
- a pane being dragged

When one really paints over a browser tab (rect intersection, then
`elementFromPoint` at the centre), the page asks main for a still of the view
(`capturePage`, JPEG). It shows that as the stub's background and hides the
view one frame later. The overlay closing shows it again. The still is
refreshed every 1 s while visible, **except while a mark's comment is open**,
when the page is meant to hold still.

**Keys.** A click on the page sends focus into the view. Main's
`before-input-event` takes kururu's prefix (`C-a`) and the ⌘ shortcuts kururu
owns, forwards them to the window and gives focus back. In mark mode it also
takes Esc, ↑ and ↓, so the page never sees them. Everything else is the
page's.

**The tab's chrome** is kururu's own DOM, above the stub:

- back, forward, reload, the address field, zoom
- **Mark**, and the tray's count
- **Detach** (and, in a detached window, **Back to the panes**)
- DevTools (`openDevTools({mode:'detach'})`)
- "Open in Safari"
- the agent badge and Stop, while an agent is driving

**Where it opens from:**

- the dev-server rows
- a card's dev server
- a link in an agent's reply ("open in kururu"), and ⌘-click on a URL in a
  terminal
- the + menu's "Browser"

New tabs follow the workspace's existing placement rules: the + menu's go
where asked, and kururu's own go to the agents' pane.

### Marking

**Entering.** **Mark** (button, or ⌘⇧M taken in `before-input-event`) puts
the tab in mark mode:

1. Main creates an isolated world in the page's main frame
   (`Page.createIsolatedWorld`, world name `kururu-marks`) and evaluates the
   marking script in it. While mark mode lasts, the same script is registered
   with `Page.addScriptToEvaluateOnNewDocument({worldName})`, so a navigation
   or a reload keeps marking on.
2. The script talks to main only through `Runtime.addBinding` scoped to that
   world (`executionContextName`). The page's own scripts cannot call it. No
   preload is involved, and nothing kururu holds is reachable from the page.
3. Leaving mark mode (Esc, the button, or Send) removes the click capture and
   the hover box. **The pins stay**, passive (`pointer-events: none`), for as
   long as the tray has marks, so you can browse and come back.

**The script is written once for two hosts.** It is plain DOM code with no
Electron in it. In kururu it runs in an isolated world and calls a binding; in
an extension it would run as a content script and call `runtime.sendMessage`.
The facts it reads (below) are the ones a content script can read too. That
is what keeps [the extension](#the-built-in-browser-or-an-extension) a
packaging job rather than a second implementation.

#### The z-order, when marking

A `WebContentsView` is drawn above all of the window's DOM, so kururu cannot
draw on the page from the window. Three ways round that, and the one taken:

| way | what it is | why taken or not |
|---|---|---|
| **in the page, in an isolated world** (taken) | a host element on `document.documentElement` with a **closed** shadow root, shown with `popover="manual"` + `showPopover()` so it is in the top layer, above every `z-index` the page has | what Orca, Cursor, React Grab and Agentation do; hover and scroll stay the page's own; the same code serves an extension |
| a transparent view stacked on the page | a second `WebContentsView` with `setBackgroundColor('#00000000')`, added after the page's view so it is above it, running kururu's React | works, and the page sees nothing; but it is a second renderer, it takes every event so hover and wheel must be forwarded through CDP `Input.dispatchMouseEvent`, pins must poll the page's box model to follow scrolling, the stacking of sibling views is what changed between Electron 30 and 31, and none of it carries to an extension. **The fallback** if in-page drawing proves hostile |
| the DevTools Overlay domain | `Overlay.setInspectMode` / `highlightNode`: drawn by Chromium outside the DOM | invisible to the page, but inspect mode swallows the pointer, so hover menus close; one highlight at a time; no pins, no pen. Not portable |

**Details of the in-page layer:**

- **Placement.** On `document.documentElement`, not `body`, so React's
  hydration of `body` never meets a stranger. Re-attached if removed
  (a `MutationObserver` on the root).
- **The top layer.** A page that opens its own modal `<dialog>` or popover
  after ours goes above it; the script calls `showPopover()` again when the
  page's top layer changes (`toggle` events, and a check on each pick).
- **Styles.** A constructed stylesheet (`adoptedStyleSheets`) inside the
  shadow root, so the page's CSS does not reach in and a page CSP's
  `style-src` does not block it. The isolated world's script is not subject to
  the page's `script-src`.
- **What the page can see.** That a `<kururu-marks>` element exists, and the
  numbers on the pins. **Never the comments**: they live only in kururu's
  popover and tray. A page can remove the element; the pins then come back on
  the next mutation, and the marks themselves are kept in main regardless.

**What the page cannot see.** In mark mode, capture-phase listeners on
`window` for `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`,
`dblclick` and `contextmenu` call `preventDefault` and
`stopImmediatePropagation`. A capture listener on `window` runs before any
listener on the page's elements, React's root included, so a pick never
presses the button it marks. The one exception is a capture listener the page
itself put on `window` before ours, which runs first; that is rare, and the
button-count test in phase 1's done is there to catch it. `pointermove`, `mouseover` and `wheel` are left
alone on purpose: **that is what keeps hover states and scrolling live**,
the reason live marking was chosen.

#### The tools

- **Element (the default).** Hover shows the smallest element under the
  pointer (`elementFromPoint`, then `composedPath()` into open shadow roots);
  ↑/↓ walk to the parent or child, as in Cursor; a click pins it. Shift-click
  adds to the same mark (one comment, several elements).
- **Region.** Drag a box. It keeps the elements it fully contains, up to a
  few, as context.
- **Pen.** Freehand, an arrow or an ellipse, drawn on a canvas in the shadow
  root in page coordinates, so the stroke scrolls with the page. The strokes'
  bounding box resolves to elements the same way a region does. Pressure is
  used when `pointerType === "pen"`.
- **Text.** Select text with mark mode off, then press **Mark selection**
  (⌘⇧M with a selection does it): the selection is read in the isolated world
  and becomes a text mark.
- **Hold hover** (⌘⇧H). `CSS.forcePseudoState(['hover','focus-within'])` on
  the element under the pointer and its ancestors, through the debugger, until
  pressed again. A CSS-only menu then stays open after the pointer leaves it.
  A menu driven by script already stays open as long as the pointer is in it,
  which is the case while picking inside it. This is all that is left of the
  first draft's freeze; it is cheap.

#### The marks

- **Numbered pins.** Numbered in the order made, drawn on the page at the
  mark, and listed in the tray.
- **Anchored, not placed.** A pin holds its element and its point as a
  fraction of the element's box (Velt's anchor) and follows scrolling,
  resizing and re-layout. If the element is gone (a re-render replaced it),
  the pin is found again by its selectors in rank order; failing that, it
  shows as lost in the tray. The mark keeps what was read when it was made
  either way.
- **The comment.** A pick opens kururu's comment popover beside the pin, with
  the view swapped for its still. Enter keeps it and the page is live again;
  Esc drops the mark. The tray re-opens any mark's comment.
- **Intent.** Optional: fix, change, question, approve (Orca's and
  Agentation's four). It is off by default; a comment usually says it.
- **The tray.** A strip under the tab, in kururu's DOM, so never under the
  page. It lives until it is sent or cleared, across navigations.
- **The cap.** 20 marks per message, refused visibly (Orca's rule).

**What is read for each mark,** at the pick, not on hover. The first group is
read by the marking script with the DOM alone, so an extension gets it too:

- **Element:** tag, id, allow-listed attributes and classes; the visible text,
  200 characters, cut.
- **Box:** in viewport and page coordinates, and the pin as a percentage of
  the box.
- **Selectors, ranked by how long they survive** (Velt's ranking):
  `data-testid` or `id`; role and name; an attribute or class path; a
  positional path last. Each is checked as unique at the moment of the pick.
- **Styles:** an allow-list of about twelve computed styles: colour,
  background, font, size, weight, line height, display, position, margin,
  padding, gap, width and height. They go in the bundle only.
- **Markup:** `outerHTML`, cut to 4 KB, in the bundle only.
- **Crop:** `capturePage` of the mark's box with a margin, taken after the
  hover box is hidden for one frame. The pin is in the crop, which is what
  Cursor does too.

Then main adds what only the debugger has, from the node's `backendNodeId`
(`Runtime.evaluate` in the world for an object handle, then
`DOM.describeNode`):

- **Accessibility:** role and accessible name, from
  `Accessibility.getPartialAXTree`. The script's own guess is the fallback.
- **React:** the component chain and the source, below.

**For the whole set:**

- the URL with the query and fragment removed (a switch keeps them)
- the title and viewport
- the console errors and warnings since load, and the failed requests (status
  ≥ 400 or a network error), from `Runtime`, `Log` and `Network` events. Main
  keeps the last 200 per tab whether or not anyone marks.
- at Send, one `capturePage` of the viewport with the visible pins on it.
  Marks scrolled out of view are in their crops.

**Frames.** Phase 1 marks the top frame and same-origin frames, which the
isolated world reaches through `contentDocument`. Cross-origin frames run in
processes of their own (out-of-process iframes) and need a world each, through
`Target.setAutoAttach`; that waits until somebody needs it.

### The source, on React 19

The research's hardest finding is that **nothing gets `file:line` reliably on
React 19 with Vite without help** (`_debugSource` is gone). The roads, in the
order tried:

1. **A build-time attribute, if the project has one** (`data-insp-path` from
   code-inspector-plugin, `data-locatorjs`, Lovable- or Onlook-style ids).
   Read straight off the node: exact, and free when present. kururu never adds
   the plugin to a project.
2. **The DevTools hook.** It is installed in the page's own world before React
   loads (`Page.addScriptToEvaluateOnNewDocument` with no `worldName`), the
   way bippy does it. For a marked node, main reads its fiber, the owner
   chain's names and `_debugStack` with one `Runtime.callFunctionOn`, then
   symbolicates the top frames against the dev server's source maps.
   - Main fetches the module and its map from the page's origin, the dev
     server's own.
   - It decodes them with a vendored decoder (`source-map-js` is MIT and has no
     dependencies) and turns them into a path inside a workspace root.
3. **Checked against the checkout.** Line numbers from Vite's owner stacks are
   doubtful (React Grab says so in its source). So the server opens the file
   under the workspace root through `files.ts`'s own resolve-and-check, and
   looks for the component's JSX tag within a few lines of the line given.
   - **`verified`:** the tag is found, and the line is moved to it.
   - **`file`:** the file exists but the tag is not near; the file is kept
     and the line dropped.
   - **`names`:** there is no file, only the component chain.

   The mark says which. An agent told `file` greps; one told `verified`
   jumps.
4. **Nothing React:** a selector and text only, which Agentation shows is
   enough for an agent to find most things.

**Only on localhost pages, and on by default there** (still open, question 2
below). A hook in the page's own world is visible to the page and slightly
changes what React does, as React DevTools does. On another site it buys
nothing (production bundles have no `_debugStack`) and costs a script in
somebody else's page. Settings has the switch.

### The bundle and the message

**A mark set** is `data/marks/<id>/`, beside `drops/`, with the same rules:
0700 and 0600, never backed up, nothing deletes it. It holds:

- `marks.md`: everything, written for an agent, in the shape Orca and
  Agentation converged on. A `## Marks on localhost:3000/checkout` heading,
  URL, viewport, then `### 1. <PayButton> button "Pay now"` with the comment,
  source and confidence, selectors, text, role, box, styles, HTML, and
  "Pictures: open these files". A last section lists the console and network
  errors.
  - **Page text is fenced and labelled** as the page's words, not the user's:
    `text the page shows: "…"`.
- `marks.json`: the same record, versioned (a `v` field), for kururu's own
  reading and for the MCP later. Its field names follow AFS 1.1 where the
  meaning matches, so nobody has to translate.
- `view.png`: the viewport at Send, with the numbered pins on it.
- `mark-<n>.png`: each crop, taken when the mark was made.

**Writing it.** The window sends the set to the server it is connected to
with `POST /api/marks`, through the access gate like `/api/drop`. That is the
server whose agents will read it, including another node's when the window is
showing one. Main never writes the data directory itself. The server judges
the pictures by their bytes, as `judgeDrop` does, and writes the files. The
route takes nothing Electron-specific, so an extension could post the same
body.

**The message.** It follows `quoteReference`: a header line, then one line
per mark, each a self-contained instruction:

```
[marks 3 on localhost:3000/checkout (~/.local/share/kururu/marks/m7f3a2/marks.md)]
[mark 1 button "Pay now" (src/components/Checkout.tsx:42)] make it the accent colour
[mark 2 area 320×180 under "Order summary"] this gap is too big
[mark 3 div.totals "Subtotal $42.00" (src/components/Totals.tsx)] numbers don't line up
```

- **The label.** The tag, then the accessible name or the first words of the
  text (cut, and `"` written as `'`, as `quoteWords` does), then the source.
  The source has a line only when it is `verified`.
- **The path.** The header's path is what Kuru and any Claude Code or Codex
  agent Reads. The pictures are named inside it.
- **The user's comment is written as typed**, and is the only free text of
  the user's on the line.

**Where it goes.** The tray's **Send** button has three ways:

1. **Kuru's box, unsent — the default (decided).** Each line goes in through
   `insertLine`, after whatever is already there, like a quote. Kuru's role
   gets two sentences: `[marks …]` is a set of marks on a page, and its file
   says everything. From a detached window, the lines go into the main
   window's box, the way a note's "Reference in Kuru" does, without raising
   the main window over the one the user is working in.
2. **An agent.** The workspace's agents, the card's agent first. It is typed
   as `send_agent` types: `when: next`, never under the user's hands,
   `typingPieces` for the long line.
   - **The caveat.** Several lines go in as one bracketed paste, and a long
     paste reaches Claude Code's model wrapped in `<pasted_content>`
     (`docs/harness.md#speaking-into-a-running-agent`).
   - **The fix.** If the message would pass that size, the comments still go,
     but each label is cut harder. Failing that, the lines are only the header
     plus "my comments are in the file, numbered". That is the user's own
     instruction, typed, pointing at a file the user made.
3. **A card.** It goes onto a new card on the workspace's board or the
   profile's Needs you, or appended to a card's body, the card's quote
   grammar again. The card's agent picks it up when it is run.

**Chips.** `shared/chips.ts` gains `mark` and `marks`.

- **In the box and the drawer:** a mark chip shows its number, label and the
  first words of the comment. A tap shows the crop, from
  `GET /api/marks/<id>/mark-<n>.png` behind the gate.
- **The phone and the web client** draw the same chips and open the crop.
  This is the whole of their part.
- **Telegram's echo** spells them as short words (`plainChips`).

### A window of its own, and the iPad

**Detaching is the pool's move between panes, to another window.**

- **Detach** in the tab's chrome opens a `BrowserWindow` loading the web build
  in a one-thing mode, `?browser=<tabId>`, the way a note loads `?note=<card>`.
  That page draws the tab's chrome, the stub, the comment popover and the
  tray, and is a client of the server like a note is.
- Main removes the view from the main window's `contentView`, adds it to the
  new window's, and takes bounds from the new page's stub. The same
  `webContents`, its JavaScript state, its scroll and its sockets carry over;
  nothing reloads. **Back to the panes** (or closing the window) is the same
  move the other way.
- **The layout keeps the tab.** In its pane it shows "In its own window —
  bring it back". Whether a tab is detached, and where its window is, is the
  Mac's business, not the server's: it lives in `desktop.json` beside the
  notes, and a restart puts the window back, on a screen that still exists
  (`fitOnScreen`). A Sidecar iPad that is not connected is a screen that does
  not exist, so the window comes back on the Mac.
- **One view, one window.** A detached tab's view is in the detached window
  only; the main window's other clients see the placeholder, as they already
  do.
- **Marking works the same in it**, since the marking script is in the page
  and the popover and tray are the detached page's own.

**Sidecar and the Pencil**
([research §6](browser-annotate-research.md#6-after-the-users-answers-sidecar-the-extension-the-z-order)):

- With the iPad as a Sidecar display, the Pencil is the Mac's pointer: a tap
  is a click, a press and drag is a drag, and macOS receives it as tablet
  events with pressure and tilt. Fingers scroll (two fingers) and do the
  system gestures; they do not click. The Sidecar sidebar has ⌘, ⌥, ⌃ and ⇧
  to hold while tapping, and undo.
- **So every tool works.** Element: a tap picks (the Pencil's tap is the
  click mark mode takes). Region: a drag. Pen: a drag, with pressure where
  Chromium reports `pointerType "pen"`. Shift-click is the sidebar's ⇧ and a
  tap.
- **What is lost is hover.** Without hover there is no box under the pointer
  before the tap, so a tap picks the smallest element at that point and the
  popover offers **Wider** and **Narrower** (the ↑/↓ walk as buttons). On an
  M2 or later iPad with a hover-capable Pencil the pointer may follow the
  hovering Pencil; that is **unverified** and the design does not rely on it.
- **Writing the comment.** The Mac's keyboard, or the popover's
  hold-to-dictate mic (a press with the Pencil holds it). iPadOS Scribble
  writes into iPad text fields, not into a Mac's, so handwriting a comment is
  not expected to work; **unverified**.
- **Verifying it** is part of the phase's done: Patrick Lauke's pen tracker
  page in a detached tab on a Sidecar iPad says whether Electron's Chromium
  sees `pen` with pressure, and each tool is tried with the Pencil.

**Cost.** S–M. The window is `notes.js`'s pattern, the move is the pool's,
and the page mode is a small React root. It needs no server change beyond
what phase 0 already has.

### Agents seeing the page, and acting in it

**The rule.** An agent already has its own browser tools; Claude Code users
add Playwright MCP or chrome-devtools-mcp themselves. kururu has two things
none of those has:

- **the user's own tab:** the page as the user sees it, logged in as they
  are
- **the marks**

So kururu's tools are about those two, and stay few, in `mcp.ts`'s
five-method style. They are served at `POST /mcp/browser` and given to agents
the way `/mcp/web` is:

| tool | what it does |
|---|---|
| `browser_tabs` | the browser tabs in the agent's workspace: id, URL, title, whether the Mac window has it open |
| `browser_look` | a tab now: a screenshot to a file (the path back, never inline bytes: chrome-devtools-mcp's "reference over value"), the URL, and an accessibility snapshot cut to `READ_MAX`, with refs |
| `browser_console` | the tab's kept console errors and failed requests |
| `browser_marks` | the open marks on the tab or a set: each with its comment, selectors and source; `reply` and `resolve` (Agentation's loop), drawn on the pin as "resolved by the Checkout agent" |
| `browser_act` | navigate, reload, open a tab, click or type by ref or by one of a mark's selectors (Playwright's lesson: a human's selector is a target) |

**How a call reaches the page.** Agent → server → the Mac window over its
existing socket, the way `reload_window` reaches it → main → the view's
debugger. Clicks and keys go in through CDP `Input.dispatch*Event`, which
the page receives as real input, not as synthetic DOM events. With no window
open there is no page: the tools say so in a sentence rather than starting a
browser.

**Agents act in the user's tab, with the user's logins (decided).** There is
no switch. What there is:

- **A tab an agent opens** is in the same `persist:kururu-browser` session,
  so its logins are the user's too (assumed from the answer; question 5
  below).
- **You can see it happen.** While an agent's action is in flight, the tab's
  chrome shows a badge with the agent's name and a **Stop** that refuses that
  agent's next actions on the tab until pressed again.
- **You can read what happened.** Each action is a line in the tab's log
  (agent, verb, target, time), kept with the tab's console ring.
- **What is never forwarded:** `Browser.close`, `Target.closeTarget`,
  `Page.close`, and navigations to anything but `http:` and `https:`.
- **Scope of the logins.** They are the logins made in kururu's browser, not
  the user's Chrome profile. That is a real difference from an extension (see
  below), and the reason the built-in browser is where agents act.

### The built-in browser, or an extension

The user asked whether an extension for their real browser, talking to kururu
locally, would be better than the built-in browser or a complement to it.

**What an extension would be (Chrome, MV3):**

- **Marking in the page:** the same marking script, as a content script. A
  content script runs in an isolated world, as kururu's would, so the shadow
  root, the top layer and the click capture are identical.
- **The tray and the comments:** Chrome's side panel (`chrome.sidePanel`), an
  extension page beside the tab. No z-order problem at all: the page is never
  covered.
- **The React source:** a content script in the page's world
  (`world: "MAIN"`, `document_start`) installs the same hook. Symbolication
  and the checkout check are the server's either way.
- **Crops:** `chrome.tabs.captureVisibleTab`, cropped. It sees only the
  visible part of the active tab, which is what a mark is.
- **Console and network:** `chrome.webRequest` sees failed requests; console
  errors only by wrapping `console.error` and `onerror` in the page's world,
  since without the debugger there is no `Runtime` or `Log`. Partial.
- **Talking to kururu:** the service worker posts the same body to
  `POST /api/marks` on `127.0.0.1:7717`, with `host_permissions` for loopback.
  - **Its origin is `chrome-extension://<id>`,** which `originOk` refuses
    today. It gets one exact entry: the paired extension's origin, recorded at
    pairing, never every `chrome-extension://`.
  - **Pairing:** Settings shows a single-use code, as a node's pairing does;
    the extension trades it for a token scoped to marks (post a set, list
    workspaces) and keeps it in `chrome.storage.local`, which pages cannot
    read. Loopback being exempt from the token does not apply to it: the token
    is checked for that origin always.
  - **Native messaging** (Chrome checks the extension's id against a manifest
    kururu writes into each browser's `NativeMessagingHosts` folder) would
    need no code. It costs a native host binary and a file in every Chromium
    browser's support folder. Not worth it for a token.
  - **Local Network Access:** whether Chrome asks before an extension's worker
    reaches loopback is **unverified**; if it does, the first request is made
    from the side panel, a document that can show the prompt.
- **Which workspace:** the extension has no pane, so it has no workspace. The
  server can guess from the URL (a port that is a card's or a workspace's dev
  server); otherwise the marks go to Kuru's box in the main window, which is
  the default anyway.
- **Distribution:** the Chrome Web Store, unlisted, with its review; or
  "Load unpacked", which works on a Mac without a nag. An id pinned with a
  `key` in the manifest keeps pairing stable.

**Agents in the user's Chrome:**

- **With `chrome.debugger`:** full CDP, as Playwright MCP's and Browser MCP's
  extensions do. Chrome shows "Kururu started debugging this browser" across
  the browser for as long as it is attached, and nothing an extension does
  hides it; only launching Chrome with `--silent-debugger-extension-api` does.
  Attaching per action makes it flicker; staying attached makes it permanent.
- **Without it:** a screenshot of the visible tab only, clicks as DOM events
  that pages can tell apart (`isTrusted` false), no console. Weak.
- **The logins are every login the user has:** mail, bank, admin consoles,
  not just the app being built. An agent steered by text on a page could act
  in any of them.
- **It already exists without kururu:** chrome-devtools-mcp's `--autoConnect`
  (Chrome 144+) attaches an agent to the user's running Chrome, behind
  Chrome's own consent dialog. If agents in the real Chrome are wanted, that
  is the road, not kururu's extension.

**Safari:**

- A Safari Web Extension must ship inside a signed, notarized Mac app, as an
  app extension. Kururu.app is Developer ID signed and notarized, and kururu
  already builds Swift through `xcrun`, so it is possible. But electron-builder
  does not build app extensions; it would mean an Xcode target, its own
  entitlements and signing inside the bundle, and the DMG's notarization
  re-tested. The user then enables it in Safari's settings and grants it the
  sites.
- **No debugger API.** Agents cannot act in Safari at all.
- **No pairing needed:** `browser.runtime.sendNativeMessage` reaches the
  containing app's extension handler, which can read kururu's own token from
  disk.
- **Cost L, for marking only, in one browser.** Not planned.

**The comparison:**

| | built-in browser | Chrome extension |
|---|---|---|
| beside the agents, in panes, kept across restarts | **yes** | no: another app's window |
| marking UI | in the page (isolated world) + kururu's popover over a still | in the page (content script) + side panel; **simplest z-order** |
| your real tabs, logins, password manager, extensions | no: its own session; you log in to what you test | **yes** |
| "Sign in with Google" | **likely blocked** (Google refuses embedded browsers) | works |
| React source | yes | yes, the same hook |
| console and network errors | yes, full (CDP) | partial without the debugger |
| agents look and act | **yes, CDP, no banner, scoped to kururu's session** | only with the debugger banner, in every login you have |
| on the iPad (Sidecar) | detach the tab, drag it | drag Chrome's window; works already |
| auth to kururu | none: the window is kururu | pairing code, a token, one exact origin in `originOk` |
| Safari | — | L, marking only |
| cost | phases 0–1: L + L | M on top of phase 1 (it reuses the script and the route), S for pairing |

**Recommendation: the built-in browser first, the Chrome extension as an
optional later complement for marking only, Safari not planned.**

- The ask was a browser beside the agents, and that is the built-in one. It
  is also where agents can act with the user's logins and nobody's banner,
  which the user wants, and its logins are only the ones made in it.
- The extension's real wins are the user's real logins and Google sign-in.
  Both matter for marking, not for agents. So it marks and sends, and does
  not drive.
- The cost of keeping that door open is a design rule, not code: the marking
  script has no Electron in it and `POST /api/marks` takes a plain body. Build
  the extension when the built-in browser hits a sign-in it cannot do, or
  when the user finds themselves marking in Chrome anyway.

### Security

**1. The browser's pages can drive kururu today.**

- `originOk` (`server/src/access.ts`) accepts **any port** on a loopback host,
  and on this Mac's own addresses.
- `decide` lets loopback in without a token unless `loopbackToken` is on, and
  it is off on the Mac.
- So a page at `http://localhost:3000`, or a script any dependency of that dev
  app ships, can open `ws://127.0.0.1:7717/ws` and type into an agent.

That is already true of the same page in Safari or Chrome, and the user has
decided that the wider fix is not needed. But the built-in browser makes "a
dev app's page beside your agents" the normal case, and any website can be
loaded in it. Chrome's Local Network Access does not cover loopback to
loopback, so nothing in the browser helps.

**Phase 0's answer, for the browser's session only:**
`webRequest.onBeforeRequest` on `persist:kururu-browser` cancels any request,
WebSocket upgrades included, to:

- the port kururu's server is on
- the preview proxies' ports (7800+)
- kururu's own vite in development (5173)
- the CDP relay, should it ever exist

on every loopback name and the Mac's own addresses. A test page that tries
each of these is part of phase 0's done. `originOk` itself is not changed,
except for one exact extension origin if phase 7 is built.

**2. The guest is hostile by default.** Everything from
[research §4](browser-annotate-research.md#guest-security):

- `sandbox`, `contextIsolation`, no node
- **no preload at all.** Everything is CDP from main; kururu's code in the
  page is the marking script in its isolated world, injected only while
  marking or while pins are shown
- deny-by-default handlers for permissions, devices and display capture
- downloads stopped (or saved to `~/Downloads` with a line in the tab; open
  question)
- popups opened as a new browser tab, never a window
- `http:`, `https:` and `about:blank` only, checked on navigation, frame
  navigation, redirects and in `onBeforeRequest`
- `file:` refused
- the main window's `defaultSession` header stripping never applies here

**3. What the page can learn from marking.** That kururu is marking it (the
host element exists) and the pins' numbers. Never the comments, which are
typed into kururu's popover while the view shows a still, and never anything
through the binding, which the page's world cannot call. A page can remove or
cover our layer; the worst that does is hide pins.

**4. What a mark takes away.**

- **It's all page content.** Text, HTML and a screenshot can hold secrets:
  a token on screen, an email address, a customer's name.
- **Kept out:**
  - the query string and fragment (by default)
  - the value of any `input` (never read)
  - `type=password` fields (always blank)
- **Redacted:** attributes are allow-listed, and Orca's secret patterns are
  checked once in main before the server writes.
- **Where it goes.** The screenshot goes to the agent's model, which is a
  provider's server. That is the point of the feature, and the Send button's
  tooltip says it once.
- **Who can see it.** The marks folder is never backed up, and only the
  gate's clients can see it.

**5. Page text is untrusted.** A button that says "ignore your instructions"
ends up in a mark's label. Labels are cut short and quoted, and `marks.md`
fences the page's text and says whose it is. The user's comment is the only
instruction on the line.

**6. Agents acting with the user's logins** (decided, accepted). An agent
that reads a hostile page can be steered by it, and in this browser it can
then click in whatever the user is logged into here. What limits it: the
session holds only logins made in kururu's browser; the badge, Stop and log
make it visible; the never-forwarded verbs stay refused; `file:` and other
schemes stay refused.

## Phases

| phase | what | rough size | costs on the machine |
|---|---|---|---|
| 0 | the browser tab and its safety | L | `desktop/` (relaunch the window), `web/` (repaint), `shared/layout.ts` (a reconnect under `bun run dev`); **no host change** |
| 1 | live marking and the bundle, to Kuru's box | L | `desktop/`, `web/`, a server route (reconnect) |
| 2 | a window of its own, and the Pencil on Sidecar | S–M | `desktop/`, `web/` |
| 3 | the React source | M | `desktop/`, server (the checkout check) |
| 4 | to an agent, to a card; chips everywhere | S–M | server, `web/`, `shared/chips.ts` |
| 5 | `/mcp/browser`: tabs, look, console, marks loop, act | M | server (launch flags, like `/mcp/web`); reaches agents started after it |
| 6 | *(optional)* a CDP relay for Playwright MCP / chrome-devtools-mcp | M | `desktop/` |
| 7 | *(optional)* a Chrome extension, marking only | M + S | a new `extension/` folder, server (pairing, one origin) |

The sizes are relative: S is a day of an agent's work with verification, L
about a week. They are guesses from the research and the files they touch,
not measured. Orca's main process has about 630 files of browser code; the
phases stop well short of that on purpose.

**No phase touches the pty host.** None of this is in `server/src/agents/`,
`ptyhostd.ts` or the host link.

### Phase 0: the browser tab, and nothing it can reach

**Build:**

- `web:` tabs in `shared/layout.ts`, with `terminalsOf` and `activeTerminal`
  taught to skip them, and tests for every operation in that file on a `web:`
  id.
- `web` pane state, persisted as structure; the server verbs to open a URL,
  navigate and close.
- `desktop/browser.js`:
  - the pool and the session
  - every handler in Security 1 and 2
  - `before-input-event`
  - bounds, stills and capture over the bridge
  - **listed in `electron-builder.yml`**
- `web/`: the tab's chrome, the stub, `overlays.ts`, the placeholder for other
  clients, and the entry points (dev-server row, card, + menu).

**Done when:**

- A throwaway static page and a throwaway Vite app load in a tab, and their
  HMR works. A public site loads too.
- The tab drags between panes and workspaces without reloading. The test
  page counts its own loads.
- Every overlay of kururu's swaps to the still.
- `C-a` reaches kururu from inside the page.
- The test page's attempts on `:7717/ws`, `/api/health`, `:7800` and `:5173`
  all fail. In a browser outside kururu the same page succeeds, which shows
  the block is what stopped them.
- A restart brings the tab back unloaded until it is shown.

**Test** with the desktop app driven hidden ([testing by hand](../testing.md#testing-by-hand)) on an
[isolated instance](../testing.md#the-isolated-instance), never the user's
window, apps or agents.

### Phase 1: live marking, and the bundle to Kuru's box

**Build:**

- the marking script: the isolated world, the binding, the closed shadow root
  in the top layer, the click capture, the four tools and Hold hover; written
  with no Electron in it
- anchored pins that follow the page, and find their element again
- the comment popover over the still, the tray, comments with dictation
- the DOM-read facts in the script, the debugger's in main, ranked and
  uniqueness-checked selectors
- the console and network ring buffer
- `POST /api/marks` and the folder; `marks.md`, `marks.json`, crops and the
  view
- the message, into Kuru's box
- the `mark`/`marks` chips in the box

**Pure and tested:**

- the pin anchoring (a box and a fraction to a point, and back)
- the selector ranking
- the label and the message's grammar, read back by `chips.ts`
- the redaction
- `marks.md`'s writer

**Done when:**

- Three marks of different kinds on the throwaway app, one of them inside a
  hover-only menu and one far down the page, produce a folder whose
  `marks.md` a stand-in agent can act on, and a box with three chips.
- A mark's click never reaches the page: the throwaway app's button counts
  its clicks, and the count does not move.
- The throwaway app re-renders the marked element; its pin follows or is
  found again.
- A page with a strict CSP and a page with its own modal dialog both show the
  pins above everything.
- A `type=password` value, a `?token=` query and an `Authorization`-looking
  attribute appear nowhere in the folder. A comment's words appear nowhere in
  the page's DOM.

### Phase 2: a window of its own, and the Pencil on Sidecar

**Build:**

- the `?browser=<tabId>` page mode: chrome, stub, popover, tray
- Detach and Back in `browser.js`: the view moved between windows, bounds
  from the new stub
- the detached window's place in `desktop.json`, put back on a screen that
  exists
- the "in its own window" placeholder in the pane
- Send from a detached window into the main window's Kuru box
- Wider and Narrower in the comment popover, for a pointer without hover

**Done when:**

- A tab detaches and comes back with its page state intact (the test page
  counts loads and keeps a typed value).
- The window, closed with the app, comes back where it was; with its screen
  gone, it comes back on the Mac.
- On a Sidecar iPad: the pen tracker page says what Chromium sees from the
  Pencil, and each tool works with it. This step needs the user's iPad and is
  the user's to run; it is written up for them, not done by an agent.

### Phase 3: the source

**Build:**

- road 1 (attributes)
- road 2 (hook, `_debugStack`, source maps), localhost only, behind its
  switch
- road 3 (the checkout check through `files.ts`), and the confidence on the
  mark

**Done when** these all give `verified` for a known component:

- a throwaway React 19 + Vite app
- a throwaway React 19 + Next app
- one with code-inspector-plugin

A non-React page gives `names` or nothing, without an error. The cases worth
a fixture: a component in a `node_modules` package (it should say so, not
claim the checkout), a server component on Next, and a memo or forwardRef
wrapper.

### Phase 4: to an agent, to a card, and the chips everywhere

**Build:**

- Send's other two ways
- the paste-size rule
- the chips in `SentWords`, on cards, on the phone and web client, and in
  `plainChips`
- `GET /api/marks/<id>/…` behind the gate
- the role's two sentences

**Done when:**

- A stand-in Claude (`cat`, or a script that echoes its input to a file, per
  [testing by hand](../testing.md#testing-by-hand)) receives exactly the lines.
- A card shows the chips and opens a crop on the phone's web client.

### Phase 5: agents see the page and act in it

**Build:**

- `/mcp/browser` and its five tools, `browser_act` included, with no switch
- tabs agents open, in the same session
- the badge, Stop and the action log in the tab's chrome
- the launch flags beside `/mcp/web`'s
- the `resolve` drawn on the pin

**Done when:** a stand-in MCP client lists tabs, reads a screenshot path and
the console, clicks a button by a mark's selector (the throwaway app's count
moves), and resolves a mark, which the tray then shows. Stop refuses its next
action. `Browser.close` and a `file:` navigation are refused.

### Phase 6 (optional): a CDP endpoint for one tab

Only if agents want Playwright MCP's or chrome-devtools-mcp's full toolset on
the user's tab rather than kururu's five tools.

**Build** Playwright's `BrowserModel`, ported onto `webContents.debugger`, in
main:

- loopback only
- a 256-bit token in the path plus a header
- `Host` checked exactly, any `Origin` refused
- only that tab's target advertised
- `Browser.close`, `Target.closeTarget` and `Page.close` refused, never
  forwarded
- `Emulation.setDeviceMetricsOverride` answered locally (VS Code's crash)

The endpoint goes to an agent through `browser_tabs`. Agents can't add an MCP
server mid-session, so in practice this is for an agent started with that
server configured. That is a real limit and the reason this is optional.

### Phase 7 (optional): a Chrome extension, marking only

Only when the built-in browser meets a sign-in it cannot do, or the user is
marking in Chrome anyway.

**Build:**

- `extension/`: a MV3 manifest with a pinned `key`, the marking script as a
  content script (the same file, built twice), the hook as a `MAIN`-world
  script on localhost, the side panel with the tray and comments, a service
  worker that posts to `POST /api/marks`
- pairing: a single-use code in Settings, traded for a marks-scoped token;
  the extension's exact origin added to `originOk` for that token only
- marks from the extension go to the main window's Kuru box

**Not built:** `chrome.debugger`, agents in Chrome (chrome-devtools-mcp's
`--autoConnect` already does that), Safari.

**Done when:** a mark made in Chrome on the throwaway app lands in Kuru's box
with the same lines and folder as one made in the built-in browser, and an
unpaired extension, and a page, are both refused by `/api/marks`.

## Risks

- **kururu's overlays over the page are the long tail.** Every new overlay
  kururu adds must register with `overlays.ts`, or it draws under the page. A
  dev-mode warning helps: an element with `position: fixed` and a z-index
  above the panes' that is not registered.
- **The page fights the marking layer.** A page can remove foreign nodes,
  open its own top-layer elements over ours, or restyle `html > *`. The
  layer re-attaches and re-promotes itself; if a real app still defeats it,
  the transparent stacked view is the fallback, at its cost.
- **Swapping to a still for each comment** is one frame of swap each way. If
  it flickers on a busy page, the comment can be typed in the tray instead,
  with the page left live.
- **Google sign-in in an embedded browser** is refused by Google. A dev app
  whose login is "Sign in with Google" may not be testable logged-in in the
  built-in browser. Email and password, magic links and most OAuth providers
  work. That is the strongest reason for phase 7.
- **The Pencil under Sidecar** is expected to arrive as tablet events and
  `pointerType "pen"`, but Electron's Chromium under Sidecar was not tried.
  If it arrives as a mouse, every tool still works, without pressure.
- **The debugger can be detached** by opening DevTools on the same view
  (Electron's docs say so; a spec test says otherwise; unverified on 44).
  `browser.js` must re-attach on `detach` and say so in the tab when it
  cannot.
- **Source maps lie.** That is why road 3 exists. The confidence, not the
  line, is what the agent is told to trust.
- **Electron moves.** The Overlay and CSS domains are experimental, and
  `console-message`'s signature changed recently. The CDP calls used are few
  and kept in one file.
- **Agents acting with the user's logins** is accepted by the user; the
  residual risk is a page steering an agent. See Security 6.
- **Scope creep toward Orca.** Password import, profiles, extensions inside
  the browser, a download manager and a mobile screencast are all out. The
  browser is for looking at what the agents are building, and at the docs and
  sites that come up beside it.

## Questions still open

1. **Screenshots to the model:** a crop per mark plus the view at Send
   (recommended), or the view only, or ask each time?
2. **The React hook:** on by default for localhost pages (recommended), or
   off until asked?
3. **Keeping marks:** forever like `drops/` (recommended, the folder is
   yours), or swept after some weeks?
4. **Downloads:** refused (recommended), or saved to `~/Downloads`?
5. **Tabs agents open themselves:** in your session with your logins
   (assumed, from "yes, with my logins"), or a session of their own with
   none?
6. **Send from a detached window:** into the main window's Kuru box
   (recommended), or a small Kuru box in the detached window itself, so the
   iPad never needs the Mac's screen?
7. **The extension:** build phase 7 only when a sign-in forces it
   (recommended), or plan it right after phase 1? Unlisted on the Web Store,
   or "Load unpacked"?

## Noticed while reading, not part of this

- **The preview proxy forwards kururu's access cookie to the dev server.**
  Cookies are scoped by host, not port. So `kururu_access`, set by
  `cookieHeader` on the phone's tailnet address, is sent with every request to
  that address's `:7800+` proxies. `forwardHeaders` in `server/src/proxy.ts`
  passes the `Cookie` header upstream unchanged, so the dev server, and
  anything logging its requests, sees the token. The fix is to drop
  `kururu_access` from the forwarded `Cookie`. It's a server change and costs a
  reconnect. Worth a card.
- `PLAN.md`'s picker paragraph (Next, 6) and `web/src/preview.ts`'s closing
  comment both describe the proxy-injected picker this plan replaces. Update
  them when phase 1 lands, not before.
