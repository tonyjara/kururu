/**
 * Settings → Connections → Claude API: the balance the bottom bar counts down
 * from, and the Admin key that counts it best.
 *
 * The page has to say first that the figure is an estimate and why, because
 * the first thing anybody will look for is a key that reads the balance, and
 * there is none (`shared/anthropiccredit.ts`). Then two steps: the balance,
 * which is all it takes when the Claude calls go through OpenRouter, and an
 * Admin key, which is better and asks more — an organisation on the Console,
 * and a key that can run it.
 */
import { useState } from "react";

import { creditLeft, SOURCE_NAMES } from "../../../shared/anthropiccredit";
import { formatDollars } from "../../../shared/openrouter";
import * as api from "../session";
import { useKururu } from "../session";
import { A, Btn, DangerButton, Details, errorText, Group, KeyRow, Mono, Outcome, P, Readout, Row, Step, Steps, useTyping, when } from "./ui";

const BILLING_URL = "https://platform.claude.com/settings/billing";
const ADMIN_KEYS_URL = "https://platform.claude.com/settings/admin-keys";
const ORG_URL = "https://platform.claude.com/settings/organization";

export function AnthropicCreditPage() {
  const { credit, openrouter } = useKururu();
  const left = credit ? creditLeft(credit) : null;
  const tone = !credit?.anchor ? "off" : credit.error ? "bad" : credit.reading ? "ok" : "busy";
  const value = !credit?.anchor
    ? "Not set up"
    : left !== null && credit.reading
      ? `≈${formatDollars(left)} left, counted by ${SOURCE_NAMES[credit.reading.source]}`
      : (credit.error ?? "Counting…");
  return (
    <>
      <Group
        title="Credit"
        foot="Anthropic tells no program what is left of your credit, so this is an estimate: the balance you read off the Console, less what has been spent since. Set the balance again whenever you top up."
      >
        <Readout label="On the bar" tone={tone} value={value} />
        {credit?.note && <Row label="Better" hint={credit.note} />}
      </Group>
      <Group title="Set up">
        <Steps>
          <Step
            n={1}
            done={Boolean(credit?.anchor)}
            title="Give the balance"
            line="The figure under Credit balance on the Console's Billing page, as it is now."
          >
            <Readout label="Billing page" value={<A href={BILLING_URL}>platform.claude.com/settings/billing</A>} />
            <BalanceRow />
            {!credit?.adminHint && (
              <P>
                {openrouter?.reading?.byok
                  ? "Without an Admin key it is counted from OpenRouter's BYOK totals: right if every Claude call goes through OpenRouter and Anthropic is your one BYOK provider there."
                  : "Without an Admin key it can only be counted from OpenRouter's BYOK totals, and OpenRouter is not saying them: give its management key in Settings → OpenRouter, or an Admin key below."}
              </P>
            )}
          </Step>
          <Step
            n={2}
            done={Boolean(credit?.adminHint)}
            title="Give an Admin key, for every call"
            line="Better: Anthropic's cost report sees every dollar the organisation spends, through OpenRouter or not."
          >
            <Readout label="Admin keys page" value={<A href={ADMIN_KEYS_URL}>platform.claude.com/settings/admin-keys</A>} />
            <Details summary="What an Admin key needs, and can do">
              <P>
                The Console only makes Admin keys for an organisation, and only for a member with the admin role — an individual account has none, and becomes an organisation on the{" "}
                <A href={ORG_URL}>Organization</A> page. Create one, name it kururu, and paste the <Mono>sk-ant-admin01-…</Mono> secret here; it is shown once.
              </P>
              <P>
                It cannot run a model, but it can manage the whole organisation: members, workspaces and every API key. kururu only ever reads the cost report with it, every five minutes while a
                window is open. It is kept in <Mono>~/.config/kururu/anthropic.json</Mono>, readable only by you, never sent back to a window, never in a backup and never lent to another node.
              </P>
            </Details>
            <KeyRow
              label="Key"
              placeholder="sk-ant-admin01-…"
              ariaLabel="Anthropic Admin key"
              stored={credit?.adminHint ? { hint: credit.adminHint, tone: credit.anchor?.sources.includes("cost-report") && credit.error ? "bad" : "ok" } : null}
              onSave={(key) => api.setAnthropicAdminKey(key)}
              removeAsk="Forget the key? The balance stays, counted from OpenRouter if it can be."
              onRemove={() => api.clearAnthropicAdminKey()}
            />
          </Step>
        </Steps>
      </Group>
    </>
  );
}

/**
 * The balance, as dollars and cents. Not `NumField`, which rounds to whole
 * numbers and commits on a blur: this is a figure somebody types off another
 * page, and it is taken when they press Save, as of that moment.
 */
function BalanceRow() {
  const { credit } = useKururu();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typing = useTyping();
  const amount = Number(text.replace(/[$,\s]/g, ""));
  const ready = text.trim() !== "" && Number.isFinite(amount) && amount >= 0;

  const save = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    api
      .setAnthropicBalance(amount)
      .then(() => setText(""))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const anchor = credit?.anchor;
  return (
    <Row
      label="Balance"
      hint={error ? <Outcome bad>{error}</Outcome> : anchor ? `${formatDollars(anchor.balance)}, set ${when(anchor.at)}` : "In dollars."}
      wide
      as="label"
    >
      <span className="st-keybox">
        <input
          className="st-input st-input-mono"
          inputMode="decimal"
          value={text}
          placeholder={anchor ? "A new balance, after a top-up" : "187.42"}
          aria-label="Anthropic credit balance in dollars"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
          {...typing}
        />
        <Btn primary disabled={!ready || busy} onClick={save}>
          {busy ? "Checking…" : "Save"}
        </Btn>
        {anchor && <DangerButton label="Remove" ask="Forget the balance? The chip goes back to set up." onConfirm={() => api.clearAnthropicBalance()} />}
      </span>
    </Row>
  );
}
