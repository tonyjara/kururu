# Research notes: a browser in kururu, and marking a page up for an agent

> The plan these notes were for, [browser-annotate](browser-annotate.md), was
> dropped on 2026-11-07; the built-in browser is kept on the
> `browser-annotate` branch.

Read 2026-11-06 for [browser-annotate.md](browser-annotate.md). **No code was
changed and nothing was installed.** Three researchers read docs, READMEs and
source, using WebSearch and WebFetch; nothing needed `kururu_web`. Each claim
has its source beside it. Anything resting on marketing copy, a third-party
summary or our own inference is marked **unverified**. "Read in source" means
the file was fetched and read, not just its README.

The question had four parts:

1. What the tools that already do "point at the UI, tell the agent" capture.
2. How they hand it over.
3. How to embed a page in an Electron window safely.
4. How an agent could drive that same page.

The phone was ruled out partway through. The iPad comes back as an optional
section at the end.

**Revised the same day.** After the user answered the plan's questions (live
marking, agents acting with their logins, the iPad as a Sidecar screen, an
extension weighed), a short second round of reading went into
[§6](#6-after-the-users-answers-sidecar-the-extension-the-z-order). §5's
web-client iPad is kept for the record; the plan no longer builds it.

## 1. The tools that already do this

### Orca (stablyai/orca), the one the user named

An Electron desktop app for running Claude Code and Codex in parallel. Each
agent gets a worktree, and a Chromium browser is built in. MIT, © Lovecast Inc.
([README](https://raw.githubusercontent.com/stablyai/orca/main/README.md)).
Other products are called Orca too; this is the one with select-and-comment.
Read in source.

**How you mark.** "Design Mode" / "Grab page element" is a picker that
highlights on hover. It goes through open shadow roots and survives an iframe
loading. A separate markup tool draws on a screenshot: pen, highlight, arrow,
rectangle, ellipse, text, eraser (`markup-drawing-model.ts`).

**Many notes.** Notes collect in a tray for each page. Each has a comment,
pasted images, and an intent: `fix | change | question | approve`. The cap is
20 per page, and the 21st is refused out loud, never dropped
([v1.4.245](https://github.com/stablyai/orca/releases/tag/v1.4.245)).

**What it captures** (`src/main/browser/element-grab/browser-grab-payload.ts`):

- **Page:** URL with the query and fragment removed, title, viewport, scroll,
  DPR.
- **Element:** tag, selector, a readable path and the full DOM path, classes,
  up to 6 nearby elements, selected text, `isFixed`.
- **React and markup:** the React component chain, the source file, 200
  characters of text, 4 KB of HTML.
- **Attributes, accessibility, boxes, styles:** allow-listed attributes, role
  and accessible name, the box in the viewport and in the page, 16 computed
  styles.
- **Context:** up to 10 entries of nearby text, and the ancestors.
- **Secrets:** values are checked against secret patterns twice, once in the
  page and once in main.
- **React source:** read from `fiber._debugSource` only
  (`grab-guest-react-script.ts`). That field is gone in React 19, so on React
  19 you get names and no file.

**Handover.** `formatBrowserAnnotationsAsMarkdown` builds Markdown, and "Send
notes to…" types it into the agent you pick:

```
## Design Feedback: /pricing
**URL:** http://localhost:3000/pricing
### 1. <PricingCard> button "Buy"
**Intent:** fix
**Selector:** `…`
**Source:** src/…:42:5
**Text:** "…"
**Feedback:** …
**Images (open these files):**
- `/path/to/img.png`
```

A short form is the default. "Include page details" adds bounds, classes,
nearby elements, styles, the full path and HTML. Pictures go over as **paths
for the agent to open**. Markup drawings go through the clipboard.

**Scale.** Orca's main process has about 630 non-test files under
`src/main/browser/` (from the repo tree). That covers an agent-browser bridge,
a CDP command layer, an offscreen backend, password import and a mobile
screencast. It is a warning about how far this can grow.

### Cursor: the browser, Design Mode, Annotate

**History.**

- 2.0: Select element.
- 2.2 (Dec 2025): a Visual Editor; "click on multiple elements and describe
  changes" ([2.2](https://cursor.com/changelog/2-2)).
- 3.0: Design Mode.
- 3.7: multi-select and voice
  ([3.7](https://cursor.com/changelog/design-mode-improvements)).
- Now: called Annotate, as of 3.24.18
  ([docs](https://cursor.com/docs/agent/design-mode)).

**Selecting.**

- Click to pick. ↑/↓ before the click walk to the parent or child.
- Shift-click adds an element to the same note.
- Option-click puts an element straight into the chat.
- Dragging makes an area, which can then take Draw, Ellipse, Rectangle and
  Arrow, with ⌘Z.

**Batching.** With "Batch edits" off (the default), Return sends each note
alone. With it on, notes become **numbered pins** and the toolbar shows
"Send (n)".

**What it captures** (from the docs):

- tag, id, classes, attributes, a selector path
- 200 characters of text, size and position
- six computed styles
- for React, Vue and Svelte, the component name and stack
- a **screenshot cropped to the element or area, with the markup drawn on**

It goes into Cursor's own chat. The format isn't published. Proprietary. The
agent sees screenshots, and console logs are written to files it can grep
([browser](https://cursor.com/docs/agent/browser)). Old forum reports say it
can't select inside iframes
([forum](https://forum.cursor.com/t/browser-cannot-select-iframe-elements/141722)).

### Stagewise

**In 2025** it was a toolbar injected into the dev app, talking to an IDE
extension over a local RPC/MCP port. `DEFAULT_PORT = 5746`, probed up to 5756,
discovered by `GET /ping/stagewise`. The payload was XML (`toolbar/core/src/prompts.ts`):

```xml
<request><user_goal>…</user_goal><url>…</url>
<selected_elements><element index="1"><tag>button</tag><id>…</id><classes>…</classes>
<attributes>…</attributes><text>first 100 chars</text>
<structural_context><parent>…</parent></structural_context>
<styles>…</styles></element></selected_elements><plugin_contexts>…</plugin_contexts></request>
```

It got into Cursor by raising a **fake diagnostic and running
`composer.fixerrormessage`**, starting "Ah, sorry, it wasn't an error. The
user has submitted a change request…" (`call-cursor-agent.ts`). That shows how
closed an IDE's chat box is. Owning the input, as kururu owns the pty, matters.

**Now** it is an agentic IDE of its own under AGPLv3, and its hosted accounts
close at the end of November 2026
([README](https://raw.githubusercontent.com/stagewise-io/stagewise/main/README.md)).
Ideas only.

### React Grab and bippy (Aiden Bai, MIT)

**React Grab.** Hover and press ⌘C, drag to take several, Enter to comment.

- One line per element:
  `[<a class="…" href="#">Forgot your password?</a> in LoginForm (at components/login-form.tsx:46:19)]`
- The clipboard gets three versions: plain text, HTML, and
  `application/x-react-grab` JSON, which is
  `{version, content, entries:[{tagName, componentName, content, source, frames[], commentText}]}`
  (`utils/copy-content.ts`).
- `npx react-grab pull` blocks and prints a line of JSON for each grab. A
  shipped skill tells the agent to loop on it.
- **On Vite:** the code says *"bundlers like Vite produce unreliable
  line/column numbers from owner stacks, so we only include them for
  Next.js"*. So on Vite you get the file without a line. Read in source.

**bippy** installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React loads, which
gives fiber access in any React app, 19 included. `bippy/source` symbolicates
`_debugStack` and owner stacks through source maps
([README](https://raw.githubusercontent.com/aidenybai/bippy/main/README.md)).
This is the realistic road to React 19 source without a build step. Check its
licence file before borrowing.

### Agentation (benjitaylor/agentation)

**PolyForm Shield 1.0.0**, which is not open source and forbids competing use.
Ideas only.

**How you mark.** A React toolbar added to the app: click, select text,
⌘-click several elements, drag an area, pause animations.

**Its open schema** ([AFS 1.1](https://www.agentation.com/schema)) is the
best-specified mark record found:

- **Identity:** `elementPath`, `fullPath`, `element`, `cssClasses`,
  `attributes`.
- **Position:** `x` as % of viewport width, `y` in px from the top of the
  document (`isFixed` for the viewport instead), `boundingBox`, a `frame` path.
- **Context:** `nearbyText`, `selectedText`, `nearbyElements`,
  `reactComponents`, `sourceFile` (`path:line:col`), `computedStyles`,
  `accessibility`, `url`.
- **Feedback:** `intent`, `severity`, `status`
  (pending / acknowledged / resolved / dismissed), `resolvedBy`, and a
  `thread` of human and agent messages.

**Output** has four detail levels. The standard one:

```
## Page Feedback: /dashboard
**Viewport:** 1512x738
### 1. button.submit-btn
**Location:** `.form-container > .actions > button.submit-btn`
**Source:** src/components/FormActions.tsx:42:5
**React:** `<App> <Dashboard> <FormActions> <SubmitButton>`
**Position:** 450, 320 (120x40)
**Feedback:** Button text should say "Save" not "Submit"
```

**MCP.** `agentation-mcp` serves HTTP on :4747 with `get_all_pending`,
`acknowledge`, `resolve`, `dismiss`, `reply` and `watch_annotations`. It is
the only tool found where **the agent closes a note from its side**. Orca's
field names follow Agentation's almost exactly. That is the researcher's
observation, not something either project says.

### Build-time source attributes

**code-inspector-plugin** (MIT) is a bundler plugin for Vite, Webpack, Rspack,
esbuild, Turbopack and Mako. It writes `data-insp-path` onto every element at
build time, so it works on React 19, Vue, Svelte, Solid and Astro. It now also
starts Claude Code or Codex itself with
`[Context] I'm looking at a <Name> component located at @file#line`.

**Others.** LocatorJS, click-to-component and react-dev-inspector read
`_debugSource` at runtime, which is broken on React 19. Their babel loaders,
which add attributes, still work. Onlook (Apache-2.0) and Lovable's Visual
Edits stamp stable ids into JSX with a plugin of their own.

### Human feedback annotators

**Vercel Toolbar comments.** You drop a pin on a click or highlight text.

- **"Copy for Agents"** (2026-02-03) gives Markdown with: Page URL, Viewport,
  Selected Text, Selector (a node path), Component Tree
  (`App > Dashboard > ProjectList > DeployButton`), and the comment
  ([changelog](https://vercel.com/changelog/copy-visual-context-to-agents)).
- **MCP tools:** `list_toolbar_threads`, `get_toolbar_thread`,
  `reply_to_toolbar_thread` and `change_toolbar_thread_resolve_status`
  ([docs](https://vercel.com/docs/agent-resources/vercel-mcp/tools/toolbar.md)).
- How it re-anchors a pin isn't documented.

**BugHerd.** The pin is attached to the element and survives a rearrangement.
It captures URL, screenshot, OS, browser, resolution and selector
([bugherd](https://bugherd.com/ref/issue-tracking)).

**Marker.io.** You draw on a screenshot. It records console, network and a
replay of the last ~30 s.

- **MCP:** `issue_get_context`, `issue_get_console_log`,
  `issue_get_network_request`, `issue_get_screenshot`
  ([help](https://help.marker.io/en/articles/14034657)).
- Pins on the live site are only a feature request.

**Jam.dev.** Session capture rather than pins.

- **MCP:** `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`,
  `getScreenshots`, `getFrames`, `getVideoTranscript`
  ([docs](https://jam.dev/docs/debug-a-jam/mcp)).

**Userback.** An MCP with feedback, logs and semantic search
([docs](https://docs.userback.io/docs/userback-mcp)).

**Ruttl and MarkUp.io.** Pins on a live site loaded through their own proxy.
MarkUp reportedly has trouble with Basic-Auth staging sites. **Unverified.**

**Velt's anchors** are the best-documented way of keeping a pin on its
element. `TargetElement` stores `xpath`, `fXpath` and `cfXpath`, plus
**`topPercentage` / `leftPercentage` of the element's box**, which is what
keeps a pin in place through a reflow
([types](https://app.unpkg.com/@veltdev/sdk@5.0.2-beta.7/files/app/models/data/target-element.data.model.d.ts)).
The newer `anchor` record ranks XPaths by stability: an attribute-based
`robustXPath` first and positional last. It adds an MD5 content hash and a
confidence score, 90+ for a unique id
([anchor-record](https://app.unpkg.com/@veltdev/sdk@6.0.0-beta.14/files/app/models/data/anchor-record.data.model.d.ts)).

### Others

**Windsurf / Devin Previews.** "Send element" and console errors go into
Cascade as @-mentions ([docs](https://docs.windsurf.com/windsurf/previews)).

**Claude Code desktop's Browser pane.** ⌘⇧S selects an element, and
`.claude/launch.json` configures the pane
([docs](https://code.claude.com/docs/en/desktop)). A blog says it attaches a
selector and a screenshot of the element. **Unverified.**

**v0 Design Mode and Lovable Visual Edits.** Hosted only.

## 2. What matters to an agent, in order

Synthesised from everything above:

1. **The user's words, per mark**, and the intent where there is one.
2. **Source `file:line` and the component chain.** This turns a search into a
   jump. There are three roads:
   - `_debugSource`: dead on React 19.
   - The DevTools hook, then `_debugStack`, then source maps: works on 19.
     Lines are trusted on Next, while Vite gives the file and a doubtful line.
   - Build-time attributes: exact, but a change to the project.

   So try them best first and fall back to "component name only".
3. **A selector to grep for, and the visible text.** Agentation's argument is
   that `.sidebar > button.primary` is enough to find the code when there is
   no source.
4. **A cropped screenshot with the marks drawn on it.** Cursor and Orca both
   send one, and the models read pictures.
5. **URL and viewport.** Styles and the HTML snippet help diagnose but cost
   tokens. Orca moved them behind a checkbox.
6. **Secret hygiene.** Strip the query and fragment, allow-list attributes,
   redact twice. Page DOM is untrusted and can be large.

**Handover patterns:**

- Markdown typed into the agent's input: Orca, Cursor, Agentation's copy.
- **Pictures as paths** the agent opens: Orca.
- The clipboard plus a structured MIME type, or a pull loop: React Grab.
- An MCP with pending / acknowledge / resolve / reply: Agentation, Vercel.
- Injecting into an IDE's chat: Stagewise's hack, and the case for owning the
  input.

## 3. Agent-driven browsers

**Chrome DevTools MCP.**
([tools](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md),
[config](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md))

- **Snapshot and actions:** `take_snapshot` gives an a11y tree with `uid`s.
  `click`, `fill`, `hover`, `drag`, `get_css_styles`,
  `take_screenshot {uid?, fullPage, filePath}` and `evaluate_script` work on
  those uids.
- **Console, network, performance:** `list_console_messages` (source-mapped)
  and `list_network_requests`, plus performance traces and Lighthouse.
- **How it attaches:** `--browserUrl http://127.0.0.1:9222`, or
  `--wsEndpoint ws://…/devtools/browser/<id>` with `--wsHeaders` (the headers
  work only with `--wsEndpoint`), or `--autoConnect` (Chrome 144+, with a
  dialog).
- **Token design:** "Reference over Value", so heavy things go to files.
  `--slim` is 3 tools.
- **Electron:** only Chrome is supported. Openwork pointed it at an Electron
  app's debugging port
  ([PR #1671](https://github.com/different-ai/openwork/pull/1671)).

**Playwright MCP.** ([README](https://github.com/microsoft/playwright-mcp))

- **Snapshot:** an ARIA snapshot with refs. `--snapshot-boxes` adds
  `[box=x,y,w,h]`, and `browser_find` greps the snapshot.
- **Every `target` takes "an exact element reference … or a unique element
  selector"**, so a selector the user marked goes straight into `browser_click`
  or `browser_take_screenshot`. This is the cleanest handover found.
- **How it attaches:** `--cdp-endpoint` with `--cdp-header`.
- **`browser_annotate`** (under `--caps=devtools`) is the reverse direction:
  the agent asks a person to annotate. It returns
  `{x, y, width, height}: text` per rectangle, an annotated PNG and the ARIA
  snapshot
  ([devtools.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/backend/devtools.ts)).
  That is the strongest prior art for **a picture paired with refs an agent can
  act on**.

**Vercel agent-browser.** A CLI.
([README](https://github.com/vercel-labs/agent-browser),
[CDP mode](https://agent-browser.dev/cdp-mode))

- `snapshot -i` gives refs like `[ref=e1]`. A click fails when the element is
  covered.
- **Attaching:** `--cdp`, `--auto-connect` (reads `DevToolsActivePort`), and
  `--pin-tab` to keep one tab per session.
- **Electron:** its skill drives apps with `--remote-debugging-port`
  ([skill](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/electron/SKILL.md)).

**Browser MCP.** A Chrome extension that is "a thin `chrome.debugger` relay",
loopback only, paired by a six-digit code
([repo](https://github.com/BrowserMCP/mcp)).

**`--remote-debugging-port` on Electron** has no auth and exposes every
renderer. For kururu that would include its own window, which holds the token.
How to switch it on varies by version. **Unverified.**

## 4. Embedding a page in Electron

**Version.** kururu is on Electron 44.3.0 (`desktop/package.json`). The
release schedule lists 44 as M152, stable 2026-08-24
([schedule](https://releases.electronjs.org/schedule)). The OSR tutorial's
examples cite v45.2.3, so 45 may be current. **Unverified.**

**`<webview>`.** Electron "do[es] not recommend" it
([web-embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)). It
paints in the DOM, so overlays work. But moving the element **creates a new
guest** (`web-view-impl.ts`), and that breaks kururu's rule that what a pane
holds is moved, never rebuilt. Whether the page fully reloads is **unverified;
assume so.**

**iframe.** It can't show a site that forbids framing without a proxy in
between. It has no CDP handle of its own, and in a window at `127.0.0.1:7717`
a dev server at `localhost:3000` is cross-site, so SameSite cookies, and with
them logins, break.

**`WebContentsView`** is the recommended way
([WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[View](https://www.electronjs.org/docs/latest/api/view)).

- **Placement:** created in main and placed with `contentView.addChildView`
  and `setBounds`.
- **Moving:** within a window by `setBounds`, with no reload; to another
  window by remove and add.
- **One view per webContents:** a webContents is shown in one view at a time,
  and an existing one can be passed into a new view.

**The catch is z-order.** The view is drawn above the whole renderer DOM, and
no z-index changes that ([#15899](https://github.com/electron/electron/issues/15899)).

**How VS Code's integrated browser copes**
([architecture](https://raw.githubusercontent.com/microsoft/vscode/main/.github/skills/integrated-browser/SKILL.md),
[overlayManager.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/browserView/electron-browser/overlayManager.ts),
[webContentsViewHost.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/browserView/electron-browser/webContentsViewHost.ts)):

- It watches a list of overlay classes (menus, quick input, hovers, dialogs,
  notifications) with live collections and MutationObservers.
- It intersects each overlay's rect with the browser container and hit-tests
  the centre with `elementFromPoint`.
- When an overlay really paints there, it puts a JPEG (q80) of the page in the
  container's background and hides the view a frame later.
- The placeholder is refreshed every 1 s while visible.
- A container moved by a transform (a drag) hides the page rather than moving
  it.

**Other ways around the z-order:**

- **A window or view on top:** brittle, since the ordering changed between
  Electron 30 and 31.
- **Offscreen rendering into a canvas** (LankfordAI/omp-ui
  [#521](https://github.com/LankfordAI/omp-ui/issues/521)): costs a JPEG encode
  per frame (about 3.7 ms at 1280×800) plus handling input and IME by hand.
  kururu has just got rid of a costly render loop (`frames.ts`), which argues
  against it.

**Keys.** A click sends focus into the view's process. Use
`before-input-event` in main to take back kururu's prefix and ⌘ shortcuts.
VS Code also keeps a tiny isolated-world preload that decides which keys the
page keeps.

**Zoom.** Chromium's zoom is per origin, so reapply it on `did-navigate`.
`setVisualZoomLevelLimits(1, 3)` turns pinch on.

### Guest security

([security checklist](https://www.electronjs.org/docs/latest/tutorial/security),
[session](https://www.electronjs.org/docs/latest/api/session))

**webPreferences.** `sandbox`, `contextIsolation`, no `nodeIntegration`, no
`webviewTag`, `webSecurity` left on.

**Its own session.** `persist:` for a session kept on disk, an in-memory
partition otherwise. Never `defaultSession`: kururu's `desktop/main.js` strips
`X-Frame-Options` and **all** of `Content-Security-Policy` from every response
on `defaultSession`, for the old iframe preview.

**Electron grants every permission unless a handler says otherwise.** Deny by
default in:

- `setPermissionRequestHandler` and `setPermissionCheckHandler`, including the
  newer `local-network`, `loopback-network` and `local-network-access` types
- `setDevicePermissionHandler`
- `setDisplayMediaRequestHandler`

**Downloads, popups, navigation.**

- **Downloads:** stop `will-download`, or save to a chosen folder.
- **Popups:** `setWindowOpenHandler` returns `deny` and opens the URL as a new
  tab, or externally after parsing it as http(s). VS Code allows one popup per
  gesture within 1 s.
- **Navigation:** `will-navigate`, `will-frame-navigate` and `will-redirect`
  allow only `http:`, `https:` and `about:blank`.
- **`webRequest.onBeforeRequest` too:** a CDP `Page.navigate` skips
  `will-navigate` (omp-ui's reasoning, **unverified**).

**Loopback to loopback is not covered by Chrome's Local Network Access**
([LNA](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)).
A page at `localhost:3000` can reach `127.0.0.1:7717`, and only kururu's own
gate stands between the two. See the plan's security section for what that gate
lets through today.

### CDP from main

([debugger](https://www.electronjs.org/docs/latest/api/debugger))

**The API.** `webContents.debugger.attach('1.3')`,
`sendCommand(method, params, sessionId)`, and the `message` and `detach`
events.

**DevTools.** The docs still say opening DevTools detaches the debugger. A
spec test says the reverse ("doesn't disconnect an active devtools session").
omp-ui saw independent attaches on 43.2. **Unverified on 44; handle `detach`
and re-attach.**

**Pickers without writing into the page's DOM** (the Overlay domain is
**experimental**,
[Overlay.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Overlay.pdl)):

- `Overlay.setInspectMode({mode:'searchForNode'})` draws DevTools' own
  highlight and reports `Overlay.inspectNodeRequested {backendNodeId}`.
- `mode:'captureAreaScreenshot'` gives a region as
  `Overlay.screenshotRequested {viewport}`.

**Reading a node.** `DOM.getNodeForLocation(x, y)` returns
`{backendNodeId, frameId}`. Then `DOM.describeNode`, `DOM.getBoxModel` and
`CSS.getComputedStyleForNode`
([DOM.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl)).
`DOMSnapshot.captureSnapshot` gives the layout rect of every node in one call.

**Code of our own in the page.**

- `Page.addScriptToEvaluateOnNewDocument({source, worldName, runImmediately})`
  runs before the page's own scripts. With a `worldName` it runs in an
  isolated world; without one, in the page's world.
- `Runtime.addBinding({name, executionContextName})` is a function only that
  world can see, arriving in main as `Runtime.bindingCalled`. That is
  puppeteer's IsolatedWorld pattern, and it needs no preload or IPC.
- An isolated world shares the DOM, so anything drawn there can be seen and
  changed by the page.

**Capture.** `Runtime.consoleAPICalled` / `exceptionThrown`, `Log.entryAdded`,
`Network.*`, `Page.startScreencast`. The `console-message` event on a
webContents is now a single details object.

**Screenshots.**

- **`capturePage(rect?, {stayHidden})`:** fast and viewport-only. It can fail
  on a hidden view; VS Code shows the view for a moment and retries five times
  on `UnknownVizError`.
- **CDP `Page.captureScreenshot({clip:{…,scale}, captureBeyondViewport})`:**
  for full pages and clipped crops. VS Code caps the long side at about
  2576 px.

### A CDP endpoint for one page and nothing else

**Two working ports exist.**

- **Playwright's extension relay**
  ([`cdpRelay.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelay.ts),
  [`browserModel.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/browserModel.ts)):
  - one WebSocket at `/cdp/<uuid>` and a 404 for everything else, one client
  - a canned `Browser.getVersion`
  - `Target.setAutoAttach` that attaches only its own tabs under synthetic
    session ids
  - everything else forwarded to `chrome.debugger.sendCommand`

  `webContents.debugger` has the same shape, so it should port nearly line for
  line.
- **VS Code's `BrowserViewGroup`**
  ([browserViewGroup.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/browserView/electron-main/browserViewGroup.ts),
  [browserViewDebugger.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/browserView/electron-main/browserViewDebugger.ts))
  makes a set of views look like one browser to Playwright.
  - It answers `Emulation.setDeviceMetricsOverride` itself, because forwarding
    it "crashes Electron in some circumstances".
  - It cancels JS dialogs.

**What puppeteer-core needs from such a bridge** (omp-ui
[#522](https://github.com/LankfordAI/omp-ui/issues/522), tested on Electron
43.2):

- `GET /json/version` with `webSocketDebuggerUrl` and a real `User-Agent`.
- `Target.getBrowserContexts` answered with `[]`.
- A synthetic browser target, then the tab, then the page.
- `attachedToTarget` sent **before** the reply to `setAutoAttach`, or
  `pages()` comes back empty.

**Never forward these:**

- `Target.closeTarget` and `Page.close`: they destroy the webContents.
- `Browser.close`: it **quits the app**.

**Access.** omp-ui binds 127.0.0.1, checks `Host` exactly, refuses any
`Origin`, puts a 256-bit token in the path, and caps clients at 8.

### React source on React 19

**What changed.** React 19 removed `_debugSource`. Fibers now carry
`_debugStack` and owner stacks, and `captureOwnerStack()` is public. All of it
exists in development builds only.

**In kururu's pane, with no change to the project:**

- Install the DevTools hook in **the page's own world** before React loads,
  with `addScriptToEvaluateOnNewDocument` and no `worldName`, because the hook
  has to be where React looks for it.
- Walk the fiber of a marked node.
- Symbolicate its `_debugStack` through the dev server's source maps.

**Where it works.** Vite and Next dev. RN-web and Server Components are
**unverified**. React Grab's own warning about Vite's lines still applies, so
the result should be checked against the file on disk (the plan does this).

## 5. iPad and Apple Pencil (optional)

**Pencil in iPadOS Safari.**

- **Pointer events:** `pointerType: "pen"`, `pressure`, `tiltX/Y`,
  `altitudeAngle` and `azimuthAngle`.
- **Coalesced and predicted events:** `getCoalescedEvents()` and
  `getPredictedEvents()` arrived in Safari 18.2
  ([WebKit](https://webkit.org/blog/16301/webkit-features-in-safari-18-2/)).
  Flutter found the coalesced events lacking `pointerId` and `target`.
- **Rate:** plain `pointermove` already runs at about 240 Hz.
- **Palm rejection:** draw only on `pen`, ignore `touch`, and set
  `touch-action: none`.
- **Scribble:** it can take pen strokes near inputs. Call `preventDefault` on
  `touchmove` over the canvas
  ([forum](https://developer.apple.com/forums/thread/662874),
  [WebKit 217430](https://bugs.webkit.org/show_bug.cgi?id=217430)).
- **Hover:** it arrives as pointer events with no tilt; `twist` is always 0
  ([WebKit 296943](https://bugs.webkit.org/show_bug.cgi?id=296943)).
- **Cost:** low.

**Drawing on a frozen frame.**

- **Capture:** the Mac takes `Page.captureScreenshot` and
  `DOMSnapshot.captureSnapshot` together, with the scroll and DPR.
- **Draw:** the iPad draws over the picture.
- **Resolve:** the Mac turns each stroke's box into elements by intersecting it
  with the snapshot's rects. Nothing is live, so feasibility is high.
- **Cost:** moderate, and mostly the same work as the desktop's own marking
  (see the plan).

**A live page on the iPad.**

- **A screencast:** `Page.startScreencast` (experimental, flow-controlled by
  acks) to the iPad, with taps sent back through `Input.dispatch*Event`.
  - Reports put it around 100 ms a frame and 10–30 fps
    ([report](https://github.com/azfarh95/sentinel-stack-public/releases/tag/v3.4.0)),
    which is enough to steer but not to scroll or type comfortably.
  - The Mac's view must keep painting.
  - Orca has a mobile screencast of its browser (`mobile/src/browser/`, from
    the tree; its quality was not tried).
- **A proxied iframe:** brings back everything dropped with the phone. Next's
  `allowedDevOrigins` and Vite's `allowedHosts` refuse it, HMR has to be
  proxied, and cookies, and with them logins, break. Cost: high.

## 6. After the user's answers: Sidecar, the extension, the z-order

A second, shorter round, read 2026-11-06 after the user chose live marking,
agents acting with their logins, Sidecar for the iPad, and asked for an honest
look at a browser extension. Web searches only; nothing was installed or
tried. Several answers came from search summaries rather than the page
itself, and are marked so.

### Live marking and the z-order

**Orca uses `<webview>`.** Its tabs are guests managed by a `BrowserManager`
in main, and Design Mode injects a guest script that draws the hover box
inside the page (per a DeepWiki summary of the repo, **unverified** beyond the
file names read in §1). A `<webview>` paints in the renderer's DOM, so Orca's
own UI can sit over it; that is the ease kururu gives up by choosing
`WebContentsView`, whose moves do not reload.

**A transparent view stacked on the page is possible.** A `View` has
`setBackgroundColor`, and `#00000000` with a transparent `body` lets the view
below show through; children added later are drawn above earlier ones
([View](https://www.electronjs.org/docs/latest/api/view),
[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view);
the stacking order from a search summary, **unverified on 44**). A
`WebContentsView` has no per-pixel click-through (`setIgnoreMouseEvents` is a
window's), so it takes every event in its bounds. §4 already notes that the
ordering of views on top changed between Electron 30 and 31.

**The in-page layer.** What the plan uses, from the platform's own docs:

- An element shown with the Popover API is in the **top layer**, above every
  `z-index` in the document; a later top-layer element goes above it
  ([Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API)).
- A **closed** shadow root is not reachable through `element.shadowRoot`;
  constructed stylesheets (`adoptedStyleSheets`) style it without a `<style>`
  element.
- An isolated world shares the DOM and has its own JavaScript globals (§4).
  Event listeners on one target run in the order they were added, whichever
  world added them; a capture listener on `window` runs before listeners on
  the page's elements.

### Moving a view to another window

Removing a `WebContentsView` from one window's `contentView` and adding it to
another's keeps its `webContents`: no reload, its JavaScript state and its
connections intact. Bounds must be set again for the new window, and adding a
view can move keyboard focus to it (search summary citing Electron issues;
**unverified on 44**, and phase 2's done tests it). The Electron docs already
say a `webContents` is shown in one view at a time (§4).

### Sidecar and the Pencil

- With the iPad as a Sidecar display, **the Apple Pencil is the Mac's
  pointer**: a tap clicks, a press and drag drags, and pro apps get pressure
  and tilt because Sidecar sends macOS tablet events
  ([Apple: Sidecar](https://support.apple.com/HT210380); the tablet-event
  detail from search summaries, **unverified**).
- **Fingers do not click;** they scroll with two fingers and do the system's
  three-finger gestures (Apple's Sidecar article, as recalled and summarised;
  **unverified** in this round).
- **The sidebar** puts ⌘, ⌥, ⌃, ⇧ and undo on the iPad's edge; **double-tap**
  on a Pencil 2 or Pro is passed to apps that support it, a setting under
  Displays.
- **Hover** on M2-and-later iPads with a hover-capable Pencil may move the
  Mac's pointer before the tip touches; one summary says so, nothing
  authoritative was found. **Unverified;** the plan does not rely on it.
- **Chromium on macOS** turns tablet events into Pointer Events with
  `pointerType "pen"` and real `pressure` for Wacom tablets (search summary;
  the [pen tracker](https://patrickhlauke.github.io/pen-tracker/) is the test).
  Whether Sidecar's events take the same road in Electron's Chromium is
  **unverified**.
- **Scribble** is an iPadOS text-input feature; nothing found says it writes
  into a Mac's text fields under Sidecar. **Unverified;** assume not.

### A browser extension

**Chrome, MV3.**

- **Content scripts** run in an isolated world; `scripting` can also register
  a script in the page's own world (`world: "MAIN"`) at `document_start`
  ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)).
- **The side panel** is an extension page beside the tab
  ([sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- **`tabs.captureVisibleTab`** screenshots the visible area of the active tab
  only ([tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)).
- **Talking to localhost.** A service worker with `host_permissions` for
  loopback can `fetch` it without CORS getting in the way; the request's
  `Origin` is `chrome-extension://<id>`. Whether Local Network Access asks
  first is unclear: summaries disagree, one saying a worker cannot raise the
  prompt and must be preceded by a request from a document
  ([LNA](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)).
  **Unverified.**
- **`chrome.debugger`** gives full CDP on a tab, and Chrome shows a
  "‹extension› started debugging this browser" infobar while attached, which
  no API hides; only launching Chrome with `--silent-debugger-extension-api`
  does
  ([debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger);
  the flag from several summaries and forum posts).
- **Prior art for pairing:** Browser MCP pairs its extension by a six-digit
  code (§3); Playwright MCP's extension relay forwards to
  `chrome.debugger.sendCommand` (§4).
- **Agents in the user's real Chrome without an extension:**
  chrome-devtools-mcp's `--autoConnect` (Chrome 144+, with a dialog), §3.

**Safari.**

- A Safari Web Extension ships only inside a containing Mac app, as an app
  extension. Outside the App Store the app must be Developer ID signed and
  notarized, and the user enables the extension in Safari's settings and
  grants it sites
  ([Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions);
  the Developer ID detail from a summary, **unverified**).
- **No debugger API.** Nothing in Safari's extension APIs drives a page the
  way CDP does.
- **`browser.runtime.sendNativeMessage`** from the extension's background
  reaches the containing app's extension handler (`NSExtensionRequestHandling`);
  the application id argument is ignored.

### Google sign-in in an embedded browser

Google refuses OAuth sign-in from embedded browsers and webviews ("This
browser or app may not be secure", `disallowed_useragent`), and changing the
user agent is reported not to get round it
([Google, 2021](https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint-in-embedded-webviews.html);
Electron specifics from summaries and issue threads, **unverified for
`WebContentsView` on 44**). For kururu this means a dev app whose login is
"Sign in with Google" may not be usable logged-in in the built-in browser, and
it is the strongest argument for the extension as a complement.
