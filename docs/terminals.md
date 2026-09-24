# Terminals

The emulator lifecycle, the size policy, the backlog, and the cursor. This is
the part of kururu that has been wrong the most times, and every rule here is a
bug that cost an afternoon.

## The pool

An emulator is **pooled by agent id** (`web/src/terminals.ts`) and lives as long
as its terminal does — twelve, LRU, never one that is on screen. A hidden tab
keeps being fed off screen and comes back with its screen, its scrollback and
its scroll position.

**Nothing in the client rebuilds an emulator during ordinary navigation.** A
pane renders an empty mount and the pooled element is moved into it, which means
React must never render that element as a child of anything — it would remove it
on the next commit.

**Never unmount a terminal because the layout changed.** Panes are a flat, keyed
list of absolutely-positioned boxes (`Panes.tsx`), so a rearrangement is a change
of four CSS percentages and React moves the existing DOM node. They were nested
flex boxes once and that is exactly how this rule got broken: React reconciles by
position, so restructuring the tree rebuilt the pane, the emulator inside came
back empty, and — because the *set* of visible terminals had not changed —
nothing asked for the history to refill it. Dragging a pane aside made its agent
vanish until it happened to repaint.

## No GPU context in a pane

This turned the whole window black, twice, and is why the renderer was replaced
rather than patched.

xterm.js drew on WebGL and `dispose()` did not release the context — neither the
addon nor xterm's core called `loseContext` — so it stayed live until Chromium
collected the canvas, which can be never. A page gets about sixteen. Past
sixteen the browser does not refuse the new context, it kills the **oldest**, and
the oldest was never a corpse: it was the pane you had open longest. Every
terminal you were watching went dark at once, for the three seconds the addon
waited on a restore that was not coming, and came back slower on the DOM
renderer — with nothing wrong on the server and the agents a process away.

`ghostty-web` renders to a 2D canvas (`getContext("2d")` is the only context call
in the bundle), so there is no budget to run out of. **Do not reintroduce a
GPU-backed renderer for a pane.** The thing to keep is the property, not the
library.

## The size policy

**The pty follows the pane, but only the server may say which pane.** The pooled
emulator measures its box and *proposes* a grid; `index.ts` keeps a proposal per
client, takes the **smallest** over the clients that can see the terminal
(tmux's `window-size`, in `server/src/sizing.ts` — pure and tested, because it is
the one decision in there), resizes the screen and the pty once, and tells every
client the grid to draw at. The emulator resizes when it is told and at no other
time; `fit()` is never called.

It was the other way round once: a pane fitted itself and informed the pty
afterwards, so the size was whichever client resized last — fine with one window,
and why a phone made the desktop ragged. The deeper cost was a client and the pty
holding two ideas of where a row ends, which is the disagreement every borked
screen turns out to be.

A proposal is withdrawn by a `watch` that stops listing the terminal as visible —
the same message that already says what a human can see — so a warm client never
has a vote and a terminal nobody can see keeps its shape.

**A socket is not a screen, and `looking` is the difference.** A phone that locks
keeps every pane it had and keeps its connection — a sleeping one is deliberately
never hung up on, and nothing pings — so it went on voting for a grid in a
pocket, and the desktop stayed at phone width until that socket happened to die.
Walking back to the window did not undo it either: nothing there had moved, so no
`ResizeObserver` fired and no pane proposed anything. `visibilitychange` now says
so in both directions (`web/src/terminals.ts` owns the listener, because the vote
it gates is the pool's). Going away stops this client's proposals *counting* —
they are kept, so coming back is one message and not a round of re-measuring —
and coming back also re-proposes every attached emulator, which is the half a
returning window cannot get from its boxes. Visibility rather than focus: a
window behind another app is one somebody can read.

It stops at the size. `watching` is still the only thing the unread mark and the
notification gate consult, because a frozen page cannot draw a card — it would
queue them and raise the lot on unlock. Reaching a phone with its screen off is
push's job ([notifications](notifications.md)).

Never clamp a pane to a fixed grid: the program inside genuinely redraws at the
size of the box it is in, and that is the whole difference between a terminal and
a picture of one.

### Measurement

- **Nothing is subscribed, and nothing proposed, until the measurement is the
  pane's.** A bad measurement taken the frame after a split — or before the
  renderer has measured a character — is a SIGWINCH into a shape no box has. A
  *detached* pooled element is the same question: it reports no width, the
  measurement is refused, and the emulator keeps the shape it was last *told*.
- **A measurement that is merely small is how the fit addon says it failed.**
  xterm's `proposeDimensions()` returned `undefined` for a box it could not
  measure, so "did it answer" was the whole test. Ghostty's does the same
  arithmetic and ends it `Math.max(2, …)` by `Math.max(1, …)` — so an unlaid-out
  pane does not decline, it answers **2x1**, which is finite, positive and passes
  every check the old guard made. A pane is exactly that shape for a frame or two
  each time one is dragged. Because the policy is a *minimum*, one unlaid-out
  pane would hold every other client watching that agent down to two columns.
  `web/src/grid.ts` reads the clamp floor back as what it means, and
  `web/test/grid.test.ts` holds it — the refused value is a well-formed grid, and
  an `if` with a number in it is what somebody simplifies away.
- **A size is proposed only once the box stops moving** (60ms). Nothing follows
  immediately, because the proposal ends at the pty and every resize there is a
  SIGWINCH that repaints an agent TUI completely. The two cases that skip the
  debounce are a pane *arriving* rather than moving: a first subscription and a
  reconnect.

## The backlog

`screen.ts` is a headless emulator per pty, serialized on demand into the escape
sequences that rebuild what it holds. It exists so a pane opened late is not
empty. **Do not replace it with a ring buffer of raw bytes**: trimming those to a
budget cuts a sequence in half, and a cut sequence swallows everything after it
until something resynchronises.

- **A backlog is asked for at a size, and only an emulator can ask.** A
  serialized screen is laid out at a width: reconstruct it into any other and
  every row longer than the target wraps, the rows below slide down, the top
  scrolls away — and the client and server then disagree about where everything
  is *permanently*, because an agent redraws differentially and will never resend
  a row it believes is correct. This was the borked text on a workspace switch
  and the cwd sitting inside an agent's input box; they were the same bug.
- **The answer names the shape it used.** The grid used to travel *on*
  `request-backlog`; it does not now (the server owns the size), but a screen
  that states its own shape is correct for whoever receives it, and it covers the
  one ordering a single authoritative size does not — a resize landing while a
  screen is being built. `sendBacklog` sends a second `grid` behind it.
- **`watch` produces no backlog at all.** It is a set of ids, and answering it
  meant sending a reconstruction before the emulator that would receive it had
  been laid out. Watching is the tap; rebuilding is the emulator's own question,
  and the only things that ask are a genuinely new emulator (borrowed for the
  first time, or evicted and back) or a reconnect. A tab switch and a workspace
  change ask for nothing. A pooled emulator that was off screen when the socket
  dropped is told it is `stale` and asks once a pane gives it a box.
- **Backlog then output, in that order, per client.** A client that has just
  opened a pane clears its emulator and writes the history, so live output that
  overtakes the backlog is wiped. `index.ts` holds that terminal's output in the
  client's `awaiting` queue until the backlog has gone out.
- **Two rebuilds can overlap, and the first to finish must not release the
  second's hold.** `awaiting` counts rebuilds rather than flagging them: letting
  the earlier one lift the hold sends live output ahead of the later screen,
  which wipes it on arrival, and those bytes never come again.
- **A serialized screen does not carry the cursor's *visibility*.** Applying a
  backlog resets the emulator, and ghostty-web's `reset()` frees the WASM
  terminal and builds a new one, so every mode goes back to default and the
  cursor comes back visible. The serializer restores eight modes and DECTCEM is
  not among them, while the cursor's *position* is restored faithfully — so an
  agent that hides the cursor and parks it at home would hand every newly-opened
  pane a visible cursor sitting on nothing, forever, since the sequence is sent
  once at startup. `screen.ts` appends `\x1b[?25l` when `isCursorHidden`.
- **A backlog no longer has to be *painted* again**, and it is worth knowing why
  it once did. xterm repainted only rows it believed had changed, and after a
  reset plus a reconstruction that did not cover cells the renderer still held.
  Ghostty's renderer redraws only dirty rows too — the claim that it draws the
  whole viewport is **false**; `startRenderLoop` passes `forceAll = false`. What
  saves the backlog is that replacing a whole screen dirties the whole screen.
  Anything that changes how the screen *looks* without writing to it — a palette
  swap is the one that exists — has to force the repaint itself.
- **An exited terminal's screen still reflows.** The host keeps a dead pty listed
  with its screen intact, because it cannot know whether anybody still wants to
  read it; `host.resize` skips only the pty half once `exited` is set. The buffer
  is frozen, not immutable, and there is simply no SIGWINCH to send.

## The cursor

**The cursor in Settings is the *default*; the program in the pty outranks it.**
Two sequences, and a mode change sends both: `CSI Ps SP q` (DECSCUSR) for the
shape, `OSC 12` for the colour, `OSC 112` to put it back. `applyCursor` in
`terminals.ts` resolves three answers in order of who may give them — this pane
has the keyboard or it does not, then the program if it has said, then the user.
Both program answers are **nullables beside** the setting rather than values
copied over it, because `CSI 0 SP q` and `OSC 112` hand the decision back and the
setting has to still be there to hand it back to. Two nullables rather than one
object, because a program may send either without the other.

Kururu parses the sequence off the byte stream itself (`shared/cursor.ts`) and it
is the only thing in the client that parses one. ghostty-web *does* parse it, but
the bridge will not hand it back: `getCursor()` returns `style: "block"` with a
`// TODO` beside it. The scan carries a fragment between chunks on purpose — a
pty's writes are cut wherever the read ended, and a sequence cut in half is one
nobody ever sees, because neither half matches.

`screen.ts` scans its own stream with the same parser rather than asking its
xterm (which could answer, behind an underscore). One parser over one stream
cannot disagree with itself, and the whole point of a backlog is that the two
halves agree. A backlog carries both sequences, for `\x1b[?25l`'s reason: a pane
opened ten minutes into an nvim session drew the Settings block over an editor
sitting in insert. Null means "the user's cursor", so the backlog says *nothing*
rather than saying block.

**Only the focused pane draws a cursor, and kururu arranges that itself.**
ghostty-web has no concept of focus: `renderCursor` fills a rectangle whenever
the viewport is at the bottom and the mode says visible. Tiled, that is a solid
blinking block in every pane at once. A real terminal draws a hollow box
unfocused; this renderer has no outline path, so the choice is solid or nothing,
and nothing is right because `pane-on` already says where the keyboard is going.
`setFocused` gives an unfocused emulator a cursor style the renderer does not
recognise, whose switch has no default case. **Do not "fix" this by tinting the
cursor to the background** — that draws the character onto its own colour and
erases it a second way.

**The character under a block cursor is drawn again, or it is not there.**
`renderCursor` is one `fillRect` painted over the line beneath it, so a block
cursor did not sit on a character, it replaced one — normal-mode nvim over
`hello` drew `ello` with a rectangle where the `h` was. It is easy not to notice,
because the missing letter is the one you are looking at. `cursortext.ts` wraps
`renderCursor` the way `boxdraw.ts` wraps `fillText`, and asks the pane for the
three things the renderer cannot answer: which style is *really* in force, what
the theme calls text-under-cursor, and which face the line was drawn in. Only the
block is covered, because only the block covers anything.

**The emulator's offscreen textarea must not draw a caret.** ghostty-web parks
its 1x1 keystroke/IME textarea at `position: absolute; left: 0; top: 0`, which
anchors to `.pane-body` — so it lands in the pane's top-left corner and the
browser blinks a caret there for whichever terminal holds the keyboard. Only the
focused one, which is what makes it read as a bug in the cursor work next door.
The tell is the pixels: 1 CSS px where a `bar` cursor is 2, and pure white
because `:root` sets `color-scheme: dark` and a bare textarea inherits the UA's
text colour. `.term textarea { caret-color: transparent }`. ghostty's own
`opacity: 0` is supposed to cover this and does in an isolated page, so if the
rule ever looks redundant, that is why it is not.

## Other

- **`mouse.ts`: the mouse as the program in the pty sees it.** Selection and
  reporting cannot both have the gesture. `mouseencoding.ts` exists because the
  serializer restores the mouse being *on* and loses how it speaks, and the two
  halves disagreeing types into the program.
- **`boxdraw.ts`** paints box-drawing and block glyphs to the cell, so a rule is
  unbroken whatever the font does.
- **Restyle an emulator; never rebuild one to restyle it.** The renderer's theme
  is set directly (`renderer.setTheme`) rather than through `options.theme`. The
  palette also went to the WASM terminal at construction and nothing updates it
  there — but that half only answers colour *queries*, and the renderer's copy is
  what every cell is drawn from. Rebuilding would cost every visible terminal a
  backlog and every warm one its scrollback.
- **The font setting is prepended to the built-in stack, never a replacement.**
  The stack ends in four patched Nerd Font faces so an agent TUI's devicons are
  not tofu, and somebody naming a font has not asked for those to stop working.
- **The terminal's font list is the *client's* question.** The emulator renders
  in the browser, so the face must exist on the device drawing it — and over
  Tailscale that is not the machine the agents are on. A server-side `fc-list`
  would offer a desktop's fonts to a phone. `web/src/fonts.ts` asks twice:
  `queryLocalFonts()`, hung off `pointerdown` because it needs a transient user
  activation, and a canvas measurement probe that needs no permission and works
  in Safari. Neither is complete, which is why `Custom…` opens a text box and the
  server accepts any string: what is *valid* and what is *offered* are different
  questions.
- **Killing a pty's own pid is not enough.** `zsh -l -c "claude"` does not
  necessarily exec, so the pty's pid is the shell and the agent is its child.
  Signal the group (`process.kill(-pid, …)`); node-pty opens the pty with setsid
  so the pty leader is the group leader.
