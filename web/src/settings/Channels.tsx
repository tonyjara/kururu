/**
 * Settings → Kuru → Channels: talking to Kuru from Telegram, set up from nothing.
 *
 * A walkthrough rather than a form, because the person on this page has most
 * likely never made a Telegram bot, and the things it needs — a bot, its
 * token, their own account id — come from three different places, one of
 * which Telegram does not show anywhere in its app. So the steps are in
 * order, each ticked as the server confirms it, with the controls inside. The
 * id is found for you: pairing shows a code, you send it to the bot, and the
 * account it came from is offered here to allow — this Mac deciding, not the
 * bot.
 *
 * What leaves the machine is on the page, folded, because it is a decision
 * and it is the user's to make knowing what it is. The token goes to the
 * server once and is never sent back; what this draws afterwards is the
 * status every window is sent, whose `hint` is the last four of it.
 *
 * With other kururus linked, the bot is still one bot, read by one node at a
 * time (`docs/nodes.md`, "One Telegram"), so the page grows a list of the
 * nodes by rank: which reads the chat now, and which could. On a child it
 * is that list and little else — the bot, the switch and the accounts are
 * the parent's, set on the parent's page.
 */
import { useState } from "react";
import { channelReady, nodeSubject, pairingLink, userLabel, type LeadStatus, type TelegramStatus } from "../../../shared/channels";
import type { ProfileSummary } from "../../../shared/model";
import { QrCode } from "../components/Reach";
import * as api from "../session";
import { useKururu } from "../session";
import { HeldFrom, LentTo, useHeld } from "./Secrets";
import { A, Action, AddRow, Banner, Btn, DangerButton, Details, Dot, Empty, errorText, Group, Item, KeyRow, Mono, Outcome, P, Readout, Row, Select, Step, Steps, Toggle, when, type Tone } from "./ui";

const BOTFATHER = "https://t.me/BotFather";

export function ChannelsPage({ profiles }: { profiles: ProfileSummary[] }) {
  const { channels } = useKururu();
  if (!channels) {
    return (
      <Group>
        <Empty>Waiting for the server…</Empty>
      </Group>
    );
  }
  return <Telegram status={channels.telegram} profiles={profiles} />;
}

function Telegram({ status, profiles }: { status: TelegramStatus; profiles: ProfileSummary[] }) {
  const [error, setError] = useState<string | null>(null);
  const ready = channelReady(status);
  const change = (patch: Parameters<typeof api.setChannel>[1]) => {
    setError(null);
    api.setChannel("telegram", patch).catch((err: unknown) => setError(errorText(err)));
  };
  const bot = status.bot ? `@${status.bot.username}` : "the bot";
  const held = useHeld("telegram");

  // A child of a shared channel: the bot, the switch and the list are the
  // parent's, and what this node has of its own is where it stands in the
  // rank and which Kuru it speaks for.
  const lead = status.lead;
  if (lead?.heldFrom) {
    const parent = nodeSubject(lead.heldFrom);
    return (
      <>
        {error && <Banner tone="bad">{error}</Banner>}
        <Group
          title="Telegram"
          foot={
            held
              ? `Reads the chat here while ${parent} is away; the token is held from ${parent}. The switch and the accounts are ${parent}'s, in its Settings → Channels.`
              : `${parent}'s bot. This node's Kuru speaks in it through whichever node reads the chat. To let this node read it while ${parent} is away, lend it the token: ${parent}'s Settings → Nodes → this node → Secrets → Telegram.`
          }
        >
          <Readout label="Kuru listens" tone={status.enabled ? "ok" : "off"} value={status.enabled ? "On" : "Off"} hint={`${parent}'s switch, carried here in the roster.`} />
          {held && <HeldFrom kind="telegram" label="Token" />}
          <Select label="Talks to" value={status.profileId ?? ""} ariaLabel="The profile whose Kuru Telegram talks to" onChange={(value) => change({ profileId: value || null })}>
            <option value="">Whichever profile is active</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </Select>
        </Group>
        <WhoAnswers lead={lead} />
      </>
    );
  }

  // Held from a parent whose kururu is from before the chat was shared: its
  // roster does not carry the channel, so this node cannot read it for the
  // others, and nothing here is this node's to set.
  if (held) {
    return (
      <Group title="Telegram" foot={`${held.from} answers this bot. Its kururu is too old to share the chat with this node; update it, and this node reads the chat while ${held.from} is away.`}>
        <HeldFrom kind="telegram" label="Token" />
      </Group>
    );
  }

  return (
    <>
      {status.ignored.count > 0 && (
        <Banner action={<Btn onClick={() => api.clearChannelIgnored("telegram")}>OK</Btn>}>
          Ignored {status.ignored.count === 1 ? "a message" : `${status.ignored.count} messages`} from {status.ignored.last ?? "an account"} not on your list
          {status.ignored.lastAt ? `, last ${when(status.ignored.lastAt)}` : ""}. Somebody found your bot; nothing reached Kuru and the bot did not answer.
        </Banner>
      )}
      {error && <Banner tone="bad">{error}</Banner>}

      <Group title="Telegram" foot="A message there reaches Kuru as if typed in the drawer, and the drawer shows those turns marked with where they came from.">
        <Toggle label="Kuru listens" hint={describe(status, ready)} on={status.enabled} disabled={!ready} onChange={(enabled) => change({ enabled })} />
        <Select label="Talks to" value={status.profileId ?? ""} ariaLabel="The profile whose Kuru Telegram talks to" onChange={(value) => change({ profileId: value || null })}>
          <option value="">Whichever profile is active</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </Select>
        <Toggle
          label="Speak replies here"
          hint="Replies to Telegram messages, read aloud on this Mac too. Off, since you are probably not at it."
          on={status.speakReplies}
          onChange={(speakReplies) => change({ speakReplies })}
        />
      </Group>

      {lead && <WhoAnswers lead={lead} />}

      <Group title="Set up">
        <Steps>
          <Step n={1} done={status.hint !== null} title="Make a bot" line={<>Send <Mono>/newbot</Mono> to BotFather and keep the token.</>}>
            <Readout label="BotFather" value={<A href={BOTFATHER}>t.me/BotFather</A>} />
            <Details summary="What to tell it">
              <P>
                Give the bot a name, anything, and a username ending in <Mono>bot</Mono>, such as <Mono>yourname_kuru_bot</Mono>. BotFather answers with a token like{" "}
                <Mono>123456789:AAH…</Mono>. That is the bot's password: whoever has it can read what the bot is sent and write as the bot, so paste it here and nowhere else.
              </P>
              <P>
                Optional: send <Mono>/setjoingroups</Mono>, pick the bot and choose Disable, so nobody can add it to a group. kururu ignores groups either way.
              </P>
            </Details>
          </Step>

          <Step n={2} done={status.hint !== null} title="Give kururu the token">
            <KeyRow
              label="Token"
              placeholder="123456789:AAH…"
              ariaLabel="Telegram bot token"
              stored={status.hint ? { hint: `…${status.hint}`, tone: status.error ? "bad" : status.link === "listening" ? "ok" : "off", text: status.bot ? <A href={`https://t.me/${status.bot.username}`}>@{status.bot.username}</A> : "a bot" } : null}
              hint={
                <>
                  Checked with Telegram, then kept in <Mono>~/.config/kururu/telegram.json</Mono>, never sent back, never backed up. Leaked? Send BotFather <Mono>/revoke</Mono>.
                </>
              }
              onSave={(token) => api.setChannelToken("telegram", token)}
              removeLabel="Forget"
              removeAsk="Forget the bot, its token and your account?"
              onRemove={() => api.forgetChannel("telegram")}
            />
            <LentTo kind="telegram" />
          </Step>

          <Step n={3} done={status.allowed.length > 0} title="Say which account is yours" line="Only accounts on this list can talk to Kuru; anyone else is ignored without an answer.">
            <Account status={status} />
          </Step>

          <Step n={4} done={status.lastOutAt !== null && status.allowed.length > 0} title="Send a test message">
            <Test status={status} />
          </Step>
        </Steps>
      </Group>

      <Group title="What leaves this Mac">
        <Details summary="Your conversation's text goes through Telegram's servers, which do not encrypt bot chats end to end.">
          <P>
            While the channel is on: what you write in Telegram, every reply of Kuru's, and a quiet copy of what you say or type to Kuru here, so the chat reads like the drawer.
            Your voice never leaves, only the words. Nothing listens on a port: kururu asks Telegram for new messages, and asks nothing while the channel is off. What you send{" "}
            {bot} while it is off is not passed on later.
          </P>
        </Details>
      </Group>
    </>
  );
}

/** The line under the switch: where the channel stands, in a few words. */
function describe(status: TelegramStatus, ready: boolean): string {
  if (!status.hint) return "Not set up: the steps below take a few minutes.";
  const bot = status.bot ? `@${status.bot.username}` : "the bot";
  const parts: string[] = [];
  const lead = status.lead;
  if (status.error) parts.push(status.error);
  else if (status.enabled && lead && !lead.polls) parts.push(lead.holder ? `On; ${nodeSubject(lead.holder)} reads the chat for now` : "On; no node reads the chat right now");
  else if (status.enabled) parts.push(status.link === "listening" ? `On, listening as ${bot}` : `On, connecting as ${bot}…`);
  else if (status.pairing) parts.push(`Off; listening as ${bot} for the pairing code only`);
  else if (!ready) parts.push("Off: your account is not on the list yet");
  else parts.push("Off");
  if (status.lastInAt) parts.push(`last message ${when(status.lastInAt)}`);
  if (status.waiting) parts.push(`${status.waiting} waiting to reach Telegram`);
  return parts.join(" · ");
}

function Account({ status }: { status: TelegramStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairing = status.pairing;
  const run = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    work()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {status.allowed.map((user) => (
        <Item key={user.id} name={userLabel(user)} sub={<Mono>id {user.id}</Mono>}>
          <DangerButton label="Remove" ask={`Remove ${userLabel(user)}?`} onConfirm={() => api.disallowChannelUser("telegram", user.id)} />
        </Item>
      ))}

      {!pairing ? (
        <Action
          label={status.allowed.length ? "Pair another account" : "Pair your account"}
          hint={status.hint ? "Shows a code to send the bot; the account it comes from is offered here to allow." : "Save the token first."}
          button="Pair"
          primary
          disabled={!status.hint || busy}
          onClick={() => run(() => api.pairChannel("telegram", true))}
        />
      ) : pairing.candidate ? (
        <Row label={`From ${userLabel(pairing.candidate)}`} hint={<>id {pairing.candidate.id}. The name is whatever the account calls itself, so check it is the one you sent the code from.</>}>
          <Btn onClick={() => api.refuseChannelUser("telegram")}>Not me</Btn>
          <Btn primary disabled={busy} onClick={() => run(() => api.allowChannelUser("telegram", pairing.candidate!.id))}>
            Allow
          </Btn>
        </Row>
      ) : (
        <Row label="Pairing" hint={`The code works until ${new Date(pairing.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`} wide>
          <div className="st-pair">
            {status.bot && <QrCode text={pairingLink(status.bot.username, pairing.code)} />}
            <div className="st-pair-words">
              <span className="st-hint">
                On your phone, scan this or open {status.bot ? <A href={pairingLink(status.bot.username, pairing.code)}>the link</A> : "the bot"} and press <b>Start</b>. Or send{" "}
                {status.bot ? <Mono>@{status.bot.username}</Mono> : "the bot"} this code:
              </span>
              <span className="st-code">{pairing.code}</span>
              <span>
                <Btn onClick={() => run(() => api.pairChannel("telegram", false))}>Cancel</Btn>
              </span>
            </div>
          </div>
        </Row>
      )}

      <Row label="Or by id" hint="Telegram's app does not show your id; a bot such as @userinfobot does." wide>
        <AddRow placeholder="123456789" ariaLabel="Telegram account id" mono disabled={!status.hint || busy} onAdd={(id) => run(() => api.allowChannelUser("telegram", id))} />
      </Row>
      {error && <Row label="" hint={<Outcome bad>{error}</Outcome>} />}
    </>
  );
}

function Test({ status }: { status: TelegramStatus }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; bad?: boolean } | null>(null);
  return (
    <Action
      label="Test message"
      hint="One line to every account on the list. A bot can only write to someone who has written to it first: open the bot and press Start if Telegram refuses."
      button="Send"
      busy={busy}
      busyLabel="Sending…"
      disabled={!channelReady(status)}
      outcome={result}
      onClick={() => {
        setBusy(true);
        setResult(null);
        api
          .testChannel("telegram")
          .then((text) => setResult({ text }))
          .catch((err: unknown) => setResult({ text: errorText(err), bad: true }))
          .finally(() => setBusy(false));
      }}
    />
  );
}

/**
 * The nodes by rank and where each stands on the chat: the one reading it,
 * the ones that could take it over, and why the rest cannot. The rule is
 * `LeadGate`'s; this only says what it decided, in the words of the
 * plan's promise — thirty seconds to take over, a minute to hand back.
 */
function WhoAnswers({ lead }: { lead: LeadStatus }) {
  const now = Date.now();
  return (
    <Group
      title="Who reads the chat"
      foot="One kururu at a time reads the bot: the highest-ranked that can. The next takes over thirty seconds after those above it go quiet, and hands the chat back a minute after they return. @name or /name in the chat, or a reply to a line, reaches that node's Kuru. Rank is set in Settings → Nodes on the parent."
    >
      {lead.standingDownUntil && lead.standingDownUntil > now && (
        <Row label="Standing down" hint={`Telegram said another node read the bot at the same moment, so this one waits until ${new Date(lead.standingDownUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`} />
      )}
      {lead.nodes.map((node) => {
        const { tone, line } = standing(node, lead);
        return <Item key={node.id} lead={<Dot tone={tone} />} name={`${node.rank}. ${node.name}${node.self ? " (this node)" : ""}${node.parent ? " · parent" : ""}`} sub={line} />;
      })}
    </Group>
  );
}

function standing(node: LeadStatus["nodes"][number], lead: LeadStatus): { tone: Tone; line: string } {
  if (node.polls) return { tone: "ok", line: "Reads the chat now" };
  if (node.self) return lead.eligible ? { tone: "off", line: "Can read it, and does while those above it are away" } : { tone: "warn", line: `Cannot read it: ${lead.why ?? "not eligible"}` };
  if (!node.up) return { tone: "off", line: `Away${node.since ? ` since ${when(node.since)}` : ""}${node.eligible ? "; can read it when back" : ""}` };
  if (node.eligible === null) return { tone: "off", line: "Its kururu is too old to read the chat for the others (kururu child update)" };
  return node.eligible ? { tone: "off", line: "Can read it" } : { tone: "off", line: "Cannot read it: no token lent, the channel off, or no Claude login there" };
}
