# docs/

The detail that used to be in `CLAUDE.md`. That file is now the operational brief
— what will bite you today. These are the reference.

| | |
|---|---|
| [architecture.md](architecture.md) | The three processes, the socket between them, restart semantics, discovery, access control, and the server's shape |
| [terminals.md](terminals.md) | The emulator pool, the size policy, the backlog protocol, the cursor. The part that has been wrong the most times |
| [layout.md](layout.md) | Profiles, workspaces, panes, tabs, dragging, persistence, keys |
| [styles.md](styles.md) | The one look: where its values live and the tokens a rule may use, icons, tag colours, sounds, mascots |
| [notifications.md](notifications.md) | The gate, the delivery, sounds — and the macOS signing saga |
| [data.md](data.md) | The database boards and conversations live in, the keys that name a profile across cold starts, the history of every move, the search, the one road in from an old `session.json`, and backups to a private repository |
| [harness.md](harness.md) | The one session per profile that drives the others: kururu's verbs as MCP tools, the user's words typed into a pty and why not the inbox, the status feed |
| [antigravity.md](antigravity.md) | Antigravity's `agy` as the fourth program: its launchers, the Runs on switch, status through a title command and the screen, resume, Kuru on it, its quota on the bar — and its sign-in never lent |
| [machines.md](machines.md) | The user's other computers: the sidebar's gauges, a shell on one as a command line rather than a host change, workspaces pinned to one, tmux sessions and what ends them, and each one's specs |
| [channels.md](channels.md) | Talking to Kuru from Telegram: the allow-list and pairing, the token, long polling and what off means, what goes to the chat, and when a reply is not spoken |
| [web.md](web.md) | The web for every agent kururu starts: four MCP tools on loopback behind an ordered chain of providers — the hand-back to the agent's own tools, cloud Firecrawl, a self-hosted Firecrawl when one is set up — what counts as a failure, the keys never lent, the cloud's budget, untrusted pages, what leaves the machine, running one of your own, and how to add a provider |
| [voice.md](voice.md) | Talking to the harness and hearing it: the talk key, on-device transcription through Hex (with `yap` behind it) and its vocabulary, Kokoro on the CPU, two languages, the phone's https problem |
| [nodes.md](nodes.md) | The Mac and its children, linked: pairing by a code, the signed roster, one link per pair proved by keys, away by silence, the summaries every node draws, the parent pulling a child's backup, and the Kurus as peers — ask_kuru, the marks, one drawer for every node |
| [linux.md](linux.md) | A child kururu: the headless server on a Linux box under systemd, the `kururu` command, its wizard and doctor, the unit, what a restart costs there, and the skill that walks an agent through it |
| [vault.md](vault.md) | The vault as a store: items in the Keychain, the dialog Kuru and agents open for the owner to paste into, env files written one variable at a time, and what it protects against and what it cannot |
| [slots.md](slots.md) | The slot queue: lanes agents wait in for a build, a simulator, a test run, a heavy suite or the phone; leases that end with their terminal; admission by load; the simulator pool and the nightly sweep; the footer, the pane line, Needs and Kuru; moving from a script |
| [packaging.md](packaging.md) | electron-builder, signing, notarizing, the updater, releases |
| [invariants.md](invariants.md) | The load-bearing invariants in full: each one `CLAUDE.md` names in a line, with its argument, its files and its exceptions |
| [gotchas.md](gotchas.md) | Errors that name something other than their cause |
| [testing.md](testing.md) | What `bun test` covers, the isolated instance, what is verified |
| [ghosttown.md](ghosttown.md) | The sibling project, what was ported, and the one-way rule |

`PLAN.md` has the design principles and the argument for the shape.
`README.md` is for people using kururu.
