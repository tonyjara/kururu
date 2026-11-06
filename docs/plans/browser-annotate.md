# A browser in kururu, and marks on a page for the agents

A plan, written 2026-11-06 from a read of the tree at `0ce67bd`, of
`798495f` for the commit beside it, and of the research in
[browser-annotate-research.md](browser-annotate-research.md). **Nothing was
built.** It is written so that an agent can take one phase, read the files it
names, and know what "done" is.

**The ask, in the user's words:** a browser inside kururu, as a pane or a tab
beside the agents, with "tools for me to select things on the screen and add
comments about it so that you understand better what I'm talking about, I know
that things like orca already do this, so do a little research and figure out
the best way to implement this."

**Scope.** It is **the desktop app only**. The phone never gets a browser or
the tools. The web client only shows what comes out of it: a message, or a
card quote that carries marks. The iPad and Apple Pencil get a short optional
section at the end, with a cost and a verdict.

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
- **It is not a `<webview>`.** Moving one in the DOM creates a new guest.
- **It is not an iframe.** It would be cross-site to a window at
  `127.0.0.1:7717`, so a dev app's logins would break inside it, and it has no
  CDP of its own.
- **Its session is its own, `persist:kururu-browser`, and never
  `defaultSession`.** `desktop/main.js` strips every CSP from `defaultSession`.

**Marking: freeze the frame, then mark the picture.**

- Pressing **Mark** (or its key) takes a screenshot of the view and a layout
  snapshot of the page (`DOMSnapshot.captureSnapshot`) in one go.
- kururu's own React then draws over the picture. Hovering highlights elements
  from the snapshot's rects, a click pins one, a drag boxes a region, and a pen
  draws.
- Every mark is numbered and has a comment field. That field is the
  composer's `ChipField`, with the quote popover's dictation.

Why not draw kururu's UI live in the page, as Orca, Cursor and Agentation do:

- **Z-order.** A `WebContentsView` is drawn above all of the window's DOM, so a
  popover of kururu's can't sit over the page. This removes that problem.
- **No kururu UI in the page.** A dev app's DOM, or anything a hostile page
  runs, never sees or touches kururu's UI.
- **The page holds still while you write about it.**
- **It is the iPad's version too.** A frozen frame with a snapshot is exactly
  what a Pencil wants, so the optional iPad half is mostly free.

**What it costs:**

- **Hover states.** Hover-only states are kept by freezing from the keyboard
  while the pointer is still over the page.
- **Long pages.** Marking below the fold means unfreezing, scrolling and
  freezing again. Marks pile up in one tray across freezes, and each keeps its
  own picture.

**What a mark carries.** The best of what the research found
([§2](browser-annotate-research.md#2-what-matters-to-an-agent-in-order)):

- the comment
- **the source `file:line` and the component chain**, checked against the
  checkout
- a selector to grep for, and the visible text
- role and accessible name
- the box
- a crop, plus the frame with numbered pins drawn on
- the console errors since the page loaded

Styles and HTML go in the bundle's file, not the message.

**Delivery is kururu's existing grammar:**

- **The message.** Each mark becomes one line in the box,
  `[mark 2 button "Pay now" src/Checkout.tsx:42] make it the accent`, as each
  quote already is.
- **The folder.** Everything else goes in a folder beside `drops/`, and the
  first line hands over its path.
- **Where it goes.** It goes to Kuru's box unsent by default. It can also be
  sent to an agent (typed as `send_agent` types) or put on a card.
- **On other clients.** The phone and the web client draw these lines as
  chips, which is all they ever do with this feature.

**Agents see the page through a handful of kururu MCP tools, later.** It is
not a raw CDP port in the first instance. The relay that would let Playwright
MCP or chrome-devtools-mcp attach is prior art that already exists
(Playwright's `cdpRelay`, VS Code's `BrowserViewGroup`), and it is an optional
last phase.

**Before any of it: the browser's pages must not be able to talk to kururu.**
Today they can (see [Security](#security)). Phase 0 closes that for the
browser's session.

## What is there today

| piece | where | what it gives this |
|---|---|---|
| tabs of any kind in a pane | `shared/layout.ts`: `BOARD_TAB`, `docTab` (`doc:` + JSON) | a browser tab is a third id kind: drag, split, merge for free |
| the trap in that | `terminalsOf`, `activeTerminal` treat *every* id that is not the board or a `doc:` as a terminal | a `web:` id must be added to both, or it is killed, watched and typed into |
| pane state beside the tabs | `ReaderState` on `PaneState` | the shape a tab's URL and title can take, persisted as structure |
| dev servers found | `server/src/devservers.ts`, a card's own in `carddev.ts`, `serverIn` in `web/src/preview.ts` | "Open in browser" on a dev-server row and on a card |
| the Electron shell | `desktop/main.js` (`BrowserWindow`, `contextIsolation`, `setWindowOpenHandler`, `context-menu`) | where the pool, the session and the debugger live |
| the window's bridge | `desktop/preload.js` | bounds, freeze and capture verbs between page and main |
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
  - Closing the tab is the only thing that destroys the view.
- **The other clients.** The phone and the web client get a tab they cannot
  draw. They show the title, the URL and "Open on the Mac", nothing else.
  - The layout is the server's, so they see the tab.
  - The page is the Mac window's, so they don't see the page.
  - Two Electron windows on one layout share the one view in main. The
    focused window shows it, and the other gets the placeholder.

**The z-order.** This is VS Code's answer, copied
([research §4](browser-annotate-research.md#4-embedding-a-page-in-electron)).
A small `overlays.ts` in `web/` watches kururu's own overlays:

- `Menu`
- the Kuru, Needs and Settings drawers
- dialogs
- the quote popover
- a pane being dragged

When one really paints over a browser tab (rect intersection, then
`elementFromPoint` at the centre), the page asks main for a JPEG of the view.
It shows that as the stub's background and hides the view one frame later.
The overlay closing shows it again. The placeholder is refreshed every 1 s
while visible.

**Keys.** A click on the page sends focus into the view. Main's
`before-input-event` takes kururu's prefix (`C-a`) and the ⌘ shortcuts kururu
owns, forwards them to the window and gives focus back. Everything else is
the page's.

**The tab's chrome** is kururu's own DOM, above the stub:

- back, forward, reload, the address field, zoom
- **Mark**
- DevTools (`openDevTools({mode:'detach'})`)
- "Open in Safari"

**Where it opens from:**

- the dev-server rows
- a card's dev server
- a link in an agent's reply ("open in kururu"), and ⌘-click on a URL in a
  terminal
- the + menu's "Browser"

New tabs follow the workspace's existing placement rules: the + menu's go
where asked, and kururu's own go to the agents' pane.

### Marking

**Entering.** **Mark** (button, or ⌘⇧M taken in `before-input-event` so a
hover state survives) freezes the tab:

1. **One capture.** Main runs one CDP round:
   - `Page.captureScreenshot` of the viewport at device scale
   - `DOMSnapshot.captureSnapshot` with layout rects
   - the scroll position, viewport and DPR
   - `window.getSelection()`, read in an isolated world, so text selected
     before the freeze becomes a text mark
2. **The rects.** Main reduces the snapshot to a flat list of visible
   elements: node index, `backendNodeId`, rect, tag, a short label. It sends
   that list and the picture to the page.
3. **No IPC while hovering.** Hit-testing is local arithmetic over that list.
   It lives in `shared/` and is tested.

**The tools, on the frozen frame:**

- **Element (the default).** Hover shows the smallest element under the
  pointer; ↑/↓ walk to the parent or child, as in Cursor; a click pins it.
- **Region.** Drag a box. It keeps the elements it fully contains, up to a
  few, as context.
- **Pen.** Freehand, an arrow or an ellipse, drawn onto the picture. The
  strokes' bounding box resolves to elements the same way a region does.
- **Text.** Whatever was selected before the freeze.

**The marks:**

- **Numbered pins.** They are numbered in the order made, drawn on the frame,
  and listed in the tray.
- **The comment.** Each has one, a `ChipField` with the hold-to-dictate mic,
  so a mark can be spoken.
- **Intent.** Optional: fix, change, question, approve (Orca's and
  Agentation's four). It is off by default; a comment usually says it.
- **The tray.** It lives in the tab until it is sent or cleared, and
  "unfreeze" keeps it.
- **Unfreeze.** It goes back to the live page. The pins are drawn there as a
  passive overlay only while frozen, never injected.
- **The cap.** 20 marks per message, refused visibly (Orca's rule).

**What main fills in for each mark,** from its `backendNodeId`. It does this
after the click, not on hover:

- **Element:** `DOM.describeNode` gives tag, id, the allow-listed attributes
  and classes. The visible text is 200 characters, cut.
- **Accessibility:** role and accessible name, from
  `Accessibility.getPartialAXTree`.
- **Box:** the box in viewport and page coordinates, and the pin as a
  percentage of the box (Velt's anchor).
- **Selectors, ranked by how long they survive** (Velt's ranking):
  - `data-testid` or `id`
  - role and name
  - an attribute or class path
  - a positional path (last)

  Each is checked as unique at capture time.
- **Styles:** an allow-list of about twelve computed styles: colour,
  background, font, size, weight, line height, display, position, margin,
  padding, gap, width and height. They go in the bundle only.
- **Markup:** `outerHTML`, cut to 4 KB, in the bundle only.
- **React:** the component chain and the source, below.
- **Crop:** the mark's box with a margin, out of the frozen picture, not a
  second capture.

**For the whole set:**

- the URL with the query and fragment removed (a switch keeps them)
- the title and viewport
- the console errors and warnings since load, and the failed requests (status
  ≥ 400 or a network error), from `Runtime`, `Log` and `Network` events. Main
  keeps the last 200 per tab whether or not anyone marks.

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

**Only on localhost pages, and on by default there.** A hook in the page's
own world is visible to the page and slightly changes what React does, as
React DevTools does. On another site it buys nothing (production bundles have
no `_debugStack`) and costs a script in somebody else's page. Settings has
the switch.

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
- `frame-<n>.png`: each frozen frame, with the numbered pins drawn on.
- `mark-<n>.png`: each crop.

**Writing it.** The window sends the set to the server it is connected to
with `POST /api/marks`, through the access gate like `/api/drop`. That is the
server whose agents will read it, including another node's when the window is
showing one. Main never writes the data directory itself. The server judges
the pictures by their bytes, as `judgeDrop` does, and writes the files.

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

**Where it goes.** The tray's **Send** button has three ways, and the
default is open question 2:

1. **Kuru's box, unsent.** Each line goes in through `insertLine`, after
   whatever is already there, like a quote. Kuru's role gets two sentences:
   `[marks …]` is a set of marks on a page, and its file says everything.
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

### Agents seeing the page

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
| `browser_act` | **only with the user's switch on**, see below: navigate, reload, click or type by ref or by one of a mark's selectors (Playwright's lesson: a human's selector is a target) |

**How a call reaches the page.** Agent → server → the Mac window over its
existing socket, the way `reload_window` reaches it → main → the view's
debugger. With no window open there is no page: the tools say so in a
sentence rather than starting a browser.

**Should agents drive the user's tab?** That is open question 3, because the
user's tab has the user's logins. The cautious answer is in the table:

- **Looking is allowed.** It is reading what is on the user's screen.
- **Acting needs a switch** per workspace, off by default.
- **A tab an agent opened** for its own checks gets an in-memory partition
  of its own, not the user's `persist:` session.

### Security

**1. The browser's pages can drive kururu today.**

- `originOk` (`server/src/access.ts`) accepts **any port** on a loopback host,
  and on this Mac's own addresses.
- `decide` lets loopback in without a token unless `loopbackToken` is on, and
  it is off on the Mac.
- So a page at `http://localhost:3000`, or a script any dependency of that dev
  app ships, can open `ws://127.0.0.1:7717/ws` and type into an agent.

That is already true of the same page in Safari or Chrome. It isn't new. But
the browser tab makes "a dev app's page beside your agents" the normal case,
not an accident. Chrome's Local Network Access does not cover loopback to
loopback, so nothing in the browser helps.

**Phase 0's answer, for the browser's session:** `webRequest.onBeforeRequest`
on `persist:kururu-browser` cancels any request, WebSocket upgrades included,
to:

- the port kururu's server is on
- the preview proxies' ports (7800+)
- kururu's own vite in development (5173)
- the CDP relay, should it ever exist

on every loopback name and the Mac's own addresses. A test page that tries
each of these is part of phase 0's done.

**Tightening `originOk` for everybody is a separate question** (open question
8). One way: on loopback, accept only kururu's own port, its vite's, and
`KURURU_ALLOWED_ORIGINS`. It would close the hole for every browser, not just
this one, and it is a server change, so it costs a reconnect, not an agent.

**2. The guest is hostile by default.** Everything from
[research §4](browser-annotate-research.md#guest-security):

- `sandbox`, `contextIsolation`, no node
- **no preload at all at first.** Everything is CDP from main, and an
  isolated world only for reading the selection
- deny-by-default handlers for permissions, devices and display capture
- downloads stopped (or saved to `~/Downloads` with a line in the tab; open
  question)
- popups opened as a new browser tab, never a window
- `http:`, `https:` and `about:blank` only, checked on navigation, frame
  navigation, redirects and in `onBeforeRequest`
- `file:` refused
- the main window's `defaultSession` header stripping never applies here

**3. What a mark takes away.**

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

**4. Page text is untrusted.** A button that says "ignore your instructions"
ends up in a mark's label. Labels are cut short and quoted, and `marks.md`
fences the page's text and says whose it is. The user's comment is the only
instruction on the line.

## Phases

| phase | what | rough size | costs on the machine |
|---|---|---|---|
| 0 | the browser tab and its safety | L | `desktop/` (relaunch the window), `web/` (repaint), `shared/layout.ts` (a reconnect under `bun run dev`); **no host change** |
| 1 | marking and the bundle, to Kuru's box | L | `desktop/`, `web/`, a server route (reconnect) |
| 2 | the React source | M | `desktop/`, server (the checkout check) |
| 3 | to an agent, to a card; chips everywhere | S–M | server, `web/`, `shared/chips.ts` |
| 4 | `/mcp/browser`: look, console, marks loop; act behind its switch | M | server (launch flags, like `/mcp/web`); reaches agents started after it |
| 5 | *(optional)* a CDP relay for Playwright MCP / chrome-devtools-mcp | M | `desktop/` |
| 6 | *(optional)* iPad + Pencil | S–M on top of 1 | `web/`, server |

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
  - bounds, placeholders and capture over the bridge
  - **listed in `electron-builder.yml`**
- `web/`: the tab's chrome, the stub, `overlays.ts`, the placeholder for other
  clients, and the entry points (dev-server row, card, + menu).

**Done when:**

- A throwaway static page and a throwaway Vite app load in a tab, and their
  HMR works.
- The tab drags between panes and workspaces without reloading. The test
  page counts its own loads.
- Every overlay of kururu's swaps to the placeholder.
- `C-a` reaches kururu from inside the page.
- The test page's attempts on `:7717/ws`, `/api/health`, `:7800` and `:5173`
  all fail. In a browser outside kururu the same page succeeds, which shows
  the block is what stopped them.
- A restart brings the tab back unloaded until it is shown.

**Test** with the desktop app driven hidden ([testing by hand](../testing.md#testing-by-hand)) on an
[isolated instance](../testing.md#the-isolated-instance), never the user's
window, apps or agents.

### Phase 1: marking, and the bundle to Kuru's box

**Build:**

- freeze, the snapshot list, the hit-test (pure, in `shared/`), the four tools
- pins, the tray, comments with dictation
- main's per-mark facts, with ranked and uniqueness-checked selectors
- the console and network ring buffer
- `POST /api/marks` and the folder; `marks.md`, `marks.json`, crops and frames
- the message, into Kuru's box
- the `mark`/`marks` chips in the box

**Pure and tested:**

- the hit-test
- the selector ranking
- the label and the message's grammar, read back by `chips.ts`
- the redaction
- `marks.md`'s writer

**Done when:**

- Three marks of different kinds on the throwaway app produce a folder whose
  `marks.md` a stand-in agent can act on, and a box with three chips.
- A `type=password` value, a `?token=` query and an `Authorization`-looking
  attribute appear nowhere in the folder.

### Phase 2: the source

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

### Phase 3: to an agent, to a card, and the chips everywhere

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

### Phase 4: agents see the page

**Build:**

- `/mcp/browser` and its four tools
- `browser_act` behind the per-workspace switch
- the agents' own partition for tabs they open
- the launch flags beside `/mcp/web`'s
- the `resolve` drawn on the pin

**Done when:** a stand-in MCP client lists tabs, reads a screenshot path and
the console, and resolves a mark, which the tray then shows. `browser_act` is
refused with the switch off.

### Phase 5 (optional): a CDP endpoint for one tab

Only if agents want Playwright MCP's or chrome-devtools-mcp's full toolset on
the user's tab rather than kururu's four tools.

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

### Phase 6 (optional): iPad + Pencil

Below.

## Optional: the iPad and Apple Pencil

**What it would be:**

- **On the iPad,** the web client shows the browser tab's placeholder, plus a
  **Mark from the Mac** button.
- **On the Mac,** the server asks the Mac window for a frozen frame, the same
  capture as phase 1, with the snapshot list. The view must exist in the
  Mac's main, though not necessarily on screen; `capturePage` with
  `stayHidden` and VS Code's show-for-a-moment retry.
- **Back on the iPad,** the frame comes up full screen with phase 1's marking
  surface.
- **The Pencil draws:**
  - `pointerType === "pen"` only, so a palm or a finger scrolls and never
    marks
  - `touch-action: none` on the canvas
  - `getCoalescedEvents()` for smooth lines (Safari 18.2+)
  - `preventDefault` on `touchmove` so Scribble does not take the stroke
- **A circle or a scribble** resolves to elements by its bounding box against
  the snapshot. A tap with the Pencil is the element tool. The comment is the
  same `ChipField`, so typing, dictation or Scribble into the field all work.
- **Send** posts the set to the server, and the Mac's main is asked for the
  per-mark facts by `backendNodeId`. The page may have moved since the
  freeze, so facts the snapshot already holds (box, text, tag) are taken from
  it, and the live ones (styles, source) are marked as read after the freeze.

**Cost.** About S–M once phase 1 exists, because the marking surface is
already a web component working on a picture. What is new:

- pen input and stroke smoothing (some 200 lines, and the Safari quirks)
- one server-to-window request for a frame
- the iPad layout of the surface

Before phase 1 it is not worth starting.

**A live page on the iPad** is possible and not worth it now.

- **A screencast** (`Page.startScreencast` with taps forwarded) reports about
  100 ms a frame and 10–30 fps. That is enough to point, but not to scroll or
  type comfortably, and the Mac's view has to keep painting. M–L.
- **A proxied iframe** brings back every problem the phone was dropped for:
  `allowedDevOrigins`, `allowedHosts`, HMR through the proxy, and cookies,
  and with them logins. L.

Orca built a mobile screencast. Nothing found says how well it works.

**Verdict.** Worth it **if the user reviews on the iPad**, as phase 6 after
phase 1, the frozen frame only. A live iPad page waits for a reason.

## Risks

- **Z-order bugs are the long tail.** Every new overlay kururu adds must
  register with `overlays.ts`, or it draws under the page. A dev-mode warning
  helps: an element with `position: fixed` and a z-index above the panes'
  that is not registered.
- **The debugger can be detached** by opening DevTools on the same view
  (Electron's docs say so; a spec test says otherwise; unverified on 44).
  `browser.js` must re-attach on `detach` and say so in the tab when it
  cannot.
- **Snapshots of very large pages.** `DOMSnapshot.captureSnapshot` on a heavy
  app can be megabytes. The flat list is cut to visible elements in the
  viewport, and a freeze that takes more than a second says so.
- **Source maps lie.** That is why road 3 exists. The confidence, not the
  line, is what the agent is told to trust.
- **Electron moves.** The DOMSnapshot and Overlay domains are experimental,
  and `console-message`'s signature changed recently. The CDP calls used are
  few and kept in one file.
- **Scope creep toward Orca.** Password import, profiles, extensions, a
  download manager and a mobile screencast are all out. The browser is for
  looking at what the agents are building, and at the docs and sites that
  come up beside it.

## Questions only the user can answer

1. **Freeze-then-mark, as recommended, or live marking in the page** (Orca's
   and Cursor's way)? Freezing avoids every z-order problem and keeps kururu's
   UI out of the page. Live marking keeps hover and scroll while marking, at
   the cost of drawing kururu's UI inside somebody else's DOM.
2. **Where Send goes by default:** Kuru's box unsent (recommended, as quotes
   do), or straight to the workspace's agent?
3. **Agents and your tab:** may agents *look* at your tab (recommended:
   yes)? May they *act* in it, with your logins (recommended: a switch per
   workspace, off)? Or only in tabs of their own with no logins?
4. **Which sites:** any http(s) site (recommended, with the security above),
   or only local dev servers and an allow-list?
5. **Screenshots to the model:** a crop per mark plus the frame
   (recommended), or the frame only, or ask each time?
6. **The React hook:** on by default for localhost pages (recommended), or
   off until asked?
7. **Keeping marks:** forever like `drops/` (recommended, the folder is
   yours), or swept after some weeks?
8. **The gate, for everybody:** tighten `originOk` on loopback to kururu's own
   ports, so a dev page in *any* browser can't reach kururu? It is a server
   change (a reconnect), and it would break anything that relies on another
   loopback port reaching kururu today. That needs listing first.
9. **The iPad:** do you review on it enough that phase 6 is worth building
   after phase 1?
10. **Downloads:** refused (recommended), or saved to `~/Downloads`?

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
