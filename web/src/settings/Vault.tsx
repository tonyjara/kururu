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
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { NEVER_SHARED } from "../../../shared/secrets";
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

      {[...new Set(view.workspaces.map((w) => w.profile))].map((profile) => (
        <Group
          key={profile}
          title={`Workspaces in ${profile}`}
          foot="The env files in each checkout, down two folders, by the names they set; never .env.example or a backup. Lent from the workspace's row in Settings → Nodes."
        >
          {view.workspaces
            .filter((w) => w.profile === profile)
            .map((w) => (
              <WorkspaceRows key={w.id} workspace={w} />
            ))}
        </Group>
      ))}

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

/** A workspace: its checkout, what it seems to use, and each env file folded over its names. */
function WorkspaceRows({ workspace: w }: { workspace: VaultWorkspace }) {
  const { secrets, nodes } = useKururu();
  const uses = [
    ...w.ssh.map((s) => `ssh ${s.alias} (${s.why})`),
    ...(w.github ? [`GitHub ${w.github.account}${w.github.signedIn ? "" : " (gh here is not signed in as it)"}`] : []),
  ];
  return (
    <>
      <Row label={w.name} hint={[w.checkout ?? "in no checkout here", ...uses].join(" · ")} />
      {w.checkout && w.env.length === 0 && <Row label="" hint="No env files." />}
      {w.env.map((env) => {
        const to = w.checkout ? envLentTo(w.checkout, env.file, secrets, nodes?.nodes ?? []) : [];
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
      <Group title="SSH hosts" foot="The Host entries in ~/.ssh/config that name one host, each with its key file's name. A key is read only once it is lent to a node.">
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
      <Group title="GitHub" foot="The accounts gh is signed in as on github.com. Their tokens stay in the Keychain; one is read only once it is lent to a node.">
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
