/**
 * Settings → System → Usage: how much is spent, and why it runs out.
 *
 * Asked for by somebody who said "sometimes I feel like I run out of tokens too
 * soon", so the first thing on screen is where this limit week's tokens went, and
 * everything below it is a step towards why. Beside Processes, because "what is
 * every terminal running and what does it cost" is the same question asked of the
 * machine rather than of the account.
 *
 * Three kinds of number stand on this page and are never mixed. **Tokens** are
 * exact, read off the logs. **Dollars** are an estimate at API list prices for
 * somebody who pays a subscription, and say so wherever they appear. **Limits**
 * are the account's own percentages, and no sum here turns one into another,
 * because Anthropic does not publish how they weigh.
 *
 * Fetched while the page is open and never otherwise, on Processes' reasoning, and
 * the last answer stays drawn at reduced opacity while the next one comes: a chart
 * that blanks on every press loses the reader's place in it. All the arithmetic
 * is the server's (`shared/usagereport.ts`); a filter is a new question, not a
 * reshuffle here, so a tile and the chart under it cannot disagree.
 *
 * The table's two buttons go somewhere else entirely, so they close Settings on
 * the way, as the machines' Shell does.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { USAGE_DIMENSIONS, USAGE_RANGES, type UsageDimension, type UsageRange, type UsageReport, type SessionRow } from "../../../shared/usagereport";
import { KindBars, RankedBars } from "../charts/bars";
import { LimitLines, StackedColumns } from "../charts/columns";
import { changeOf, compact, dollars, percent } from "../charts/format";
import { ChartFrame, DataTable, inkOf } from "../charts/frame";
import { ContextStrips } from "../charts/strips";
import { showCardNext } from "../components/Board";
import * as api from "../session";
import { Banner, Btn, Details, Empty, errorText, Group, Mono, P, Readout, Segments, Tile, Tiles, when } from "./ui";

const RANGE_WORDS: Record<UsageRange, string> = { week: "This limit week", today: "Today", "7d": "7 days", "30d": "30 days", all: "All" };
const BY_WORDS: Record<UsageDimension, string> = { workspace: "Workspace", kuru: "Kuru vs agents", card: "Card", agent: "Agent", model: "Model", program: "Program" };
/** How often the numbers are asked for again while the page is open. Long, since it is a query on the server's event loop and they move by the message. */
const EVERY_MS = 60_000;

function moment(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function under(now: number, before: number | undefined, against: string | null): string | undefined {
  if (before === undefined || !against) return undefined;
  const change = changeOf(now, before);
  return change ? `${change} vs ${against}` : undefined;
}

export function UsagePage({ narrow, onClose }: { narrow: boolean; onClose: () => void }) {
  const [range, setRange] = useState<UsageRange>("week");
  const [by, setBy] = useState<UsageDimension>("workspace");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const latest = useRef(0);

  useEffect(() => {
    const ask = async () => {
      const asked = ++latest.current;
      setBusy(true);
      try {
        const response = await fetch(`/api/usage/report?range=${range}&by=${by}`);
        const body = (await response.json()) as UsageReport & { error?: string };
        if (asked !== latest.current) return;
        if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
        setReport(body);
        setError(null);
      } catch (err) {
        if (asked === latest.current) setError(errorText(err));
      } finally {
        if (asked === latest.current) setBusy(false);
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), EVERY_MS);
    return () => {
      clearInterval(timer);
      // Anything still on its way belongs to the question before this one.
      latest.current++;
    };
  }, [range, by]);

  const filters = (
    <div className="ch-filters">
      {narrow ? (
        <>
          <select className="st-select" value={range} aria-label="Range" onChange={(event) => setRange(event.target.value as UsageRange)}>
            {USAGE_RANGES.map((id) => (
              <option key={id} value={id}>
                {RANGE_WORDS[id]}
              </option>
            ))}
          </select>
          <select className="st-select" value={by} aria-label="Split by" onChange={(event) => setBy(event.target.value as UsageDimension)}>
            {USAGE_DIMENSIONS.map((id) => (
              <option key={id} value={id}>
                By {BY_WORDS[id].toLowerCase()}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <Segments label="Range" value={range} options={USAGE_RANGES.map((id) => [id, RANGE_WORDS[id]] as const)} onChange={setRange} />
          <Segments label="Split by" value={by} options={USAGE_DIMENSIONS.map((id) => [id, BY_WORDS[id]] as const)} onChange={setBy} />
        </>
      )}
    </div>
  );

  if (!report) {
    return (
      <>
        {error && <Banner tone="bad">{error}</Banner>}
        {filters}
        {!error && <Empty>Reading the ledger…</Empty>}
      </>
    );
  }
  return (
    <>
      {error && <Banner tone="bad">{error}</Banner>}
      {filters}
      <div className={`ch-page${busy ? " ch-page-busy" : ""}`}>
        <Report report={report} narrow={narrow} onClose={onClose} />
      </div>
    </>
  );
}

function Report({ report, narrow, onClose }: { report: UsageReport; narrow: boolean; onClose: () => void }) {
  const { totals, previous, range } = report;
  const kuruShare = totals.tokens ? totals.kuruTokens / totals.tokens : 0;
  const kuruBefore = previous && previous.tokens ? previous.kuruTokens / previous.tokens : null;
  const against = range.previousLabel;
  const kuruMove = kuruBefore === null || !against ? undefined : `${kuruBefore <= kuruShare ? "+" : "−"}${(Math.abs(kuruShare - kuruBefore) * 100).toFixed(1)} pts vs ${against}`;
  const empty = totals.messages === 0;

  return (
    <>
      <p className="st-foot ch-span">
        {range.id === "week" && range.guessed
          ? "No reading has said when your week resets yet, so this is the last 7 days."
          : range.id === "week"
            ? `Since ${moment(range.from)}, when ${report.weekOwner === "codex" ? "Codex's" : "your Claude"} week began. It resets ${moment(range.from + 7 * 86_400_000)}.`
            : range.id === "all"
              ? `Everything the ledger has, back to ${report.foot.oldestDay ?? "its first day"}.`
              : `Since ${moment(range.from)}.`}
      </p>

      {empty ? (
        <Group>
          <Empty>Nothing was billed in this range.</Empty>
        </Group>
      ) : (
        <>
          <Tiles>
            <Tile value={compact(totals.tokens)} label="Tokens" under={under(totals.tokens, previous?.tokens, against)} />
            <Tile value={dollars(totals.cost)} label="Estimate at list price" under={under(totals.cost, previous?.cost, against)} />
            <Tile value={percent(kuruShare)} label="Kuru's share" under={kuruMove} />
            <Tile value={totals.messages.toLocaleString("en-US")} label="Messages" under={under(totals.messages, previous?.messages, against)} />
          </Tiles>
          <p className="st-foot ch-span">
            Tokens are read off the programs' own logs. Dollars are an estimate at Anthropic's API list prices; you pay a subscription. Limits are the account's percentages, and Anthropic does not publish how tokens weigh against them.
          </p>

          <ChartFrame
            title="Where the tokens went"
            table={() => (
              <DataTable
                head={[BY_WORDS[report.by], "Tokens", "Share", "Estimate", "Messages"]}
                rows={report.ranked.map((row) => [row.label + (row.folderOnly ? " (folder only)" : ""), compact(row.tokens), percent(row.share), dollars(row.cost), row.messages.toLocaleString("en-US")])}
              />
            )}
          >
            <RankedBars
              bars={report.ranked.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.tokens,
                share: row.share,
                ink: inkOf(row.kuru ? "kuru" : "rest"),
                sub: row.folderOnly ? "folder only" : undefined,
                rows: [
                  { value: compact(row.tokens), label: `tokens, ${percent(row.share)}` },
                  { value: dollars(row.cost), label: "estimate" },
                  { value: row.messages.toLocaleString("en-US"), label: "messages" },
                ],
              }))}
            />
          </ChartFrame>

          <ChartFrame
            title="Over the days"
            lead={report.by === "kuru" ? "Kuru and the agents, in tokens." : `In tokens, by ${BY_WORDS[report.by].toLowerCase()}. Kuru's green stays its own.`}
            table={() => (
              <DataTable
                head={["", ...report.stack.map((s) => s.label)]}
                rows={report.buckets.map((bucket, i) => [bucket.long, ...report.stack.map((s) => compact(s.values[i] ?? 0))])}
              />
            )}
          >
            <StackedColumns buckets={report.buckets} series={report.stack} narrow={narrow} />
          </ChartFrame>

          {report.limits.length > 0 ? (
            <ChartFrame
              title="The week limit, on the same days"
              lead="The account's own percentage, highest reading of each day. Its own chart, because no scale joins it to tokens."
              table={() => (
                <DataTable
                  head={["", ...report.limits.map((s) => s.label)]}
                  rows={report.buckets.map((bucket, i) => [bucket.long, ...report.limits.map((s) => (s.values[i] === null ? "–" : `${Math.round(s.values[i]!)}%`))])}
                />
              )}
            >
              <LimitLines buckets={report.buckets} series={report.limits} narrow={narrow} />
            </ChartFrame>
          ) : null}

          <ChartFrame
            title="What kind of token"
            lead="Nearly every token is the conversation being sent again. They are cheap, and there are billions of them."
            table={() => (
              <DataTable
                head={["", "Tokens", "Of tokens", "Estimate", "Of estimate"]}
                rows={[
                  ...report.kinds.map((kind) => [kind.label, compact(kind.tokens), percent(kind.share), dollars(kind.cost), percent(kind.costShare)]),
                  ["Thinking, within output", compact(report.thinking), "", "", ""],
                ]}
              />
            )}
          >
            <KindBars parts={report.kinds.map((kind, slot) => ({ key: kind.kind, label: kind.label, slot, amount: kind.tokens, cost: kind.cost }))} />
          </ChartFrame>

          {report.context.length > 0 && (
            <ChartFrame
              title="Context carried"
              lead="The range's largest sessions, message by message, on one scale. The line is what each further message sends again; the hairline is 200k."
              table={() => (
                <DataTable
                  head={["Session", "Messages", "Median", "Peak", "Last", "Passed 200k at"]}
                  rows={report.context.map((strip) => [
                    strip.label,
                    strip.messages.toLocaleString("en-US"),
                    compact(strip.median),
                    compact(strip.peak),
                    compact(strip.last),
                    strip.over200At === null ? "never" : `message ${strip.over200At.toLocaleString("en-US")}`,
                  ])}
                />
              )}
            >
              <ContextStrips strips={report.context} />
            </ChartFrame>
          )}

          <Sessions report={report} narrow={narrow} onClose={onClose} />

          {report.says && (
            <Details summary={`Claude Code's own figure: ${dollars(report.says.says)}, against an estimate of ${dollars(report.says.estimate)}, on ${report.says.sessions} sessions wholly in this range`}>
              <P>
                They agree to the cent where Claude Code's token counts equal the transcript's. Where they differ, it is usually because Claude Code spends tokens no transcript records: its own Haiku calls and web searches have next to no record in the file, so its figure runs higher, by about 9 % on this Mac when this was measured. A resumed session can go the other way, because its own count starts over when it resumes. So a gap is not a wrong price, and neither figure is a bill.
              </P>
            </Details>
          )}
        </>
      )}

      <Group title="How long the transcripts last">
        {report.retention.map((row) => (
          <Readout key={row.who} label={row.who} hint={row.stated ? <>Set by <Mono>cleanupPeriodDays</Mono> in its settings.json</> : <>Claude Code's default; <Mono>cleanupPeriodDays</Mono> is not set</>} value={`${row.days.toLocaleString("en-US")} days`} />
        ))}
      </Group>
      <Details summary="What that setting decides, and why kururu leaves it alone">
        <P>
          Claude Code deletes a session's transcript once it is older than <Mono>cleanupPeriodDays</Mono>. This page does not depend on it: the ledger keeps the numbers after the transcript is gone, and never the words. What the setting decides is how far back <Mono>--resume</Mono> and the conversation search can reach, at about 200–300 MB of disk a day at the pace this Mac runs. A week of transcripts already deleted before the ledger existed cannot be recovered.
        </P>
        <P>
          It is yours to set, in the settings.json of the login above: the documented way to keep everything is a large value such as 3650. Kururu shows it and does not write it.
        </P>
      </Details>

      <p className="st-foot ch-span">
        {report.foot.reading && report.foot.reading.totalBytes > 0 ? `Reading the logs: ${Math.round((report.foot.reading.doneBytes / report.foot.reading.totalBytes) * 100)} %. ` : ""}
        {report.foot.oldestDay ? `Oldest day read: ${report.foot.oldestDay}. ` : ""}
        {report.foot.sweptAt ? `Logs last read ${when(report.foot.sweptAt)}. ` : ""}
        {report.foot.skipped ? `${report.foot.skipped.toLocaleString("en-US")} lines not read, which is how a log format that moved would show. ` : ""}
        {report.foot.unpriced ? `${report.foot.unpriced.toLocaleString("en-US")} messages have no price, tokens only: Codex and other models the table does not have. ` : ""}
        {report.foot.error ? `The reader stopped: ${report.foot.error}` : ""}
      </p>
    </>
  );
}

type SortKey = "lastAt" | "label" | "workspace" | "messages" | "read" | "write" | "input" | "output" | "tokens" | "cost" | "says";

const COLUMNS: readonly { key: SortKey; word: string; title?: string; numeric?: boolean; wide?: boolean }[] = [
  { key: "lastAt", word: "When", title: "Its last message", wide: true },
  { key: "label", word: "What" },
  { key: "workspace", word: "Workspace", wide: true },
  { key: "messages", word: "Msgs", title: "Messages in this range", numeric: true, wide: true },
  { key: "read", word: "Read", title: "Cache read, in this range", numeric: true, wide: true },
  { key: "write", word: "Write", title: "Cache write, in this range", numeric: true, wide: true },
  { key: "input", word: "In", title: "Input, uncached, in this range", numeric: true, wide: true },
  { key: "output", word: "Out", title: "Output, thinking included, in this range", numeric: true, wide: true },
  { key: "tokens", word: "Tokens", title: "All of them, in this range", numeric: true },
  { key: "cost", word: "Est.", title: "Estimate at list price, in this range", numeric: true },
  { key: "says", word: "Says", title: "What the program says the whole session spent, which may reach outside this range", numeric: true, wide: true },
];

/** A dash for what has no price, since $0 would say it was free. Codex's zero-token records are why it is not "every message unpriced". */
function estimate(row: SessionRow): string {
  return row.unpriced > 0 && row.cost === 0 ? "–" : dollars(row.cost);
}

function modelWords(row: SessionRow): string {
  const program = row.program === "claude" ? "" : `${row.program === "codex" ? "Codex" : "OpenCode"} · `;
  return `${program}${row.model}${row.moreModels ? ` +${row.moreModels}` : ""}`;
}

/**
 * The table: always there, the one place the long tail can be read, and the only
 * chart a person can act from. Sortable because "the most expensive" and "the
 * last thing that ran" are both reasonable first questions. On a phone it is three
 * columns and a tap for the rest, rather than eleven columns and a sideways scroll.
 */
function Sessions({ report, narrow, onClose }: { report: UsageReport; narrow: boolean; onClose: () => void }) {
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: "tokens", down: true });
  const [opened, setOpened] = useState<string | null>(null);
  const rows = useMemo(() => {
    const value = (row: SessionRow): number | string => (sort.key === "says" ? (row.says ?? -1) : row[sort.key]);
    return [...report.sessions].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return sort.down ? -order : order;
    });
  }, [report.sessions, sort]);
  const columns = narrow ? COLUMNS.filter((column) => !column.wide) : COLUMNS;

  const actions = (row: SessionRow) => (
    <>
      {row.agentId && (
        <Btn
          onClick={() => {
            api.revealAgent(row.agentId!);
            onClose();
          }}
        >
          Reveal
        </Btn>
      )}
      {row.card && (
        <Btn
          onClick={() => {
            showCardNext(row.card!.workspaceId, row.card!.id);
            api.openBoard(undefined, false, row.card!.workspaceId);
            onClose();
          }}
        >
          Open card
        </Btn>
      )}
    </>
  );

  return (
    <Group
      title="Sessions"
      foot={`${report.sessionsMore ? `The ${rows.length} largest of ${(rows.length + report.sessionsMore).toLocaleString("en-US")}; the rest are in the totals above. ` : ""}Tokens and the estimate are this range's. Says is what the program says the whole session spent, which may reach outside it.`}
    >
      <div className="ch-tablewrap">
        <table className="ch-table ch-sessions">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={column.numeric ? "ch-num" : undefined} aria-sort={sort.key === column.key ? (sort.down ? "descending" : "ascending") : undefined} title={column.title}>
                  <button
                    type="button"
                    className="ch-sort"
                    onClick={() => setSort(sort.key === column.key ? { key: column.key, down: !sort.down } : { key: column.key, down: column.numeric === true || column.key === "lastAt" })}
                  >
                    {column.word}
                    {sort.key === column.key ? (sort.down ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              ))}
              {!narrow && <th scope="col" aria-label="Go to" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              narrow ? (
                <NarrowRow key={row.id} row={row} open={opened === row.id} onToggle={() => setOpened(opened === row.id ? null : row.id)} actions={actions(row)} />
              ) : (
                <tr key={row.id}>
                  <td className="ch-when">{when(row.lastAt)}</td>
                  <td className="ch-what" title={row.label}>
                    <span className="ch-what-name">{row.label}</span>
                    <span className="ch-what-sub">
                      {modelWords(row)} · {row.attribution}
                    </span>
                  </td>
                  <td className="ch-where" title={row.workspace}>
                    {row.workspace}
                  </td>
                  <td className="ch-num">{row.messages.toLocaleString("en-US")}</td>
                  <td className="ch-num">{compact(row.read)}</td>
                  <td className="ch-num">{compact(row.write)}</td>
                  <td className="ch-num">{compact(row.input)}</td>
                  <td className="ch-num">{compact(row.output)}</td>
                  <td className="ch-num ch-strong">{compact(row.tokens)}</td>
                  <td className="ch-num">{estimate(row)}</td>
                  <td className="ch-num">{row.says === null ? "–" : dollars(row.says)}</td>
                  <td>
                    <div className="ch-go">{actions(row)}</div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </Group>
  );
}

function NarrowRow({ row, open, onToggle, actions }: { row: SessionRow; open: boolean; onToggle: () => void; actions: React.ReactNode }) {
  return (
    <>
      <tr className="ch-tap" onClick={onToggle} aria-expanded={open}>
        <td className="ch-what">
          <span className="ch-what-name">{row.label}</span>
          <span className="ch-what-sub">
            {when(row.lastAt)} · {row.workspace}
          </span>
        </td>
        <td className="ch-num ch-strong">{compact(row.tokens)}</td>
        <td className="ch-num">{estimate(row)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3} className="ch-more">
            <div>
              {modelWords(row)} · {row.attribution} · {row.messages.toLocaleString("en-US")} messages
            </div>
            <div>
              Read {compact(row.read)} · write {compact(row.write)} · in {compact(row.input)} · out {compact(row.output)}
            </div>
            {row.says !== null && <div>The program says {dollars(row.says)} for the whole session</div>}
            <div className="ch-go">{actions}</div>
          </td>
        </tr>
      )}
    </>
  );
}
