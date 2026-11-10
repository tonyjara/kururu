/**
 * Settings → Connections → Vault: everything kururu can see and lend, on one
 * page, by name.
 *
 * The vault is not a store (`shared/vaultview.ts` has why), so until this
 * page the answer to "what is in it" was spread over the Nodes page's
 * switches, each key's own page and a terminal. This is the census, and it
 * changes nothing but one thing: what is lent can be taken back here, the
 * same verb as the Nodes page's switch, and not from a phone, where the page
 * is for looking.
 *
 * Two halves with two clocks. What is lent is the `secrets` every window is
 * sent and is live. Everything else is asked for when the page opens, and
 * again on Look again, because an env file's names are this page's to ask
 * for and not every client's to be sent on every save.
 *
 * Above the census, the vault's own store (`docs/vault.md`): the items
 * pasted into its dialog, each with its rule — free, or ask before each use —
 * and Remove; and below them the recent uses by `vault run`. Names, rules
 * and commands; never a value, which this page is never sent.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { NEVER_SHARED } from "../../../shared/secrets";
import type { VaultPage as StorePage, VaultUse } from "../../../shared/vaultitems";
import { envLentTo, lentRows, lentTo, type VaultKey, type VaultLogin, type VaultPage as KeyPage, type VaultView, type VaultWorkspace } from "../../../shared/vaultview";
import * as api from "../session";
import { useKururu } from "../session";
import { HeldList } from "./Secrets";
import { Action, Banner, Bullets, Btn, DangerButton, Details, Empty, errorText, Group, Mono, Outcome, P, plural, Readout, Row, Tile, Tiles, when } from "./ui";

const TOOL: Record<VaultLogin["tool"], string> = { claude: "Claude Code", codex: "Codex", vercel: "Vercel" };

export function VaultPage({ readOnly, onOpen }: { readOnly: boolean; onOpen: (page: KeyPage) => void }) {
  const [view, setView] = useState<VaultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .vault()
      .then(setView, (err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(look, [look]);

  if (!view) return error ? <Banner tone="bad">Could not read the vault: {error}</Banner> : <Empty>Reading the vault…</Empty>;
  const lendable = view.keys.filter((key) => key.kind !== null);
  const kept = view.keys.filter((key) => key.kind === null);
  const envFiles = view.workspaces.reduce((n, w) => n + w.env.length, 0);

  return (
    <>
      {error && <Banner tone="bad">Could not read the vault again: {error}</Banner>}
      <Kept readOnly={readOnly} />
      <Group title="In the vault" foot="Names, places and hints only. No value is ever sent to this page, not even masked; a private key or a token is listed by its file being there.">
        <Tiles>
          <Tile value={String(view.keys.filter((key) => key.set).length)} label="kururu keys" under={`of ${view.keys.length} files`} />
          <Tile value={String(envFiles)} label={envFiles === 1 ? "env file" : "env files"} under={plural(view.workspaces.filter((w) => w.env.length).length, "workspace")} />
          <Tile value={String(view.ssh.length)} label={view.ssh.length === 1 ? "ssh host" : "ssh hosts"} />
          <Tile value={String(view.github.length)} label={view.github.length === 1 ? "GitHub login" : "GitHub logins"} />
          <Tile value={String(view.logins.filter((l) => l.signedIn).length)} label="other logins" under="signed in" />
        </Tiles>
        <Action label="Read" hint={`At ${when(view.at)}. What is lent below is live.`} button="Look again" busy={busy} busyLabel="Reading…" onClick={look} />
      </Group>

      <Group title="Keys kururu can lend" foot="Each in a file of its own, readable only by you, read at the moment it is needed. A node holds one only once it is switched on for it in Settings → Nodes.">
        {lendable.map((key) => (
          <KeyLine key={key.id} entry={key} onOpen={onOpen} />
        ))}
      </Group>

      <Group title="Kept here, never lent" foot="Never sent to another node and never backed up: each stays on the computer that made it.">
        {kept.map((key) => (
          <KeyLine key={key.id} entry={key} onOpen={onOpen} />
        ))}
        <Details summary="Why each one stays">
          <Bullets
            items={NEVER_SHARED.map(({ file, why }) => (
              <>
                <Mono>{file}</Mono>: {why}
              </>
            ))}
          />
        </Details>
      </Group>

      <Lent role={view.role} readOnly={readOnly} onOpen={onOpen} />

      <Group
        title="Env files it can lend"
        lead="Kururu keeps no copy. These are the env files in each workspace's checkout here, which it can lend a node the workspace moves to."
        foot="Read for the names they set and nothing else, down two folders; never .env.example or a backup. Lent from Settings → Nodes, or with a move."
      >
        {view.workspaces.length === 0 ? (
          <Empty>No workspace has an env file in its checkout on this Mac.</Empty>
        ) : (
          view.workspaces.map((w) => <WorkspaceRows key={w.id} workspace={w} profiles={new Set(view.workspaces.map((x) => x.profile)).size > 1} />)
        )}
      </Group>

      <Hosts view={view} />

      <Group title="Other logins agents use" foot="Each tool's own login, listed by its file being there. Codex and Vercel keep who you are only in the token's file, which is not opened, so only Claude's account is named.">
        {view.logins.length === 0 ? (
          <Empty>No Claude Code, Codex or Vercel login on this computer.</Empty>
        ) : (
          view.logins.map((login) => <LoginRow key={`${login.tool}:${login.where}`} login={login} />)
        )}
      </Group>
    </>
  );
}

const APPROVED: Record<VaultUse["approved"], string> = { free: "free to use", owner: "you allowed it", lasting: "allowed for 15 minutes", denied: "not allowed" };

/**
 * The vault's own items and what used them. Asked for when the page opens;
 * each change answers with the page again. On a phone it is for looking.
 */
function Kept({ readOnly }: { readOnly: boolean }) {
  const [page, setPage] = useState<StorePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = (key: string, run: () => Promise<StorePage>) => {
    setBusy(key);
    setError(null);
    run()
      .then(setPage, (err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };
  useEffect(() => {
    api.vaultPage().then(setPage, (err: unknown) => setError(errorText(err)));
  }, []);
  if (!page) return error ? <Banner tone="bad">Could not read the vault's items: {error}</Banner> : null;
  const where = page.store === "keychain" ? "the Mac's Keychain" : "a private file on this computer";
  return (
    <>
      {error && <Banner tone="bad">{error}</Banner>}
      <Group
        title="Kept in the vault"
        lead={
          <>
            What you pasted into the vault's dialog, kept in {where}. Agents use an item with <Mono>vault run</Mono>, which gives the command the value and the agent only its output, masked.
          </>
        }
        foot="An item that asks opens a dialog each time a command would use it: Allow once, Allow for 15 minutes, or Deny. Removing an item leaves any env file it was written to as it is. Anything running as you can still read the Keychain directly; see docs/vault.md."
      >
        {page.items.length === 0 ? (
          <Empty>Nothing yet. Kuru or an agent asks for a key and you paste it into the dialog that opens.</Empty>
        ) : (
          page.items.map((item) => {
            const parts = [
              item.env.length ? `also in ${item.env.map((e) => `${e.variable} in ${e.file}`).join(", ")}` : null,
              item.lastUse ? `last used ${when(item.lastUse.at)} by ${item.lastUse.by}` : "never used",
              `saved ${when(item.updatedAt)}${item.by ? ` for ${item.by}` : ""}`,
            ].filter(Boolean);
            return (
              <Readout
                key={item.name}
                label={
                  <>
                    {item.label} <Mono>{item.name}</Mono>
                  </>
                }
                value={item.use === "ask" ? "Asks each use" : "Free to use"}
                tone={item.use === "ask" ? "busy" : "ok"}
                hint={parts.join(" · ")}
              >
                {!readOnly && (
                  <>
                    <Btn disabled={busy !== null} onClick={() => act(`use:${item.name}`, () => api.setVaultUse(item.name, item.use === "ask" ? "free" : "ask"))}>
                      {item.use === "ask" ? "Make it free" : "Ask each use"}
                    </Btn>
                    <DangerButton
                      label="Remove"
                      ask={`Remove ${item.name} from the vault?`}
                      busy={busy === `rm:${item.name}`}
                      busyLabel="Removing…"
                      disabled={busy !== null}
                      onConfirm={() => act(`rm:${item.name}`, () => api.removeVaultItem(item.name))}
                    />
                  </>
                )}
              </Readout>
            );
          })
        )}
      </Group>
      <Group title="Recent uses" foot="Every command run with a vault item, newest first, the last fifty: who, which items, the command as it was written, where, and how it ended. No value is kept, and a value typed into a command is masked here too.">
        {page.uses.length === 0 ? (
          <Empty>No command has used the vault yet.</Empty>
        ) : (
          page.uses.map((use, i) => (
            <Readout
              key={`${use.at}:${i}`}
              label={
                <>
                  {use.by} · {use.names.join(", ")}
                </>
              }
              value={use.approved === "denied" ? "Not run" : use.code === null ? "Ended" : `Exit ${use.code}`}
              tone={use.approved === "denied" ? "off" : use.code === 0 ? "ok" : "bad"}
              hint={
                <>
                  {when(use.at)} · {APPROVED[use.approved]} · <Mono>{use.command}</Mono> in {use.cwd}
                </>
              }
            />
          ))
        )}
        {!readOnly && page.uses.length > 0 && (
          <Row label="" hint="Empties the log on this computer.">
            <DangerButton label="Clear" ask="Clear every recent use?" busy={busy === "clear"} busyLabel="Clearing…" onConfirm={() => act("clear", api.clearVaultUses)} />
          </Row>
        )}
      </Group>
    </>
  );
}

/** One of kururu's keys: whether it is set, by its hint, where it lives, and the page it is set on. */
function KeyLine({ entry, onOpen }: { entry: VaultKey; onOpen: (page: KeyPage) => void }) {
  const { secrets, nodes } = useKururu();
  const to = entry.kind ? lentTo(entry.kind, secrets, nodes?.nodes ?? []) : [];
  const parts = [
    entry.where,
    entry.changed ? `changed ${when(entry.changed)}` : null,
    entry.heldFrom ? `held from ${entry.heldFrom}` : null,
    to.length ? `lent to ${to.join(", ")}` : null,
  ].filter(Boolean);
  return (
    <Readout label={entry.label} tone={entry.set ? "ok" : "off"} value={entry.hint ? <Mono>{entry.hint}</Mono> : entry.set ? "Set" : "Not set"} hint={parts.join(" · ")}>
      {entry.page && !entry.heldFrom && <Btn onClick={() => onOpen(entry.page!)}>Open</Btn>}
    </Readout>
  );
}

/**
 * What is lent to which node, live: on the parent every grant that is on or
 * still in a node's hands, with Take back; on a child what it holds. Take
 * back is the Nodes page's switch turned off, asked first here because on
 * this page it is the one thing that changes anything.
 */
function Lent({ role, readOnly, onOpen }: { role: VaultView["role"]; readOnly: boolean; onOpen: (page: KeyPage) => void }) {
  const { secrets, nodes } = useKururu();
  const [error, setError] = useState<string | null>(null);
  const open = (
    <Row label="" hint="Every switch, per node, and what each one unlocks.">
      <Btn onClick={() => onOpen("nodes")}>Open Nodes</Btn>
    </Row>
  );
  if (role === "child") {
    return (
      <>
        <HeldList />
        <Group>{open}</Group>
      </>
    );
  }
  const roster = nodes?.nodes ?? [];
  const rows = lentRows(secrets, roster);
  const take = (nodeId: string, kind: string) => {
    setError(null);
    api.grantSecret(nodeId, kind, false).catch((err: unknown) => setError(errorText(err)));
  };
  return (
    <Group
      title="Lent"
      foot={
        rows.length === 0
          ? undefined
          : readOnly
            ? "Taking one back is done from this Mac, or from Settings → Nodes."
            : "Take back removes it from the node. It does not end the credential: the Nodes page says how to, for each."
      }
    >
      {rows.length === 0 && <Row label="Nothing" hint={role === "alone" ? "This kururu has no nodes to lend to." : "No node holds anything from this Mac."} />}
      {roster
        .filter((node) => rows.some((row) => row.node.id === node.id))
        .map((node) => (
          <div key={node.id}>
            <Readout label={node.name} tone={node.state === "up" ? "ok" : "off"} value={node.state === "up" ? "linked" : "away"} />
            {rows
              .filter((row) => row.node.id === node.id)
              .map((row) => (
                <Row key={row.kind} label={row.label} hint={row.bad ? <Outcome bad>{row.text}</Outcome> : `${row.text}${row.since ? ` · since ${when(row.since)}` : ""}`}>
                  {!readOnly && row.on && <DangerButton label="Take back" ask={`Take it back from ${node.name}?`} onConfirm={() => take(node.id, row.kind)} />}
                </Row>
              ))}
          </div>
        ))}
      {error && <Row label="" hint={<Outcome bad>{error}</Outcome>} />}
      {open}
    </Group>
  );
}

/** A workspace: its checkout, what it seems to use, and each env file folded over its names. Its profile is said when there is more than one. */
function WorkspaceRows({ workspace: w, profiles }: { workspace: VaultWorkspace; profiles: boolean }) {
  const { secrets, nodes } = useKururu();
  const uses = [
    ...w.ssh.map((s) => `ssh ${s.alias} (${s.why})`),
    ...(w.github ? [`GitHub ${w.github.account}${w.github.signedIn ? "" : " (gh here is not signed in as it)"}`] : []),
  ];
  return (
    <>
      <Row label={w.name} hint={[w.checkout, profiles ? w.profile : null, ...uses].filter(Boolean).join(" · ")} />
      {w.env.map((env) => {
        const to = envLentTo(w.checkout, env.file, secrets, nodes?.nodes ?? []);
        const line = [env.note ?? plural(env.names.length, "variable"), env.changed ? `changed ${when(env.changed)}` : null, to.length ? `lent to ${to.join(", ")}` : null].filter(Boolean).join(" · ");
        return (
          <Details
            key={env.file}
            summary={
              <>
                <Mono>{env.file}</Mono> · {line}
              </>
            }
          >
            <P>
              {env.names.length
                ? env.names.map((name, i) => (
                    <Fragment key={name}>
                      {i > 0 && " "}
                      <Mono>{name}</Mono>
                    </Fragment>
                  ))
                : "No variables."}
            </P>
          </Details>
        );
      })}
    </>
  );
}

/** This Mac's ssh hosts and GitHub logins: names and key file names, the keys and tokens unread. */
function Hosts({ view }: { view: VaultView }) {
  const { secrets, nodes } = useKururu();
  const roster = nodes?.nodes ?? [];
  const lent = (kind: string) => {
    const to = lentTo(kind, secrets, roster);
    return to.length ? `lent to ${to.join(", ")}` : null;
  };
  return (
    <>
      <Group
        title="SSH hosts it can lend"
        lead="Kururu keeps no copy. These are the Host entries in this Mac's ~/.ssh/config, which it can lend a node with their keys."
        foot="Each with its key file's name. A key is read only once it is lent to a node."
      >
        {view.ssh.length === 0 ? (
          <Empty>No Host entries in ~/.ssh/config.</Empty>
        ) : (
          view.ssh.map((host) => (
            <Readout
              key={host.alias}
              label={<Mono>{host.alias}</Mono>}
              tone={host.key ? "ok" : "off"}
              value={host.key ? <Mono>{host.key}</Mono> : "no key file"}
              hint={[host.note, lent(`ssh:${host.alias}`)].filter(Boolean).join(" · ") || undefined}
            />
          ))
        )}
      </Group>
      <Group
        title="GitHub logins it can lend"
        lead="Kururu keeps no copy. These are the accounts gh is signed in as on github.com here, which it can lend a node."
        foot="Their tokens stay in the Keychain; one is read only once it is lent to a node."
      >
        {view.github.length === 0 ? (
          <Empty>gh is not signed in to github.com here.</Empty>
        ) : (
          view.github.map((gh) => (
            <Readout key={gh.account} label={gh.account} tone="ok" value={gh.active ? "gh's active account" : "signed in"} hint={lent(`gh:${gh.account}`) ?? undefined} />
          ))
        )}
      </Group>
    </>
  );
}

function LoginRow({ login }: { login: VaultLogin }) {
  const { secrets, nodes } = useKururu();
  const to = login.kind ? lentTo(login.kind, secrets, nodes?.nodes ?? []) : [];
  const parts = [
    login.where,
    login.changed ? `${login.tool === "claude" ? "signed in" : "changed"} ${when(login.changed)}` : null,
    login.profiles.length ? `used by ${login.profiles.join(", ")}` : null,
    to.length ? `lent to ${to.join(", ")}` : null,
  ].filter(Boolean);
  const who = login.account ?? (login.team ? `team ${login.team}` : null);
  return (
    <Readout
      label={`${TOOL[login.tool]} · ${login.name}`}
      tone={login.signedIn ? "ok" : "off"}
      value={login.signedIn ? (who ?? "signed in") : "not signed in"}
      hint={parts.join(" · ")}
    />
  );
}
