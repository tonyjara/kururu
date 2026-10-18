# Nodes: the Mac and its children, linked

A **node** is any kururu. The Mac is the **parent**, a box set up by
[`kururu child setup`](linux.md) is a **child**, and once the two are paired
each draws the other: the Mac's sidebar and Needs drawer show the child's
workspaces, agents and asks, the Mac's backup carries the child's boards, and
the child's own page says when the Mac went away. This is phase 2 of
[the plan](plans/kururu-parent-child.md#phase-2--nodes-the-roster-the-mesh-the-mirror).
Kurus talking to each other, lent secrets and one Telegram are phases 3–5,
and this file grows with them. Moving a workspace, phase 6, is
[below](#moving-a-workspace).

The code is `shared/nodes.ts` (the shapes and every rule, pure and tested),
`server/src/nodekeys.ts` (the keys) and `server/src/nodes.ts` (`NodeHost`).

## Two words kept apart

- **The parent** is the node holding the roster's signing key. It pairs a
  node, removes one, renames one and sets the rank. A child can never add a
  member. A node becomes a parent the first time somebody adds a node from
  its Settings → Nodes; until then it is **alone**.
- **The leader** is the highest-ranked node that is reachable, worked out by
  each node from its own links (`leaderOf`). Rank is the parent's list, the
  parent first by default, and draggable. In phase 2 leading means nothing
  yet. Phase 5 hangs the Telegram poll on it.

## Pairing

Pairing starts on the Mac and is one command on the new computer. Settings →
Nodes → **Add a computer** says it in three steps: make sure the new
computer has kururu (the clone and the wizard, or "use the kururu skill"),
run this command on it, wait here. The command is shown ready to copy, with
the Mac's address and a code in it:

```sh
kururu child join 100.64.0.1:7717 ABCD-EFGH
```

The code is eight characters, works once, and lasts ten minutes. Running the
command makes the new computer's server post its id, name, public keys,
port and share token, with the code, to the Mac's `POST /api/nodes/join`.
The Mac checks and burns the code. It becomes a parent if it was alone, and
signs a roster with the new member in it at the address the request came
from. It answers with that roster. The new computer checks the roster's
signature against the key the roster names (trust on first use, made safe
by the code the person copied off the Mac's own screen), keeps that key as
its **anchor**, and starts dialling. The Mac's page notices the join on its
own (`joined` in the view) and says "omarchy joined". The same command can
be pasted into the new computer's own Settings → Nodes ("Is this the new
computer?"), or given to the wizard as `--join`.

It started the other way round: the new computer showed a code, and the
person typed it and the computer's address into the Mac. Nobody could tell
from the page what the code was for, where it came from or where it went.
Both directions trust the same two things, a short-lived single-use code
carried by the person and then only keys. This one is a copy and a paste,
from the screen the person is already looking at.

The parent keeps the new computer's share token, so that its Open links and
QR codes let a device in. A child never holds another node's token.

`/api/nodes/join` is the only route ahead of the token gate besides `/link`,
because the code is its token. Both refuse:

- any request with an `Origin` (a page);
- any request with a proxy's header (`tailscale serve` delivers from loopback);
- any remote address outside 100.64/10 and loopback (`nodeRequestRefusal`).

A wrong code counts, and the fifth burns the code. A computer already in a
roster refuses to join another: it is removed on its parent first, which it
learns the next time the two link. A parent with members of its own refuses
too. A lone parent that joins another drops its signing key.

## The roster

The roster is a signed, versioned list: every member's id, name, public keys
(Ed25519 to sign, X25519 for phase 4's sealed secrets), address, port and
rank. The parent signs `rosterPayload`, which is canonical JSON with sorted
keys, so the bytes signed on one node are the bytes checked on another.
The signature covers the object *as received*, extra fields included, so a
later phase can add fields without an older node cutting them out before it
checks or forwards.

`adoptRoster` is the whole rule: only a roster the anchor signed, and only
when its version is newer. Every node keeps the newest it has seen and
passes it down every link, so a change reaches a node the parent cannot see
through one it can. A node also offers its roster in every `hello`. That is
how a new member gets in through a peer that had not heard of it, and how a
removed node learns it is out from the first node it meets. A node that
takes a roster it is not in **unpairs**: it closes its links, forgets the
roster and its anchor, and is alone again, ready to be paired anew.

## Links

**There is one WebSocket per pair, `GET /link`, and the lower rank dials the
higher.** The first-ranked node, the Mac by default, dials nobody and only
listens. That is why the Mac must be shared: Settings → Nodes refuses to add
a node while `reachable` names a reason. A failed dial is retried with
backoff (1 s, doubling, capped at 30 s) forever, as `session.ts` does,
because under `bun run dev` a server restart is every save.

**The handshake** (`LinkHandshake`, a state machine with no socket in it) is
the same on both ends:

1. Each end sends a `hello`: its id, a fresh challenge, the roster it holds,
   and the link protocol.
2. On the peer's `hello`, each end adopts the peer's roster if it is newer,
   checks that the peer is a member and that it still is itself, and answers
   with a `prove`: an Ed25519 signature over the *peer's* challenge and both
   ids, in signer-then-verifier order.
3. On the peer's `prove`, each end checks it against the key the roster lists.

There are no per-pair tokens to mint or rotate. Removing a node is a new
roster, and every node it meets refuses its key. A dialler that reaches a
different member at the address it dialled refuses that member.

**Away.** Every link pings every five seconds. A node is away after
twenty-five seconds of silence, which the five-second look turns into at
most thirty, because a lid that closes sends no FIN. A link that closes with
1001 is a server restarting. That is what `close()` sends on the way out, so
the peer shows as *connecting* rather than *away*, and becomes away only if
it is not back within the same twenty-five seconds. `nodes-seen.json`, in the
state directory, keeps each node's last summary and when it was last heard.
A child restarted while the Mac sleeps can therefore still say "away since
23:10" at once.

## Summaries

What crosses a link is a **summary** (`NodeSummary`), never a copy. A node
pushes one whenever it changes, at most once a second, and only when it
differs from the last. It contains:

- its version and host state;
- the profile on screen;
- each workspace's name, folder and Needs band, with its agents and its needs;
- the Needs count;
- Kuru's counts;
- whether it leads, which peers it sees, and a data mark that moves when its
  database is written.

`summarize` uses `needsOf`, so a child's band on the Mac is the band the
child's own drawer draws. Agents go without pid, command line, memory or
links, and long text is clipped. A busy node's summary is a few kilobytes.

Nothing structural is synchronised. A child's boards are its own, in its own
database, and the parent's are the parent's.

## What draws it

- **Settings → Nodes** (`web/src/settings/Nodes.tsx`):
  - On the parent: the roster by rank with drag-to-rank (and ↑/↓ on a
    phone), rename, remove, each node's state and Open, and Add a computer.
  - On a child: the parent's roster, read-only.
  - On a node in no roster: Add a computer, and the place to paste the
    Mac's command when this is the new computer.
- **The sidebar's Nodes section:** each node's workspaces with their agents'
  marks and the Needs dot, greyed with "away since" when not up. Each row is
  a link to the node.
- **The Needs chip and drawer:** add each up node's needs and draw a band per
  node. An away node is not counted.
- **The Share dialog:** each node's own QR code. On the parent that QR
  carries the node's token; on a child it is the bare address.
- **The desktop:** the picker and the tray offer "Open <node>". This is the
  window's own choice, never a served page's (`preload.js`). The node's
  token is held in memory and never written to `servers.json`, so a node is
  never where the next launch lands, and the floating pill stays on this
  Mac.
- **`kururu_status`:** gives Kuru every node with its workspaces, agents and
  needs from the summaries, never the token. The role's Nodes section says
  they can be read and not driven. Asking another node's Kuru to act there
  is phase 3.
- **`/api/health`:** carries `nodes` (role, name, leader, each member's state)
  for `bun run status` and the doctor's pairing row. `/api/nodes` is the
  whole view, behind the gate.

## Backups

A child runs no git. When the parent backs up, it asks each linked child
whose data mark moved for its mirror over the link (`export-ask`). The child
walks the same allow-list as the parent's own (`mirrorFiles`), and the
parent writes the result under `nodes/<name>/` in its repository. A child
that is away keeps the files of its last pull. Only the parent may pull. A
child's boards are therefore backed up as often as the Mac is awake.
`bun run restore <repo> --node <name>` on a fresh child reads that subtree
back. The child is then paired again, because its keys and the roster were
never in the backup.

## Moving a workspace

Phase 6. A workspace row's ⋯ menu (and its right-click) has **Move to
<node>…** for every other member, the parent included, so a move goes either
way. A node that is not linked is listed, greyed, with its state. The same
move is Kuru's `move_workspace`: without `confirm` it returns the plan as
text, and with `confirm: true` it moves the workspace. The tool tells Kuru to
ask the user before confirming.

**The dialog** is centred, like everything else that ends work. It asks for
the project's folder on the other node, and that node judges it as it is
typed. The first guess is the folder name from here under the other node's
projects folder: the folder most of its workspaces sit in, else `~/Projects`
or one of the usual names, else home. Then come two lists, worded in
`shared/move.ts`:

- **Moves:** the name, and the board. Every card goes, deleted ones too,
  each with its number, dates, runs and history. The runs come as history
  only: their conversations stay here, so running such a card there starts
  a new conversation. An asleep run arrives `ended`, so the card does not
  promise a resume.
- **Stays:** the code (the other node uses its own checkout, so push here
  and pull there), the env files, any database the project points at, the
  panes (it arrives with one pane in its folder), the open terminals (they
  close), the cards' dev servers, a machine pin, the links to files agents
  made, and this node's copy of the board, which goes to Search → Deleted.

**Refused** while it is the profile's only workspace, while Kuru's own tab is
in it, while an agent is running in it or on one of its cards (a shell
running `claude` counts), or while a card has a worktree on the disk. A
worktree the disk no longer has is dropped and does not block the move. The
refusal is drawn above the lists. The folder is still checked under it, so
both fixes show at once.

**The folder is the other node's to judge.** `judgeFolder` in
`server/src/move.ts` expands `~` and wants an absolute path inside home,
both before and after links are followed (refuse, never clamp). The path
must be a directory with a `.git` in it. Nothing runs `git`.

**The exchange** is two questions on the link:

| message | answer | what it carries |
|---|---|---|
| `workspace-move-check` | `workspace-move-checked` | the folder (or null for the guess); answered with the resolved folder, the problem if any, the profile it would land in and whether a workspace of that name is there |
| `workspace-move` | `workspace-moved` | a move id, the workspace's key and name, the folder, and the board as `Store.exportBoard` writes it (the backup's `BoardExport`); answered with what was made |

The receiving node checks the offer down to every event (`adoptOffer`) and
judges the folder again. It makes the workspace in the profile on screen,
with one pane in that folder. Then `Store.adoptMove` writes the cards, runs
and events in one transaction, adds an `imported` event to each card naming
both nodes, and stores its answer in `meta` under the move id. The board is
read back into memory from those rows, as a restored card is.

Only when the answer arrives does the moving node act. `Store.markMovedAway`
marks every card on the board deleted, with a `moved` event naming the node
and the new key. Then the workspace is removed, as deleting one would, and
its terminals are ended. **The move id is
the same every time** this workspace is sent to that node (a hash of the
two node ids and the workspace's key). So a second press after a lost answer
is the same move, and the other node replies from its record with
`again: true` and makes nothing twice. A move interrupted before the answer
leaves this node as it was.

**A card that comes back** keeps its row. Moving a workspace there and back
finds the cards' ids already in this database, on the board they left,
marked moved. `adoptMove` takes those rows up again: new board, the export's
fields, deletion as the export says. It adds only the runs and events that
are not already there, matched by when and what, so the history reads
straight through both machines.

## Files

| file | where | what |
|---|---|---|
| `node.json` | config, `0600` | this node's id and its Ed25519 and X25519 pairs; on the parent, the roster's signing pair. Never backed up, never sent |
| `nodes.json` | config, `0600` | the newest roster, the anchor, and on the parent each child's share token. Never backed up |
| `nodes-seen.json` | state | each node's last summary and when it was heard; rebuilt by the next summary |

A `node.json` the server cannot read is left as it is, and nodes are off for
that run. A new identity would be a member nobody enrolled.

## Testing two nodes on one Mac

Two [isolated instances](testing.md#the-isolated-instance), each with
`KURURU_NODE_ADDRESS=127.0.0.1`, which is the address the others dial in
place of the tailnet one. Give the second `KURURU_LOOPBACK_TOKEN=1` so it
behaves like a child. Then:

```sh
# node-invite on the parent's socket, {"type":"node-invite","id":1,"on":true}, replies with the command
curl -X POST -H "Authorization: Bearer $(jq -r .token /tmp/kn2/config/access.json)" \
  -d '{"text":"kururu child join 127.0.0.1:7871 ABCD-EFGH"}' 127.0.0.1:7872/api/nodes/pair
```

Name each socket `ptyhost.sock`, or `kill-ptyhosts` cannot find it afterwards.

`kill -STOP` on a server's pid is a lid closing (no FIN), and `kill -CONT` opens it again.
`kill -USR2` on its runner is a restart.
