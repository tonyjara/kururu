/**
 * Settings → Connections → Web: the providers an agent's web call goes
 * through, in order, and each one's switch, fields, health and figures.
 *
 * The page knows fields, not providers. Each provider describes what it asks
 * for (an address, a key, a number) and what it wants read out, and this
 * draws that — so a provider added on the server is a provider on this page
 * with nothing written here, which is half of what makes a new one a single
 * file. What it cannot draw it does not get: a walkthrough of somebody's
 * sign-up is a paragraph in `about` and a link.
 *
 * The order is the policy, so it is the first thing on the page and the
 * arrows are the only way to change it. The hand-back sits in it like the
 * others, because that is where the line between free and paid is drawn.
 */
import { useState } from "react";
import { formatCount, type WebCallRecord, type WebField, type WebProviderStatus, type WebStatus, type WebStep } from "../../../shared/web";
import * as api from "../session";
import { useKururu } from "../session";
import { webKind } from "../../../shared/secrets";
import { HeldFrom, LentTo, useHeld } from "./Secrets";
import { A, Action, Banner, Details, Dot, Empty, errorText, Field, Group, IconBtn, Item, KeyRow, Mono, NumField, P, Readout, Toggle, when, type Tone } from "./ui";

export function WebPage() {
  const { web } = useKururu();
  if (!web) {
    return (
      <Group>
        <Empty>Waiting for the server…</Empty>
      </Group>
    );
  }
  return <Page status={web} />;
}

function Page({ status }: { status: WebStatus }) {
  const [error, setError] = useState<string | null>(null);
  const attempt = (work: Promise<unknown>) => {
    setError(null);
    work.catch((err: unknown) => setError(errorText(err)));
  };
  const ids = status.providers.map((p) => p.id);
  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    const [moved] = next.splice(i, 1);
    if (moved === undefined) return;
    next.splice(i + by, 0, moved);
    attempt(api.setWeb({ order: next }));
  };

  return (
    <>
      {error && <Banner tone="bad">{error}</Banner>}

      <Group
        title="Order"
        foot="An agent's web call goes down this list until something brings back the page. A challenge page, a wall or nothing at all counts as a failure, and the answer says who served it. Past the agent's own tools, only when the agent says those failed too."
      >
        {status.providers.map((p, i) => (
          <Item key={p.id} lead={<OrderLead n={i + 1} tone={toneOf(p)} />} name={p.paid ? `${p.label} · paid` : p.label} sub={lineOf(p)}>
            <IconBtn glyph="↑" label={`Move ${p.label} up`} disabled={i === 0} onClick={() => move(i, -1)} />
            <IconBtn glyph="↓" label={`Move ${p.label} down`} disabled={i === status.providers.length - 1} onClick={() => move(i, 1)} />
          </Item>
        ))}
      </Group>

      {status.providers.map((p, i) => (
        <ProviderGroup key={p.id} n={i + 1} provider={p} attempt={attempt} />
      ))}

      <Group title="Limits">
        <NumField
          label="Pages per call"
          hint="The most one crawl, or one PDF, may fetch, whoever does it."
          value={status.pageLimit}
          min={1}
          max={500}
          ariaLabel="The most pages one web call may fetch"
          onCommit={(pageLimit) => attempt(api.setWeb({ pageLimit }))}
        />
      </Group>

      {status.recent.length > 0 && (
        <Group title="Recent calls">
          {status.recent.map((call) => (
            <Recent key={`${call.at}-${call.target}`} call={call} />
          ))}
        </Group>
      )}
    </>
  );
}

function OrderLead({ n, tone }: { n: number; tone: Tone }) {
  return (
    <>
      <span className="st-when">{n}</span> <Dot tone={tone} />
    </>
  );
}

/** One provider's card: its switch, what it can do, whether it answers, and what it asks for. */
function ProviderGroup({ n, provider: p, attempt }: { n: number; provider: WebProviderStatus; attempt: (work: Promise<unknown>) => void }) {
  // Lent by the parent: its address and key are the parent's, and a field
  // here would be written over by the next push, so the line stands in for
  // them. The switch, a budget and the figures stay this node's own.
  const held = useHeld(webKind(p.id));
  return (
    <Group title={`${n} · ${p.label}`} foot={p.summary}>
      <Toggle label="On" hint={switchHint(p)} on={p.enabled} onChange={(enabled) => attempt(api.setWebProvider(p.id, { enabled }))} />
      <Readout label="Can" value={p.can.join(", ")} />
      {p.kind === "service" && (
        <Readout label="Health" tone={healthTone(p)} value={p.ready ? (p.health.detail ?? "Not checked yet.") : "Not set up."} hint={p.health.at ? `Checked ${when(p.health.at)}` : undefined} />
      )}
      {held && <HeldFrom kind={webKind(p.id)} />}
      {p.fields
        .filter((field) => !held || field.kind === "number")
        .map((field) => (
          <FieldRow key={field.name} provider={p} field={field} attempt={attempt} />
        ))}
      <LentTo kind={webKind(p.id)} />
      {p.readouts.map((r) => (
        <Readout key={r.label} label={r.label} value={r.value} tone={r.tone} />
      ))}
      {p.test && <TestRow provider={p} />}
      {(p.about.length > 0 || p.links.length > 0) && (
        <Details summary="What it is, and what leaves this Mac">
          {p.about.map((text) => (
            <P key={text.slice(0, 40)}>{text}</P>
          ))}
          {p.links.length > 0 && (
            <P>
              {p.links.map((link, i) => (
                <span key={link.href}>
                  {i > 0 && " · "}
                  <A href={link.href}>{link.label}</A>
                </span>
              ))}
            </P>
          )}
        </Details>
      )}
    </Group>
  );
}

function FieldRow({ provider: p, field, attempt }: { provider: WebProviderStatus; field: WebField; attempt: (work: Promise<unknown>) => void }) {
  const aria = `${p.label}: ${field.label}`;
  switch (field.kind) {
    case "url":
      return (
        <Field
          label={field.label}
          hint={field.hint}
          value={field.value ?? ""}
          placeholder={field.placeholder}
          mono
          ariaLabel={aria}
          onCommit={(value) => attempt(value.trim() ? api.setWebProvider(p.id, { field: field.name, value }) : api.clearWebProviderField(p.id, field.name))}
        />
      );
    case "secret":
      return (
        <KeyRow
          label={field.label}
          hint={field.hint}
          placeholder={field.placeholder}
          ariaLabel={aria}
          stored={field.held ? { hint: field.held, tone: healthTone(p) } : null}
          onSave={(value) => api.setWebProvider(p.id, { field: field.name, value })}
          removeAsk={`Forget ${p.label}'s ${field.label.toLowerCase()}?`}
          onRemove={() => attempt(api.clearWebProviderField(p.id, field.name))}
        />
      );
    case "number":
      return (
        <NumField
          label={field.label}
          hint={field.hint}
          value={field.value}
          min={field.min}
          max={field.max}
          unit={field.unit}
          ariaLabel={aria}
          onCommit={(value) => attempt(api.setWebProvider(p.id, { field: field.name, value }))}
        />
      );
  }
}

function TestRow({ provider: p }: { provider: WebProviderStatus }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; bad?: boolean } | null>(null);
  return (
    <Action
      label="Test"
      hint={p.test}
      button="Test"
      busy={busy}
      busyLabel="Testing…"
      disabled={!p.ready}
      outcome={outcome}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        setOutcome(null);
        api
          .testWebProvider(p.id)
          .then((said) => setOutcome({ text: said }))
          .catch((err: unknown) => setOutcome({ text: errorText(err), bad: true }))
          .finally(() => setBusy(false));
      }}
    />
  );
}

function Recent({ call }: { call: WebCallRecord }) {
  const what = call.tool === "test" ? "test" : call.tool.replace("_", " ");
  const result =
    call.outcome === "served"
      ? `by ${call.served}`
      : call.outcome === "handed-back"
        ? "handed back to the agent"
        : call.outcome === "refused"
          ? "refused"
          : "nothing served it";
  const failed = call.steps.filter((s) => s.outcome === "failed").map(stepWords);
  return (
    <Item
      className={call.outcome === "served" || call.outcome === "handed-back" ? undefined : "st-item-bad"}
      lead={<span className="st-when">{when(call.at)}</span>}
      name={<Mono title={call.target}>{call.target}</Mono>}
      sub={[what, result, ...failed, call.credits ? `${formatCount(call.credits)} cr` : null, call.agent, call.error, call.times ? `×${call.times}` : null].filter(Boolean).join(" · ")}
      title={call.steps.map(stepWords).join("\n")}
    />
  );
}

function stepWords(step: WebStep): string {
  const ms = step.ms !== null && step.ms > 0 ? ` (${(step.ms / 1000).toFixed(1)} s)` : "";
  switch (step.outcome) {
    case "served":
      return `${step.label} served${ms}`;
    case "failed":
      return `${step.label}: ${step.failure}${step.reason ? `, ${step.reason}` : ""}${ms}`;
    case "skipped":
      return `${step.label} skipped: ${step.reason ?? ""}`;
    case "passed":
      return `${step.label} passed: ${step.reason ?? ""}`;
    case "stopped":
      return `${step.label}: handed back`;
  }
}

function healthTone(p: WebProviderStatus): Tone {
  if (!p.enabled) return "off";
  if (!p.ready) return "off";
  return p.health.state === "ok" ? "ok" : p.health.state === "bad" ? "bad" : "busy";
}

function toneOf(p: WebProviderStatus): Tone {
  return p.kind === "handback" ? (p.enabled ? "ok" : "off") : healthTone(p);
}

/** The order's second line: whether it will be tried, and if not why. */
function lineOf(p: WebProviderStatus): string {
  if (!p.enabled) return "Off";
  if (p.kind === "handback") return "Hands the call back; what is after it waits for the agent's say-so";
  if (!p.ready) return "Not set up";
  return p.health.detail ?? (p.health.state === "ok" ? "Answering" : "Not checked yet");
}

function switchHint(p: WebProviderStatus): string {
  if (p.kind === "handback") {
    return p.enabled ? "On: calls stop here unless the agent says its own tools failed." : "Off: what is after it is tried without the agent's own tools in between.";
  }
  if (!p.ready) return "Set it up below; until then it is passed over.";
  return p.enabled ? "On: tried in its place in the order." : "Off: passed over.";
}
