/**
 * The secrets lent between nodes, as Settings draws them in four places:
 * a child's grants on the parent's Nodes page, what a child holds on its
 * own, the line a key's own page draws instead of its field, and the
 * Agents page's "Lend this login to a node".
 *
 * One file rather than a line in each page, because the four are the same
 * fact seen from different sides — the parent lent this, the child holds
 * it — and the words for it should be one set. The pages keep their own
 * fields; what they ask here is whether this node holds the kind from its
 * parent, and when it does they draw the line instead of the field, since a
 * value pasted on a child would be written over by the parent's next push.
 *
 * Hints only, on both nodes: the server never sends a value or a digest to
 * a page.
 */
import { useState } from "react";
import type { NodeStatus } from "../../../shared/nodes";
import { grantText, kindOf, type CatalogueEntry, type GrantView, type HeldView } from "../../../shared/secrets";
import * as api from "../session";
import { useKururu } from "../session";
import { Btn, DangerButton, Details, errorText, Group, KeyRow, Mono, Outcome, P, Readout, Row, Step, Steps, Toggle, when } from "./ui";

/** What this node holds of a kind from its parent, or null — a kind it holds of its own, or not at all. */
export function useHeld(kind: string): { held: HeldView; from: string } | null {
  const { secrets } = useKururu();
  const held = secrets.held.find((h) => h.kind === kind);
  return held && secrets.heldFrom ? { held, from: secrets.heldFrom } : null;
}

/**
 * The line a granted kind's page draws on a child, in place of its field:
 * who lent it, its hint, since when, and where it is changed. Nothing to
 * press, because nothing here is the child's to change.
 */
export function HeldFrom({ kind, label }: { kind: string; label?: string }) {
  const held = useHeld(kind);
  if (!held) return null;
  return (
    <Readout
      label={label ?? "Held from"}
      tone="ok"
      value={
        <>
          {held.from} · <Mono>{held.held.hint}</Mono>
        </>
      }
      hint={`Lent by ${held.from} ${when(held.held.since)}${held.held.updated !== held.held.since ? `, last sent ${when(held.held.updated)}` : ""}. It is changed there, in Settings, and sent here within seconds; ${held.from}'s Settings → Nodes takes it back.`}
    />
  );
}

/**
 * On the parent, under a key's own field: which nodes hold it, and whether
 * each has the version just pasted. That is the acknowledgement a rotation
 * waits for, drawn where the new key went in.
 */
export function LentTo({ kind }: { kind: string }) {
  const { secrets, nodes } = useKururu();
  if (!nodes || nodes.role !== "parent") return null;
  const lent = nodes.nodes.flatMap((node) => {
    const grant = secrets.grants[node.id]?.find((g) => g.kind === kind && g.on);
    return grant ? [{ node, grant }] : [];
  });
  if (!lent.length) return null;
  return (
    <Readout
      label="Lent to"
      tone={lent.every(({ grant }) => grant.state === "held") ? "ok" : lent.some(({ grant }) => grant.state === "failed") ? "bad" : "busy"}
      value={lent.map(({ node, grant }) => `${node.name}${grant.state === "held" ? "" : ` (${shortState(grant)})`}`).join(", ")}
      hint="A new value pasted here is sent to each within seconds; Settings → Nodes says which have it."
    />
  );
}

function shortState(grant: GrantView): string {
  switch (grant.state) {
    case "sending":
      return "sending";
    case "waiting":
      return "when it links";
    case "failed":
      return "refused";
    case "missing":
      return "nothing to send";
    default:
      return grant.state;
  }
}

/**
 * Settings → Nodes, on the parent, one per child: every kind this Mac
 * could lend, each a switch, with how it stands for that node under it.
 * Off by default, and a node holds only what is switched on here.
 */
export function NodeSecrets({ node }: { node: NodeStatus }) {
  const { secrets } = useKururu();
  const [error, setError] = useState<string | null>(null);
  const grants = new Map((secrets.grants[node.id] ?? []).map((g) => [g.kind, g] as const));
  const attempt = (work: Promise<unknown>) => {
    setError(null);
    work.catch((err: unknown) => setError(errorText(err)));
  };
  // Kinds this Mac has, then kinds it has none of; a kind nobody has set and
  // nobody holds is listed too, dimmed, so the page says what could be lent.
  const entries = [...secrets.catalogue].sort((a, b) => Number(b.hint !== null) - Number(a.hint !== null));

  return (
    <Group
      title={`Secrets lent to ${node.name}`}
      foot={`${node.name} holds only what is switched on here: each is sealed to its key, sent over its link and written as the same file this Mac keeps. Off takes it back.`}
    >
      {entries.map((entry) => (
        <SecretRow key={entry.kind} node={node} entry={entry} grant={grants.get(entry.kind)} attempt={attempt} />
      ))}
      {error && <Row label="" hint={<Outcome bad>{error}</Outcome>} />}
      <Details summary="How lending works">
        <P>
          Each secret is sealed to {node.name}'s own key with a key made for that one push, so only {node.name} can open it, and signed by this Mac, so {node.name} takes it
          from nobody else. It is sent when you switch it on, whenever {node.name} links, and within seconds of the key changing here. A Codex login is the exception:
          Codex refreshes it on each machine by itself, so it is copied once, and Push again sends this Mac's again.
        </P>
        <P>
          Off removes the file from {node.name}. It does not end the credential: anything that read it while it was there could have kept it. The line under each one says
          how to end it at the source as well.
        </P>
      </Details>
    </Group>
  );
}

function SecretRow({ node, entry, grant, attempt }: { node: NodeStatus; entry: CatalogueEntry; grant: GrantView | undefined; attempt: (work: Promise<unknown>) => void }) {
  const on = grant?.on ?? false;
  const none = entry.hint === null;
  const line = grant && grant.state !== "off" ? grantText(grant, node.name) : none ? "This Mac has none to lend yet." : `Lends ${entry.hint} · unlocks ${entry.unlocks}.`;
  const again = grant?.on && (grant.state === "failed" || grant.older) && node.state === "up";
  return (
    <>
      <Toggle
        label={entry.label}
        hint={
          <>
            {grant?.state === "failed" ? <Outcome bad>{line}</Outcome> : line}
            {grant && !on && grant.forgotAt && (
              <>
                {" "}
                Taken back {when(grant.forgotAt)}. To end it at the source too: {entry.revoke}
              </>
            )}
          </>
        }
        on={on}
        disabled={!on && none}
        onChange={(next) => attempt(api.grantSecret(node.id, entry.kind, next))}
      />
      {again && (
        <Row label="" hint={grant.state === "failed" ? "Try it again once that is put right." : "Sends this Mac's copy over the one it holds."}>
          <Btn onClick={() => attempt(api.pushSecret(node.id, entry.kind))}>{grant.state === "failed" ? "Try again" : "Push again"}</Btn>
        </Row>
      )}
    </>
  );
}

/** On a child: everything it holds from the parent, by hint. */
export function HeldList() {
  const { secrets } = useKururu();
  const from = secrets.heldFrom ?? "the parent";
  return (
    <Group
      title={`Held from ${from}`}
      foot={`Lent by ${from}: switched on and off in its Settings → Nodes → Secrets, and changed there. Each is kept here at 0600 as the same file ${from} keeps, and let go of if this node leaves the roster.`}
    >
      {secrets.held.length === 0 ? (
        <Row label="Nothing" hint={`${from} has lent this node nothing. Its own Settings → Nodes has a switch for each.`} />
      ) : (
        secrets.held.map((held) => <Readout key={held.kind} label={held.label} tone="ok" value={<Mono>{held.hint}</Mono>} hint={`Since ${when(held.since)}`} />)
      )}
    </Group>
  );
}

/**
 * Settings → Agents, on the Mac: lend the profile's Claude login to a node
 * as a token, for a box whose user cannot open a browser anywhere. The
 * usual road is a `/login` on the box itself, which the setup wizard walks;
 * this is the other one, and the page says which is which before anything.
 */
export function LendLogin({ profileId, profileName, perProfile }: { profileId: string; profileName: string; perProfile: boolean }) {
  const { secrets, nodes, snapshot } = useKururu();
  const [error, setError] = useState<string | null>(null);
  if (!nodes || nodes.role === "child") return null;
  // The login this profile's terminals run as, which is the one its tab mints a token for.
  const login = perProfile && snapshot ? snapshot.profile.loginKey : "machine";
  const mine = secrets.lends.find((lend) => lend.login === login) ?? null;
  const others = secrets.lends.filter((lend) => lend !== mine);
  const open = () => {
    setError(null);
    api.openClaudeLend(profileId).catch((err: unknown) => setError(errorText(err)));
  };
  const labelOf = (login: string) => (login === "machine" ? "this Mac's login" : `login ${login}`);
  // Inside step 2 until a token is kept, then under the steps: a done step
  // folds to its title, and this is how a token is replaced or forgotten.
  const field = (
    <>
      <KeyRow
        label="Token"
        placeholder="sk-ant-oat01-…"
        ariaLabel="The token claude setup-token printed"
        stored={mine ? { hint: `${mine.hint}${mine.account ? ` · ${mine.account}` : ""}`, tone: "ok", text: labelOf(mine.login) } : null}
        hint={
          <>
            Kept in <Mono>~/.config/kururu/claude-lend.json</Mono>, readable only by you, never sent to a window, never backed up, and sent to no node until it is
            switched on for one.
          </>
        }
        onSave={(token) => api.lendClaude(profileId, token)}
        removeAsk="Forget the token here? A node holding it keeps it until it is switched off for that node."
        onRemove={() => {
          if (mine) void api.unlendClaude(mine.login);
        }}
      />
      {others.map((lend) => (
        <Row key={lend.login} label={labelOf(lend.login)} hint={`${lend.hint}${lend.account ? ` · ${lend.account}` : ""} · another profile's`}>
          <DangerButton label="Forget" ask="Forget this token here? A node holding it keeps it until it is switched off for that node." onConfirm={() => void api.unlendClaude(lend.login)} />
        </Row>
      ))}
    </>
  );

  return (
    <Group
      title="Lend this login to a node"
      foot="For a computer where nobody can open a browser. Anywhere a browser can be opened, even on a phone, a /login on that computer is better: its own login, revocable on its own. The setup wizard walks that."
    >
      <Steps>
        <Step n={1} done={mine !== null} title="Make a token" line={<>Runs <Mono>claude setup-token</Mono> in a tab, as {profileName}'s login. It opens a browser here and prints a token.</>}>
          <Row label="" hint={error ? <Outcome bad>{error}</Outcome> : undefined}>
            <Btn onClick={open}>Open the tab</Btn>
          </Row>
          <Details summary="What the token is">
            <P>
              A token that only makes model requests, on the same subscription and limits as this Mac, for a year. On the node it is set as{" "}
              <Mono>CLAUDE_CODE_OAUTH_TOKEN</Mono> in every terminal kururu opens there, which outranks a <Mono>/login</Mono> on that computer. The bar on this Mac is the only
              gauge of what both spend.
            </P>
          </Details>
        </Step>
        <Step n={2} done={mine !== null} title="Paste it here">
          {mine === null && field}
        </Step>
        <Step n={3} done={Object.values(secrets.grants).some((grants) => grants.some((g) => g.on && kindOf(g.kind)?.family === "claude-token"))} title="Switch it on for the node">
          <Row label="" hint="Settings → Nodes, under the node's Secrets: Claude login, as a token." />
        </Step>
      </Steps>
      {mine !== null && field}
    </Group>
  );
}
