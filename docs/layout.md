# The arrangement

Profiles → workspaces → tiled panes → tabs. All of it server-owned.

**The arrangement is the server's, and the client sends verbs.** `web/` draws the
layout in the snapshot; it never holds one. A message says *split the focused
pane*, not *here is my new tree*. That is what makes a window reload cost a
repaint, what lets two clients agree, and what makes the layout worth writing to
disk. Never move a layout decision back into React state.

## Terminals, tabs and panes

- **An agent is in exactly one tab.** Not zero (it would be running with nothing
  pointing at it) and not two. `new-tab` creates one and places it in the same
  breath.
- **There is one kind of new tab, and it is a terminal.** Opening an agent was a
  second button that ran `claude` for you; it is the same pty either way and
  `procs.ts` reports what is running regardless, so the distinction was a choice
  with no difference. `PtyKind` survives because `countsAsAgent` reads it;
  nothing in the UI says `agent` any more.
- **A shell is an agent with nothing claimed about it.** Same pty, same emulator,
  same teardown. It is not counted by the quit dialog *unless* `procs.ts` finds
  an agent inside it — err towards counting, since a needless dialog costs a
  keystroke and a missed one costs a turn.
- **Making a pane opens a terminal in it.** A split, a new workspace, a new
  profile and a first launch all end in `openTerminal`, because an empty pane
  offering one button was a step that decided nothing. A split's terminal starts
  where the half you split *is*, which is why `openTerminal` takes the pane to
  read the cwd off separately from the pane the terminal lands in.
- **An empty pane is the button.** The ways to have one are restoring a layout
  and closing the last tab of a workspace's last pane, and in both there is one
  thing it can do — so the pane body itself is what you click, or Enter.
- **A new terminal starts where the last one *is*, not where it was opened.**
  `cwdForNewTab` asks the kernel for the pty's own cwd (`cwd.ts`, one `lsof`) and
  only falls back to the spawn directory. A shell is cd'd into a project within
  seconds, and a tab that landed in the spawn directory would open in `~` all
  afternoon. The ladder: the terminal this pane is showing, then the pane's
  remembered project, then the newest terminal anywhere in the workspace. This is
  the one thing that wants `pid` in the snapshot.
- **Closing a tab ends its terminal.** A tab is where a terminal lives, so this
  is not putting it away; the key is shifted (`prefix+D`) for that reason, and the
  sidebar's ✕ is the same verb. Putting one *away* is the row's other button, and
  it is a fact about the list rather than about the terminal — see below. Closing a *pane* ends everything in it. What does
  **not** end anything: switching workspace or profile, which is why those exist.
- **The host keeps an exited agent listed; the server clears it away.**
  `reapExited` in `index.ts` ends the tab and `Workspaces.reapTab` takes the pane
  with it when nothing else is in there — tmux's default, and what typing `exit`
  means everywhere else. Two refusals come with the pane half (`pruneEmptied`'s):
  never the last pane of a workspace, and never a reader. `close-tab` prunes
  the same way: closing a pane's last terminal closes the pane, and the last pane
  of a workspace stays, empty. Enter in a focused empty pane opens a terminal.
- **A pane's corner is a menu and a close button, at every width.** The splits
  were two buttons in a tiled strip and a menu on a phone, and the tell that this
  was wrong is that the reader — whose only other door is prefix+M, a key you
  have to already know — could be opened with a mouse on the phone and not on the
  desktop. `paneMenu` in `Panes.tsx` is the one list: the other panes, the two
  splits, a document, and closing this one. Two things it must keep doing. Every
  row names the pane whose corner it came from, because opening a menu does not
  move the focus and the pane you pointed at is routinely not the pane holding
  the keyboard. And the keys beside the rows are read out of the live keymap,
  for `HelpOverlay`'s reason: they are rebindable, and a printed key that is not
  the key is worse than no key printed at all.
- **Putting a row away is not closing anything.** The ✕ is the only destructive
  verb the sidebar has, and for a long time it was the only verb it had at all —
  so "I am finished looking at this one" and "I am finished with this one" were
  the same button. The ⊘ beside it now is the first: `hide-agent` takes a row out
  of the list and drops it into a drawer at the foot of it, and touches nothing
  else. The pty runs, the tab is where it was, prefix+a still finds it by name,
  and a notification it earns is still delivered — which is why the shut drawer
  carries a count and an unread mark, since something you put away is the one
  thing in this list that can no longer catch your eye on its own. It is the
  profile's, next to `agentOrder` and for the same reasons: ids of processes, so
  it rides the host's blob and `persist.ts` writes an empty list. Whether the
  drawer is *open* is the client's, because a disclosure is a thing you do with
  your eyes and a phone opening one to find something must not undo the tidying
  on the desktop.
- **The sidebar lists agents; `lastAgent` is what makes that possible.**
  Filtering on `agent` alone would drop rows every time the process poll blinked,
  and would hide every *exited* agent — whose row carries the only dismiss gesture
  there is. The test is "has one ever been seen in here".

## The board

**A tab, and the board is the workspace's, not the tab's.** It was a third
kind of pane for a version, and a pane you could not put a terminal beside in
its own strip was the thing people noticed first. Now it is `BOARD_TAB` in a
pane's `agentIds`, an id no pty can have, so every tab gesture — reorder, drag
into a pane, drop on an edge, pour — works on it with no code of its own. The
cost is that a tab is no longer always a process: `activeTerminal`,
`visibleAgents` and `terminalsOf` in `shared/layout.ts` are what anything that
kills, watches or types must go through, `removeTab` takes it out of the
workspace on screen only (every workspace's board has the same id), and a board
tab never moves to another workspace. `adoptBoardPanes` turns a blob's board
*pane* into the tab.

`Workspace.board` holds the cards, so closing the tab puts them away and
`open-board` finds them where they were. It is null until somebody opens it —
the only verb that makes one — and rides the host's blob and `persist.ts` like
the rest of the workspace, which is why none of this cost an edit to the pty
host. The doors: `C-a K` and a pane menu's **Open the board** show the one you
have or make one beside that pane; the new-tab menu's **Board** puts it *in*
that pane; a workspace row's right-click switches there and shows it. On disk a card keeps its run's history but not
its `agentId`: that is a process, and a cold start reads a run with no process
behind it as `ended`.

**The robot is `new-tab` with a prompt on the end.** `run-card` looks the
launcher up by id, exactly as the new-tab menu does, and `withPrompt` in
`shared/launchers.ts` single-quotes the card onto the command line — the one
place text somebody typed reaches `sh -c`. The agent lands in a pane *beside*
the board's (`paneBesideBoard`) rather than as a tab in it, since a new tab is
shown and would take the board away from the person pressing the robot; it is
renamed after the card, and the focus goes back to the board.

**The automation moves a card on an edge, and only out of the column it put it
in.** `noteRun` runs for every agent on every host snapshot and compares
against the state it recorded on the card, not against the last status — so a
server restart that forgot `lastStatus` still catches a run up, and a card
somebody dragged back out of Review is not dragged back in by an agent that is
still sitting at `done`. A finished turn goes to **Review**, never Done: nothing
in a byte stream tells "finished" from "asking you a question".

**Deleting a card never ends its agent.** The card is a note about the work;
the terminal is the work and has its own ✕. Nor does it remove the card's
worktree, for the same reason and one more: taking a checkout down is the Done
column's job, and a deleted card has not been through it.

### Worktrees

**A card runs in a checkout of its own, beside the repository.** Two agents in
one working tree are two agents editing each other's files, so `run-card` looks
for the repository the agent would have started in, and — unless that project
has been told not to in Settings → Workspaces — makes `<repo>.worktrees/<slug>-<id>`
with `git worktree add` on a branch `kururu/<slug>-<id>`, cut from whatever the
main tree has checked out. The agent starts in there. The naming is
`shared/projects.ts`, the git is `server/src/worktree.ts`, and the latter is
the one place kururu runs `git` at all: `git.ts` reads `HEAD` off the disk
because it polls, and this runs once, on a click, with a timeout. It never
forces anything — a branch checked out elsewhere and a directory that is not
empty are refusals git makes on purpose, and they come back as the card's error.

**The worktree is the card's, not the run's.** `Card.worktree` is four strings —
root, path, branch, base — and every one goes to disk, because the checkout is
still standing after a cold start. A second agent on the same card goes back
into the same worktree; only a card whose directory has gone gets a new one, and
if its branch survived, that branch is checked out again rather than a second
one cut beside it. A worktree that cannot be made is an error on the card, never
an agent quietly started in the main checkout: the person pressed the robot
expecting isolation.

**A worktree gets the main checkout's env files.** `worktree add` brings the
tracked files and nothing else, and `.env*` is ignored precisely so it is never
tracked — so every card's dev server came up without its keys and died. On a
fresh worktree, and again before its dev server starts (for worktrees made
before this), `copyEnvFiles` asks git for the main checkout's *ignored*
files, keeps the ones whose basename starts `.env` wherever they are in the
tree, and copies each one the worktree does not already have. Never over a
file that is there. The cost is a copy of the secrets per worktree on the same
disk, which the user chose over a `cp` in every project's setup line.

**The setup line runs in the agent's terminal, ahead of it.** A fresh worktree
holds tracked files and the env files and nothing else — no `node_modules` — and the
project's setup command (Settings → Workspaces) is prefixed onto the agent's
command with `&&`, so an install that fails leaves its output on screen and no
agent behind it. It runs on a fresh checkout only. The robot is pressed from
wherever the pane beside the board is, which may be an earlier card's worktree;
`mainRoot` resolves that back to the repository it was linked from, so the next
card is cut from `main` and not from the last card.

**A card's worktree is served as soon as it exists.** With a dev line set for
the project, `run-card` opens a second terminal beside the agent's running it
in the worktree, with `export PORT=<n>` in front and `n` a port the kernel
handed out (bind 0, read, close). It goes into the pane the last card's server
went to, so they line up as tabs of one pane, else the pane of the newest
terminal in the workspace — never the board's own — and is opened before the
agent so that in a shared pane the agent is the tab left showing. On a fresh
checkout it waits for the setup line in the agent's terminal: the agent's
command touches a marker in the temp directory after the setup succeeds, and
the server's loops until it is there (outside the worktree, because a file in
there is a change that would hold up the merge). The card keeps the terminal
as `Card.dev` — agent id and offered port, the id dropped on the way to disk —
and draws a line under the branch: the port, **open** (an href, found by the
dev-server scan as the server whose cwd is inside the worktree, the offered
port only breaking ties — vite ignores `PORT`), **log**, ↻ and ■. ↻ is
`restart-card-dev`, which ends the terminal and opens another in the same
pane, or starts one on a card that has none; ■ is `stop-card-dev`. A dev
server that exits is the one terminal `reapExited` leaves standing: a dev line
dies in its first second when it dies at all — a gitignored `.env` a worktree
does not have, a port already taken — and the screen is the only place that
said why. Any move
into Done — merged or "Just move" — ends it and closes its tab, and so does a
merge or a retire, before the directory goes. Only worktrees: in the main
checkout the dev server is the one the person already runs.

**The card's menu carries the git, so nobody opens a terminal in each
worktree.** Four rows under the moves, for a card with a worktree: **Commit
changes** (`add -A`, the card's title as the subject and its body as the
message, the person's own git identity), **Set changes aside** (`git stash
push -u`, named after the card — the row somebody looks for as "discard", and
deliberately not one: the stash is the repository's and is still in
`git stash list` after the worktree is gone), **Merge into `<base>`** (the one
card's worktree merged back and removed, the card put in Done, asked on the
card itself before it goes because it ends the agent), and **Open a terminal in
the worktree** for everything else. The menu opens at once with the rows that
need counts disabled, and `worktree-status` fills them in a moment later —
changes, ahead, behind — asked on the click and never polled, because each is a
subprocess and `git.ts` keeps subprocesses out of the loop. Merge is disabled
while anything is uncommitted; the hint says "commit first". What each action
came to is a line on the card until clicked away. Every verb names the card and
the server finds the worktree on it; no path crosses the wire.

**Done means merged.** Moving a card with a worktree into Done — by drag or by
the menu's "Move to Done" — does not move it; it asks on the card, saying how
many commits go into the base, whether anything uncommitted will be committed
first, and that the worktree, the branch and a running agent go with it. Yes is
`merge-card` (preceded by the commit row's commit when the tree is dirty), and
the server puts the card in Done only once the merge has held. **Just move**
moves it and leaves the worktree standing, for a merge that cannot happen yet;
a refusal from git is the card's error and the card stays where it was.
A card with no worktree but an agent still open asks too: **Move and end
agent**, or **Just move**, which leaves the terminal.

**A card's conversation outlives its agent.** A Claude run is started with
`--session-id` and a UUID the server minted, and the id and the directory it ran
in are kept on the run — to disk, unlike `agentId`, because they name a
transcript and not a process. Once the agent's terminal has gone the robot's
menu leads with **Resume conversation**: `claude --resume <id>` in that
directory, or in the main checkout when a merge took the worktree down (Claude
files transcripts by directory, so from there finding it is Claude's call).
Codex picks its own ids and never says them, so its row opens `codex resume`'s
picker instead, with `--all` when the directory is gone. Runs from before this
have no id and no row.

**Switching worktrees off retires the ones standing, and asks first.** The
switch in Settings → Workspaces is the one control on that page that does
anything to the disk: with worktrees still standing for the repository, it
draws the list — branch, base, card, whether an agent is in it — and waits for
a second click, in the page rather than in a dialog over it, the way deleting a
profile asks. `retire-worktrees` then walks every card in the profile whose
worktree is in that repository, one at a time because they all land on the same
branch: rebase onto the base in the worktree, fast-forward the base from the
main tree (`merge --ff-only` when it is on the base, a fetch of the repository
into itself when it is not), `worktree remove`, `branch -d`. Nothing is forced.
A worktree with uncommitted or untracked work is left standing with its agent
still running — that check is made before anything is ended — and a rebase
that conflicts is aborted and reported; every other card's agent is ended the
way `close-tab` ends one, since its directory is about to go. The reply is a
row per card, and the page shows each row: how many commits the base took, or
why the worktree is still there. A card whose worktree went forgets it.

**The main tree has a say, and it is asked first.** `merge --ff-only` refuses
when the base's own checkout has uncommitted work in a file the branch
changes — but only at the merge, after the agent is ended and the branch
rebased. `mergeBlock` in `worktree.ts` puts the same question before anything
is ended, from `git status` there against the branch's diff since it forked,
and `merge-card` answers with a `MergeBlock` rather than an error: the files
in the way, any untracked file the branch would create, and whether the two
sets of changes fit, asked of `git merge-tree` on a commit `stash create`
makes without touching the tree. The card shows the block in place with two
ways through when the dry run was clean — commit everything on the base as a
`wip:` commit and rebase the card over it, or `git merge --autostash` around
the fast-forward — each with a sentence on what it does, and a second
`merge-card` carries the choice as `resolve`. A dry run that conflicted, or
an untracked collision, is shown with neither, because both would land in the
same conflict and the stash one in a worse place: an autostash that does not
apply back leaves the tree with conflict markers and the original in the
stash, which is the one outcome `retireWorktree` has to report as a `note`
after a merge that went through. The sweep gets the same block as a message
on the card's row.

**Project settings are keyed by repository, not workspace.** A workspace once
remembered a dev command and it went with the sidebar's dev buttons: that was a
fact *watched* off the process table. These are three things somebody typed
about a project — worktrees or not, the setup line, the dev line — and two
workspaces on one checkout want the same answers. `~/.config/kururu/projects.json`,
by root. The page is drawn the other way round — Settings → Workspaces, a
sub-tab per workspace in the profile, opening on the one you are in — because
the workspace is the list a person has in their head and a stacked page is one
you scroll to the wrong project. Under the tab is the repository the branch poll
found for that workspace, and two workspaces in one repository show the same
controls and say whose else they are. `set-project` refuses any root that is
not one of those, on `files.ts`'s rule that a path never comes from a client.
An entry at the defaults is not written.

## Dragging

- **A pane a drag emptied is closed; a pane you emptied on purpose is not.** A
  pane whose last tab was just dragged out is a gap, not a place. A fresh split is
  deliberately empty and must survive — which is why `pruneEmptied` takes the
  source pane of one move rather than sweeping the tree.
- **A swap is not a move-and-split.** Two panes trading places touches two leaves;
  doing it by removing one and splitting the other rebuilds the tree around them
  and changes ratios nobody asked about. `movePaneTo` removes *then* splits for
  the same reason in reverse — that order is what stops two panes side by side
  ending up as a split nested inside the split they were already in.
- **`dragstart` bubbles, and the tab strip is a drag handle with draggable
  children in it.** The strip checks `event.target === event.currentTarget`
  before claiming the drag; without it, picking up a tab puts the whole pane in
  flight.
- **`dataTransfer` cannot be read on `dragover`, only on `drop`.** That is why
  `web/src/drag.ts` exists: a pane has to know what is in flight to decide whether
  to light up. The payload still travels on the event — the store is only for
  deciding what to draw on the way.
- **Drop zones are drawn only while a drag is in flight.** A permanent grid of
  invisible targets over a terminal is a terminal you cannot click. They are also
  the highlight, so what lights up and what happens cannot disagree.
- **A dropped file must never reach the browser's default handler.** A page's
  answer to a dropped file is to *navigate to it*, and this page is the whole
  application — a screenshot missing a pane by ten pixels would replace kururu
  with a picture of a screenshot. `Terminal.tsx` claims file drags and types the
  path in; `App.tsx` swallows the ones that miss, in the bubble phase. Both test
  `dataTransfer.types` for `Files` rather than reading the payload, because on
  `dragover` the payload is unreadable and because kururu's own tab and pane drags
  carry custom MIME types and must fall straight through.

## Persistence

**`persist.ts` restores structure, never processes.** A snapshot with four agent
tabs must not launch four agents on the next start — that spends four context
windows before anybody asked. Panes come back empty, with the cwd they were
working in. This is the exception to "making a pane opens a terminal": a restored
pane is not a pane being made, because nobody just asked for it.

`Workspace.dev` is written by watching, and only ever replaced. The scan sees a
server inside one of a workspace's terminals, so the workspace notes the line
that started it — nothing is configured, and a server you started by hand works
the same as one kururu opened a tab for. It is never cleared, because a *stopped*
server is exactly when the memory is worth something. It goes to disk minus the
agent id, which is a process and therefore not the file's business.

## Numbers off the wire

**A clamp is not a check, because NaN loses every comparison it is in.** The
layout's numeric guards all looked like range checks and three were
pass-throughs: `Math.max(0.1, Math.min(0.9, NaN))` is NaN, and
`index < 0 || index >= n` is *false* for NaN and false again for the string `"x"`.
Every one of these numbers arrives on a `ClientMessage`, and the tree lands in the
pty host and is debounced onto disk — where `JSON.stringify` turns NaN into
`null`. One malformed message left a `"ratio": null` in `session.json` that came
back every start afterwards, unfixable from the window, because the divider you
would drag is computed from the ratio that is broken.

`shared/layout.ts` refuses rather than repairs (`"x"` is not a drag that went too
far, it is not a drag) and the guard is at the *entry point* rather than beside
the clamp — `nudge` applies its sign by multiplying, and multiplication coerces,
so `"0.5"` reaches an inner check as a perfectly good number. Anything new that
takes a number off the wire gets `Number.isFinite` or `Number.isInteger`, and
`server/test/layout.test.ts` asserts through `JSON.stringify`, because a test
written as `not.toBeNaN()` passes for a pane holding the string `"x"`.

## Profiles

**A profile is a drawer of workspaces — and, with one switch on, a login of its
own.** It carried *accounts* for a version — a Claude config directory, a gh
config directory, a gitconfig and an ssh key, each chosen per profile and applied
as an env overlay to every pty it spawned — and the choosing is what went. A path
typed into a box was a second place for a login to go wrong quietly, and what it
cost when it did was a terminal opened as somebody you did not expect.

What is back is the half with nothing to choose. `Profile.loginKey` is twelve
random hex digits minted when the profile is made; `~/.config/kururu/profiles/
<loginKey>/claude` and `…/codex` are the directories; `server/src/logins.ts`
turns them into `CLAUDE_CONFIG_DIR` and `CODEX_HOME` on every pty the profile
opens, shells included, so `claude` typed into a terminal is the profile's
account too. Whoever you `/login` as inside a profile is who it is from then on.
**The key is neither the id nor the name.** `persist.ts` regenerates ids on a
cold start and they are counters a later profile would reuse, so an id-keyed
login would come back as somebody else's; a name follows a rename, and moving a
login because a tab strip was retitled is the other accident. A blob or file from
before the key existed is given a fresh one on the way in — `adopt()` and
`readSnapshot` both — which reads as "not signed in yet" and never as somebody
else, and `attach()` saves straight away so a minted key outlives the process
that minted it.

The directories start empty and are never deleted. Deleting a profile leaves its
logins on disk, because removing a login is a thing a person does with `rm`.
Empty is a decision: a config directory is settings, plugins, hooks and memory as
well as a credential, and which of those a second account should share is not
kururu's to answer — seeding a copy carries plugin state into a directory with no
plugins, and linking shares until the first tool that writes through a rename.
**A profile may point at another's login.** That is choosing again, and it is
allowed because of what is chosen from. `scanLogins()` in `logins.ts` lists the
directories under `profiles/` whose names are keys, each labelled by the email in
the account record Claude Code wrote there; `index.ts` keeps that list — plus
every key a profile currently holds, so a fresh profile reads as *not signed in
yet* — as `SessionSnapshot.logins`, refreshed on the usage poll's minute and on
every profile verb, and pushes a snapshot when it changes. The Profiles page
draws a picker over that list and nothing else; `set-profile-login` carries a
key back, and the server refuses any key that is not in the list it last
offered. Two profiles on one key share the directory and everything in it,
which is the meaning of "same account". Null mints a fresh key. The directory a
profile leaves behind is not deleted and stays in the list for as long as
somebody is signed into it, so a switch back is a switch and not a re-login.
**Only terminals opened afterwards change:** a pty was spawned with its
directories in its environment and keeps them, and the page says so.

The switch is `LaunchSettings.loginsPerProfile`, off by default, and it is one
switch rather than a field per profile because the only thing per profile to set
is which of kururu's own directories it uses. **It waits for the host.** An old pty host drops the `env` on the floor and
opens the terminal as the machine's own account with nothing to say so — the one
failure this must not have — so `loginsActive()` in `index.ts` is the switch
*and* `HostInfo.current`, the usage bar follows the same answer, and the Profiles
page says when it is on and not yet in force.

**Switching a profile is a menu; editing one is a page.** This has been all three
things a switcher can be. It was a pick dialog; then renaming and deleting moved
to Settings → Profiles and the picking went with them. **That overcorrected, and
the tell was a "Switch to" button on every row.** Switching never stopped being
*navigation*: it is done ten times an afternoon, and routing it through a modal
meant opening a dialog, reading a list and clicking twice to move between two
rooms.

So the sidebar's profile name opens a menu, `switch-profile` (prefix+s) opens the
same menu by measuring that button rather than guessing a corner, and **Settings
does not switch at all**. Which is why `Settings` takes the tab to open on: where
it opens is the caller's to say, where it goes next is not.

## Keys

Prefix is **ctrl+a**, ghosttown's. Press it twice to send `\x01` through. The ⌘
shortcuts (⌘D ⇧⌘D ⌘T ⇧⌘W ⌘[ ⌘]) are a second door onto the same action table in
`App.tsx`, not a second implementation; ⌘W and ⌘R stay Electron's.

**The prefix is a mode, so it is always labelled.** `StatusBar` shows PREFIX
while it is armed. An unlabelled mode is what makes people distrust modal
interfaces — and the recovery, pressing it twice, has to be discoverable.

**The keyboard is stored as the *difference* from the defaults.** A saved map
would freeze kururu's keys at the version you first opened Settings in, and an
action added later would be unbound forever for everybody who had ever touched a
binding. Which is why an override may be `null`: "this default is off" is a thing
somebody can mean, and nothing else could express it. `1`–`9` are refused
outright — they jump to a workspace by number, are not in the table to argue with,
and a binding that won the lookup would take a workspace out of reach with
nothing on screen to say where it went. The prefix itself is not rebindable: it
is the one chord that has to stay reachable to fix a keyboard you have broken.

Anything that prints a key reads the merged map — the help overlay inverts it
rather than keeping a list beside it, because a list beside it starts lying the
first time somebody moves a key.

## Workspace colours

**Every new workspace is born with one, and the palette is fourteen.** It was
eight, and null by default, on the argument that a tag means something only if
somebody chose it. That is true and it is not the binding constraint: nobody
chooses, because a workspace is made in the middle of doing something else. So
`blankWorkspace` allocates — `nextColor` in `workspaces.ts` counts what the
profile is already wearing and draws at random from the colours used least, which
means the first fourteen workspaces are fourteen different colours. Random
*within* the least-used set rather than the next one along, because an order
would make the first four workspaces the same four colours in every profile on
every machine, which reads as a sequence rather than as a tag.

Fourteen because that is how many accents Catppuccin publishes, and each name in
`WORKSPACE_COLORS` takes one of them exactly once — a tag is never a colour the
flavour did not ship. The names are wire slots and the order is the picker's,
which is why `lime` holds Catppuccin's *teal*: the flavour has no yellow-green,
and renaming the slot would cost everybody the tag on a workspace they had
already coloured, to fix a word. Kururu's own theme has a real lime.

Restored sessions are left alone. A workspace that comes back from disk with no
colour stays that way, because retagging on load would be a version change
rearranging a palette somebody had arranged by hand.

**Where you see it is the rail**: a two-pixel edge down the left of the
workspace's row, in the same `--tag` every agent living in that workspace wears.
It is changed from the row's menu, **Colour…**. A round chip at the end of the
name's line did that job until the git button took its place.

## The workspace row

One line — the number, the name, and in a repository the git button at the end
of it — and a second under the name only when the workspace is in a repository,
holding its branch. The row used to carry a dev server's ↯, ↻ and ■ and a
Supabase ▤ as well, and they went because a row read every time you look at the
sidebar is the wrong place for buttons pressed twice a day: the dev servers are
listed under the agents, and starting one is a line in a terminal.

**The git button is about the main checkout, never a card's worktree.** Its
colour says whether that checkout has anything uncommitted (`--blocked`), has
drifted from its upstream with a clean tree (`--accent`), or neither. The
worktrees are left out on purpose: they are the board's to commit and merge,
and a button that changed colour whenever focus crossed into one would be
describing the wrong checkout. Its menu is **Commit…**, **Commit & merge into
`main`…**, **Commit & push…**, then Pull, Push and Fetch; the three that commit
ask for a message in the app's prompt, and only when there is something to
commit. Merge is a fast-forward of the default branch — `origin/HEAD`, else
`main`, else `master` — to the branch that is out, by `fetch . branch:main`,
without leaving the branch; a `main` that has moved on is refused with "rebase
first", never merged with a knot. Pull is `--ff-only`, Push never forces and
sets the upstream the first time. What each came to replaces the branch line
until clicked away.

`git status` is a subprocess, so it is not on the four-second branch poll: it
runs every `GIT_STATUS_MS` per main checkout, one at a time, with
`--no-optional-locks` so it can never take the `index.lock` an agent committing
in the same checkout needs — and at once after any of the button's own verbs.
The walk that finds the checkout follows focus, which the next section argues
is no way to choose what a button acts on; so the client sends back the root it
was showing and the server refuses a verb whose walk has since landed elsewhere.
The root is compared, never used.

**The whole row switches workspace, both lines of it, and the name's button does
not.** A branch line under the name's button is a strip along the bottom of the
row that lights up on hover exactly like the rest, and would do nothing when
pressed if the button were the target. The handler is on the `li`; a click that
landed on the git button is not let through to it, and the name's button is the one exception because it *is*
this gesture, which is also what keeps Enter working on a focused row.

**And a row that is dragged is a row that cannot be clicked.** A `draggable`
element starts a drag after about three pixels of movement and the platform then
dispatches no `click` at all — so a press that wobbled, which on a trackpad is
most of them, did nothing at all: a row dropped on itself is refused as a target,
so the gesture ended in `dragend` with nothing done and nothing said. `dragend`
is where it is read back: a drag whose `dropEffect` is still `none` and which
finished within `CLICK_SLOP` of where it started was a click, and is handed back
as one.

`.ws-list` is one grid and every row a `subgrid` slice of it — the name's track
and the button's — so the buttons stand in one column down the list whatever
the names are.

## The branch on the row

Under the name, because the sidebar names a workspace after the work
rather than after the repository — which is right, and leaves out the one fact
that changes under you with nothing on screen moving. An agent that has been
running for twenty minutes is on whatever branch you were on when you started it.

**Read out of `.git/HEAD`, never by running `git`.** A subprocess per workspace
every four seconds is a lot of forking for one line; `git` in a repo it dislikes
takes an unbounded time to say so; and `HEAD` is the file git itself writes the
answer into, so reading it cannot disagree with `git branch --show-current`. The
ref is not split on the last slash — `feature/api/v2` is one name — and a
detached HEAD is reported as a short sha and said to be detached, because that is
exactly the state in which somebody commits work and then cannot find it.

`.git` is a *file* in a linked worktree and in a submodule, holding `gitdir:
<path>` which may be relative to that file's own directory. `git worktree add` is
a normal way to have two branches open at once, so this is not an edge case; the
relative half is the one that silently returns nothing when it is forgotten.

**Which repository, when a workspace holds two.** The row has one line for one
branch, so something has to choose, and tree order is the wrong chooser: a
workspace named after a project but holding a sibling checkout in its first pane
reported the sibling's branch and sat there not moving while you checked things
out all afternoon. That is not a stale row — it is a row faithfully answering
about a repository nobody asked about, which is worse, because it is
indistinguishable from the poll being broken. The tie is broken by **focus**: the
pane you are looking at, and the tab showing inside it, go first, and everything
`workspaceDirs` would have offered follows behind in its own order. The tooltip
names the working tree, which is the row's own way of saying which one it picked.

Focus is a safe tie-break here because the branch is only ever read: being wrong
about it costs one line of text until the next poll. A button that *acted* on a
directory chosen this way would do something different every time the focus
moved, which is the reason not to reuse it for one.

Only the **walk** that finds the repository is cached, never the branch. Where
`.git` lives changes about as often as somebody moves a project; what is in
`HEAD` changes every time they check something out, which is the fact the row
exists to show.

The poll is every four seconds, faster than the dev-server scan, because it is
cheap and it is the one fact a person changes deliberately and then immediately
looks at.
