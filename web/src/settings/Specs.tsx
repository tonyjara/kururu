/**
 * Settings → Connections → Specs: what each machine is made of — the parts
 * read off it over ssh and kept, what you typed in beside them, and what
 * changed when.
 *
 * It is for the day a machine will not turn on, which is the day nothing can
 * be asked of it. So the page draws the last reading whether the machine
 * answers or not, says when that reading was taken, and says separately
 * whether the machine is answering now — two facts, because a reading from
 * last night is still the best thing known about a box that is dark this
 * morning, and the page must not look as if it had just asked.
 *
 * One machine at a time, chosen at the top like a workspace on Workspaces,
 * and opened on the machine you came from: the bottom bar's popover and the
 * rows of Machines each have a Specs that says which (`showSpecsOf`).
 *
 * Each part is one row: what was read as its hint, your words in its box.
 * Where the two disagree (`agreement`), neither is overwritten and the hint
 * says so — a typed board can be out of date after a swap nobody wrote
 * down, and a read one can be from before it. The purchase and the notes are
 * typed only; the history is both, a reading writing a line of its own when
 * it finds a part changed since the one before.
 *
 * It holds nothing but what is being typed; the specs are the server's.
 */
import { useState, type ReactNode } from "react";
import type { MachineStatus } from "../../../shared/machines";
import {
  agreement,
  biosLine,
  boardName,
  diskName,
  EMPTY_SPECS,
  gpuName,
  localDay,
  memorySize,
  PART_LABELS,
  PARTS,
  PHYSICAL_ONLY,
  readable,
  readLine,
  type HistoryEntry,
  type MachineSpecs,
  type PartKey,
  type SpecsReading,
} from "../../../shared/specs";
import * as api from "../session";
import { useKururu } from "../session";
import { AddRow, Btn, DangerButton, Dot, Empty, errorText, Field, Group, IconBtn, Item, Mono, Outcome, Readout, Row, Segments, Select, TextArea, TextBox, type Tone } from "./ui";

/**
 * The machine the page shows, for this window: the one a Specs button asked
 * for, or the one last chosen here. A module's variable rather than the
 * dialog's state, because the button that asks is on the bottom bar, outside
 * the dialog, and the dialog takes nothing but a page's name.
 */
let shown: string | null = null;

/** Open the page on this machine — set before asking for the page. */
export function showSpecsOf(machineId: string): void {
  shown = machineId;
}

const PLACEHOLDERS: Record<PartKey, string> = {
  cpu: "Model, cores, clocks",
  board: "Brand and model",
  memory: "Size, type, sticks",
  gpu: "Brand and model",
  storage: "Drives and sizes",
  network: "Brand and model of the card",
  psu: "Brand, model, watts",
  os: "Distribution, bootloader",
};

export function SpecsPage({ onMachines }: { onMachines: () => void }) {
  const { machines, specs } = useKururu();
  const [chosen, setChosen] = useState<string | null>(shown);
  const machine = machines.find((m) => m.id === chosen) ?? machines[0];

  if (!machine) {
    return (
      <Group>
        <Empty>No machines yet. Specs are kept for the machines kururu watches over ssh.</Empty>
        <Row label="Add one">
          <Btn onClick={onMachines}>Machines</Btn>
        </Row>
      </Group>
    );
  }

  const choose = (id: string) => {
    shown = id;
    setChosen(id);
  };
  const s = specs[machine.id] ?? EMPTY_SPECS;
  const options = machines.map((m) => [m.id, m.name] as const);

  return (
    <>
      {machines.length > 1 && (
        <Group>
          {machines.length <= 4 ? (
            <Row label="Machine" wide>
              <Segments value={machine.id} onChange={choose} label="Machine" options={options} />
            </Row>
          ) : (
            <Select label="Machine" value={machine.id} onChange={choose}>
              {options.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Group>
      )}
      <Reading key={`r-${machine.id}`} machine={machine} specs={s} />
      <Parts key={`p-${machine.id}`} machineId={machine.id} specs={s} />
      <Purchase key={`b-${machine.id}`} machineId={machine.id} specs={s} />
      <History key={`h-${machine.id}`} machineId={machine.id} entries={s.history} />
      {s.reading && <InFull reading={s.reading} />}
    </>
  );
}

/** "Oct 29, 14:03", with the year when it is not this one. */
function stamp(at: number): string {
  const date = new Date(at);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: thisYear ? undefined : "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "4 minutes ago", "3 hours ago", "2 days ago". */
function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/**
 * When it was read, whether it answers now, and Read now. The gauges' poll
 * is what says whether the machine answers, every fifteen seconds; the
 * reading is older by design, and the two are on separate rows so the age of
 * one is never taken for the state of the other.
 */
function Reading({ machine, specs }: { machine: MachineStatus; specs: MachineSpecs }) {
  const [pressed, setPressed] = useState<string | null>(null);
  const r = specs.reading;
  const answering = machine.error === null && machine.reading !== null;
  const now: { tone: Tone; text: string } = answering
    ? { tone: "ok", text: "Answering" }
    : machine.error
      ? { tone: "off", text: "Not answering" }
      : { tone: "busy", text: "Connecting…" };
  const failed = pressed ?? specs.error;

  const read = () => {
    setPressed(null);
    api.readSpecsNow(machine.id).catch((err: unknown) => setPressed(errorText(err)));
  };

  return (
    <Group
      title="Reading"
      foot="Read over ssh when the machine answers: the first time, every six hours after, and the moment it answers again after not answering — which is when a swap shows up. Kept, so it is here while the machine is off."
    >
      <Readout
        label="Last read"
        value={r ? `${stamp(r.at)} · ${ago(r.at)}` : "Never"}
        tone={r ? "ok" : "off"}
        hint={failed ? <Outcome bad>{failed}</Outcome> : !r ? `Nothing yet: ${machine.name} has not been read since it was added.` : undefined}
      >
        <Btn onClick={read} disabled={specs.busy}>
          {specs.busy ? "Reading…" : "Read now"}
        </Btn>
      </Readout>
      <Readout
        label="Now"
        value={now.text}
        tone={now.tone}
        hint={
          machine.error ? (
            <>
              {r ? "What is below is the last reading. " : ""}
              ssh said: {machine.error}
            </>
          ) : (
            <Mono>ssh {machine.host}</Mono>
          )
        }
      />
    </Group>
  );
}

/** Each part: what was read as the hint, your words in the box. */
function Parts({ machineId, specs }: { machineId: string; specs: MachineSpecs }) {
  const r = specs.reading;
  // A power supply means nothing in a VM; its row stays only if something was typed there.
  const parts = PARTS.filter((part) => !(r?.virt && PHYSICAL_ONLY.includes(part) && !specs.typed[part]));
  return (
    <Group title="Parts" lead="Your words in each box, what the machine said under the part's name. Where they disagree, both stay and the row says so.">
      {parts.map((part) => (
        <PartRow key={part} machineId={machineId} part={part} typed={specs.typed[part] ?? ""} reading={r} />
      ))}
    </Group>
  );
}

function PartRow({ machineId, part, typed, reading }: { machineId: string; part: PartKey; typed: string; reading: SpecsReading | null }) {
  const read = readLine(part, reading);
  let hint: ReactNode;
  if (!readable(part)) hint = "Not something ssh can read.";
  else if (!reading) hint = "Not read yet.";
  else if (!read) hint = "Nothing found.";
  else if (agreement(part, typed, reading) === false)
    hint = (
      <span className="specs-differs" title="What was read is not what is typed. Both are kept: the box may be out of date, or the reading may be from before a change.">
        <Dot tone="warn" /> Differs from what is typed. Read: {read}
      </span>
    );
  else hint = `Read: ${read}`;
  return (
    <Row label={PART_LABELS[part]} hint={hint} wide as="label">
      <TextArea oneLine value={typed} onCommit={(value) => api.setSpecs(machineId, part, value)} placeholder={PLACEHOLDERS[part]} ariaLabel={PART_LABELS[part]} />
    </Row>
  );
}

/** Who sold it, what it cost, when — and the notes. Typed only: no machine knows its own receipt. */
function Purchase({ machineId, specs }: { machineId: string; specs: MachineSpecs }) {
  const t = specs.typed;
  return (
    <Group title="Purchase and notes">
      <Field label="Bought from" value={t.seller ?? ""} onCommit={(v) => api.setSpecs(machineId, "seller", v)} placeholder="A shop, a seller, a provider" ariaLabel="Bought from" />
      <Field label="Paid" value={t.paid ?? ""} onCommit={(v) => api.setSpecs(machineId, "paid", v)} placeholder="Gs 1.400.000, or US$ 9 a month" ariaLabel="Paid" />
      <Field label="Bought on" value={t.bought ?? ""} onCommit={(v) => api.setSpecs(machineId, "bought", v)} placeholder="2026-10" ariaLabel="Bought on" />
      <Row label="Notes" hint="⌘Enter or a click away keeps it; Escape puts it back." wide as="label">
        <TextArea value={t.notes ?? ""} onCommit={(v) => api.setSpecs(machineId, "notes", v)} placeholder="Warranty, where the receipt is, what to try first" ariaLabel="Notes" />
      </Row>
    </Group>
  );
}

/**
 * What changed and when, newest first. A line is edited in place — its date
 * and its words each commit on their own, as every box here does — and
 * removed with the question every removal in Settings asks.
 */
function History({ machineId, entries }: { machineId: string; entries: HistoryEntry[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (change: Parameters<typeof api.specsHistory>[1]) => {
    setError(null);
    api.specsHistory(machineId, change).catch((err: unknown) => setError(errorText(err)));
  };

  return (
    <Group
      title="History"
      lead="What changed and when, newest first. A line marked read was written by a reading that found a part different from the reading before."
      foot={error ? <Outcome bad>{error}</Outcome> : undefined}
    >
      {entries.length === 0 && <Empty>Nothing yet. A swap, a repair, a day it would not start: add it below.</Empty>}
      {entries.map((entry) =>
        editing === entry.id ? (
          <EditLine key={entry.id} entry={entry} onChange={(change) => act({ op: "edit", entryId: entry.id, ...change })} onDone={() => setEditing(null)} />
        ) : (
          <Item
            key={entry.id}
            lead={<span className="specs-date">{entry.date || "undated"}</span>}
            name={entry.text}
            sub={entry.by === "read" ? "read: noticed by a reading" : undefined}
          >
            <IconBtn icon="edit" label="Edit this line" onClick={() => setEditing(entry.id)} />
            <DangerButton label="Remove" ask="Remove this line from the history?" onConfirm={() => act({ op: "remove", entryId: entry.id })} />
          </Item>
        ),
      )}
      <AddRow placeholder="What changed: motherboard swapped, PSU replaced…" label="Add" ariaLabel="Add a line to the history, dated today" onAdd={(text) => act({ op: "add", date: localDay(Date.now()), text })} />
    </Group>
  );
}

function EditLine({ entry, onChange, onDone }: { entry: HistoryEntry; onChange: (change: { date?: string; text?: string }) => void; onDone: () => void }) {
  return (
    <>
      <Row label="Date" hint="2026, 2026-10 or 2026-10-31; blank for undated." as="label">
        <TextBox mono value={entry.date} onCommit={(date) => onChange({ date })} aria-label="Date" placeholder="2026-10" />
      </Row>
      <Row label="What changed" wide as="label">
        <TextArea oneLine value={entry.text} onCommit={(text) => onChange({ text })} ariaLabel="What changed" />
      </Row>
      <Row label="">
        <Btn onClick={onDone}>Done</Btn>
      </Row>
    </>
  );
}

/**
 * Everything the reading holds that the part rows sum up: each stick, each
 * drive, each interface with its address and driver, the firmware. The page
 * for the moment somebody is on the phone with a shop, or deciding which
 * cable goes where.
 */
function InFull({ reading: r }: { reading: SpecsReading }) {
  const rows: { label: string; hint: ReactNode }[] = [];
  rows.push({ label: "Host", hint: [r.hostname, r.virt && `virtual (${r.virt})`].filter(Boolean).join(" · ") || "—" });
  if (r.cpu) {
    const c = r.cpu;
    const detail = [
      c.arch,
      c.sockets !== null && c.sockets > 1 && `${c.sockets} sockets`,
      c.cores !== null && `${c.cores} cores`,
      c.threads !== null && `${c.threads} threads`,
      c.maxMhz && `up to ${(c.maxMhz / 1000).toFixed(2)} GHz`,
      c.l3 && `L3 ${c.l3}`,
    ].filter(Boolean);
    rows.push({ label: "CPU", hint: `${c.model}${detail.length ? ` · ${detail.join(", ")}` : ""}` });
  }
  const board = boardName(r);
  if (board) rows.push({ label: "Board", hint: [board, r.board?.version && `revision ${r.board.version}`].filter(Boolean).join(" · ") });
  // A desktop's system name is usually its board's again; a prebuilt's or a VM's is not.
  if (r.board?.system && r.board.system !== board && !(r.board.name && r.board.system.includes(r.board.name))) rows.push({ label: "Machine", hint: r.board.system });
  const bios = biosLine(r);
  if (bios) rows.push({ label: "Firmware", hint: [r.board?.biosVendor, bios].filter(Boolean).join(" · ") });
  for (const [i, m] of (r.memory?.modules ?? []).entries()) {
    const kind = [memorySize(m.size), m.type && `${m.type}${m.speed ? `-${m.speed}` : ""}`].filter(Boolean).join(" ");
    rows.push({ label: m.slot ?? `Stick ${i + 1}`, hint: [kind, [m.maker, m.part].filter(Boolean).join(" ")].filter(Boolean).join(" · ") });
  }
  if (r.memory) {
    const usable = `${memorySize(r.memory.total)} usable`;
    rows.push({ label: "Memory", hint: r.memory.swap ? `${usable} · ${memorySize(r.memory.swap)} swap` : usable });
  }
  for (const d of r.disks) rows.push({ label: d.name, hint: diskName(d) });
  for (const g of r.gpus) {
    rows.push({
      label: "Graphics",
      hint: (
        <>
          {gpuName(g)}
          {g.memory ? ` · ${memorySize(g.memory)} video memory` : ""} · <Mono>{g.slot}</Mono>
        </>
      ),
    });
  }
  for (const n of r.nics) {
    const link = n.speed ? (n.speed >= 1000 ? `${n.speed / 1000} Gb/s` : `${n.speed} Mb/s`) : null;
    const facts = [n.wireless ? "Wi-Fi" : null, n.usb ? "USB" : null, n.state, link, n.driver && `driver ${n.driver}`].filter(Boolean).join(", ");
    rows.push({
      label: n.name,
      hint: (
        <>
          {[n.brand, n.model].filter(Boolean).join(" ") || "A card nothing named"}
          {facts && ` · ${facts}`}
          {n.mac && (
            <>
              {" · "}
              <Mono>{n.mac}</Mono>
            </>
          )}
        </>
      ),
    });
  }
  if (r.os || r.kernel) rows.push({ label: "System", hint: [r.os, r.kernel].filter(Boolean).join(" · ") });
  return (
    <Group title="Read in full" foot={`All of it from the reading of ${stamp(r.at)}. Nothing here is typed.`}>
      {rows.map((row, i) => (
        <Row key={`${row.label}-${i}`} label={row.label} hint={row.hint} />
      ))}
    </Group>
  );
}
