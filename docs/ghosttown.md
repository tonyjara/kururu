# ghosttown, and what was ported from it

`../ghosttown` is the agent-first multiplexer in the sibling directory. Kururu
began as a front-end for it and still borrows code from it, but is no longer a
client of it: **kururu's agents and ghosttown's are two separate sets.**

**Never modify `../ghosttown` from this project.** The traffic is one-way. If
something there needs changing, write it down and raise it with the user; do not
reach across and edit it. (`../kururu-styles` is different and is ours — see
[styles](styles.md).)

## What was ported, and why it must not drift casually

| here | from | note |
|---|---|---|
| `server/src/agents/status.ts` | `src/core/status.ts` | verbatim but the import |
| `server/src/agents/procs.ts` | `src/core/procs.ts` | the agent-detection slice; `Bun.spawn` → `execFile` |
| `server/src/transcript.ts` | `src/core/transcript.ts` | parsing verbatim; `Bun.file().slice()` → an fd and two reads |
| `shared/notify.ts` | `src/core/notify.ts` | `notifyGate` and `notifyText` only |

`status.ts`'s thresholds were tuned against real agents, and the point of copying
rather than rewriting is that a dot meaning `working` here means the same thing
there. If you improve either it or `procs.ts`, check whether the original
deserves the same fix — and tell the user rather than editing across.

`transcript.ts` sits in `server/src/` rather than beside `report.ts` in `agents/`
— where it belongs by subject — because `agents/` is the pty host's and everything
in there costs the user their agents to edit. It touches no pty; it reads a file
somebody else wrote.

`shared/notify.ts` ports **only the policy** — see
[notifications](notifications.md) for why the delivery is entirely different.

## What else is ghosttown's

- **The keymap.** `shared/keys.ts` is ghosttown's `[keybinds]` section key for
  key, and the prefix is its ctrl+a. Where kururu has no equivalent (detach,
  reboot, the markdown reader) the key is left **unbound** rather than reused: a
  key that does something different in the sibling app is worse than one that does
  nothing. `A` and ⇧⌘T were "new agent tab" and are now unbound, because every
  terminal is the same thing. `g` opens Settings — a key ghosttown leaves unbound,
  which is the same licence `]` and `[` were added under.
- **The hierarchy**, word for word: profiles → workspaces → panes → tabs.
- **The dev-server pair** on a workspace row: ▸ to run what it last had serving, ↻
  to restart it — including the shape, where which button you see *is* the status.
- **The restart contract.** Ghosttown's config says the same thing about its
  daemon in the same words: a live pty cannot be handed to a replacement process.
