/**
 * The automations on screen: a section in the sidebar under the agents, and
 * a sheet with one automation's form and its last twenty runs.
 *
 * The owner asked for "enough communication, not super extreme, to know it's
 * alive, when it'll trigger next, how often", so a row says one thing on its
 * right — the next run, how long the live one has been going, or what went
 * wrong — and a dot for the state. Everything else is the tooltip or the
 * sheet. Times are drawn in the schedule's zone with the viewer's own beside
 * them when the two differ, because "09:00" without a zone is the mistake the
 * plan was written to avoid (T3 Code's #18632).
 *
 * The sheet is an overlay rather than a pane, on the database sheet's
 * argument: an automation belongs to the profile, not to an arrangement of
 * panes, and it is the same sheet on a phone. The Dashboard's Automations tab,
 * with the detail and the history, is the plan's next phase.
 *
 * The form writes the definition's text with `automationText` and the server
 * reads it with the same parser a file is read with, so the errors shown as
 * you type are the server's own.
 */
import { useEffect, useMemo, useState } from "react";
import {
  automationText,
  dotOf,
  durationText,
  durationWords,
  parseAutomation,
  TELLS,
  type AutomationTask,
  type AutomationView,
  type RunView,
  type Tell,
} from "../../../shared/automation";
import { visibleLaunchers, findLauncher } from "../../../shared/launchers";
import { nextFive, parseSchedule, slotLabel, todayIn } from "../../../shared/schedule";
import { useLongPress } from "../longpress";
import * as api from "../session";
import { useKururu } from "../session";
import type { DialogState } from "./Dialog";
import { Icon } from "./Icon";
import { Menu, type MenuItem } from "./Menu";

/** The viewer's own zone, for the time beside a slot. */
const HERE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
})();

/** A clock that ticks, so "in 3 h" and "running 12 m" move without a snapshot. */
function useNow(every = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

/** A slot in its zone, and in the viewer's when that is another. */
export function slotText(at: number, zone: string | null): string {
  if (!zone) return slotLabel(at, HERE);
  const there = `${slotLabel(at, zone)} ${zone}`;
  return zone === HERE ? there : `${there} (${slotLabel(at, HERE)} here)`;
}

function hhmmHere(at: number): string {
  return slotLabel(at, HERE).split(", ")[1] ?? "";
}

function inWhile(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** The one fact on a row's right. */
function rowFact(a: AutomationView, now: number): string {
  if (a.error) return "needs an edit";
  if (a.live) return a.live.state === "asking" ? "asking" : `running ${inWhile(now - (a.live.startedAt ?? now))}`;
  if (!a.enabled) return "paused";
  const dot = dotOf(a);
  if (dot === "failed" && a.last) return `${a.last.state}, ${hhmmHere(a.last.endedAt ?? a.last.slotAt)}`;
  if (a.next === null) return a.schedule === "manual" ? "by hand" : "no next run";
  const ahead = a.next - now;
  if (ahead < 0) return "due";
  if (ahead < 24 * 3_600_000) return `in ${inWhile(ahead)}`;
  return slotLabel(a.next, HERE).replace(/^(\w{3}) (\d+) \w{3},/, "$1 $2,");
}

function rowTitle(a: AutomationView): string {
  const lines = [a.name, a.words || a.error || ""];
  if (a.workspaceName) lines.push(`In ${a.workspaceName}, on ${a.home}`);
  if (a.next !== null) lines.push(`Next: ${slotText(a.next, a.zone)}`);
  if (!a.enabled && a.whyOff) lines.push(`Off: ${a.whyOff}`);
  if (a.last) lines.push(`Last: ${a.last.state}${a.last.words ? ` — ${a.last.words}` : ""}`);
  if (!a.clock) lines.push("This server's clock is off: nothing fires on schedule here.");
  return lines.filter(Boolean).join("\n");
}

/**
 * The sidebar's section. Shown whenever the server has automations to say
 * anything about — an empty list too, with its +, since a section that only
 * appears once there is one would be a feature nobody could find.
 */
export function AutomationsSection({
  onOpen,
  onPrompt,
}: {
  onOpen: (key: string | null) => void;
  onPrompt: (dialog: DialogState) => void;
}) {
  const { snapshot } = useKururu();
  const now = useNow();
  const { longPress, swallowed } = useLongPress();
  const [menu, setMenu] = useState<{ key: string | null; x: number; y: number } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const list = snapshot?.automations;
  if (!list) return null;

  const tell = (promise: Promise<unknown>) => promise.catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)));

  const itemsFor = (a: AutomationView): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Run now", disabled: a.live !== null || a.error !== null, run: () => void tell(api.runAutomation(a.key)) },
      { label: a.enabled ? "Pause" : "Resume", disabled: a.error !== null && !a.enabled, run: () => void tell(api.pauseAutomation(a.key, !a.enabled)) },
      { label: "Edit", run: () => onOpen(a.key) },
    ];
    if (a.live?.agentId) items.push({ label: "Reveal agent", run: () => api.revealAgent(a.live!.agentId!) });
    items.push({
      label: "Delete",
      sep: true,
      danger: true,
      disabled: a.live !== null,
      run: () =>
        onPrompt({
          kind: "confirm",
          title: `Delete "${a.name}"?`,
          hint: "It stops running. Its history is kept in the database.",
          confirmLabel: "Delete",
          onConfirm: () => void tell(api.deleteAutomation(a.key)),
        }),
    });
    return items;
  };

  const headItems: MenuItem[] = [
    { label: "New automation", run: () => onOpen(null) },
    { label: "Pause all", disabled: !list.some((a) => a.enabled), run: () => void tell(api.pauseAllAutomations()) },
  ];

  const menuFor = menu?.key ? list.find((a) => a.key === menu.key) : undefined;
  const items = menu ? (menu.key === null ? headItems : menuFor ? itemsFor(menuFor) : null) : null;

  return (
    <section className="side-section side-auto">
      <h2>
        Automations
        <button className="mini side-fold-all" onClick={(event) => setMenu({ key: null, x: event.clientX, y: event.clientY })} title="Pause all…" aria-label="Automations menu">
          <Icon name="more" />
        </button>
        <button className="mini" onClick={() => onOpen(null)} title="New automation" aria-label="New automation">
          <Icon name="add" />
        </button>
      </h2>
      <ul className="auto-list">
        {list.length === 0 && <li className="muted sidebar-empty">Nothing on a schedule yet.</li>}
        {list.map((a) => {
          const dot = dotOf(a);
          return (
            <li key={a.key} className="auto-item">
              <button
                className="auto-row"
                title={rowTitle(a)}
                onClick={() => {
                  if (swallowed()) return;
                  onOpen(a.key);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ key: a.key, x: event.clientX, y: event.clientY });
                }}
                {...longPress((at) => setMenu({ key: a.key, ...at }))}
              >
                <span className={`auto-dot auto-dot-${dot}`} aria-label={dot} />
                <span className="auto-name">{a.name}</span>
                {!a.clock && <span className="auto-home">clock off</span>}
                <span className={`auto-when ${dot === "failed" || dot === "broken" ? "auto-when-bad" : ""}`}>{rowFact(a, now)}</span>
              </button>
              <button
                className="auto-more"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({ key: a.key, x: box.left, y: box.bottom + 4 });
                }}
                title="Run now, pause, edit…"
                aria-label={`${a.name} menu`}
              >
                <Icon name="more" />
              </button>
            </li>
          );
        })}
      </ul>
      {said && (
        <button className="dev-said" onClick={() => setSaid(null)} title="Click to dismiss">
          {said}
        </button>
      )}
      {menu && items && <Menu at={menu} onClose={() => setMenu(null)} items={items} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

interface Form {
  name: string;
  workspaceId: string;
  schedule: string;
  run: AutomationTask;
  launcher: string;
  body: string;
  dir: string;
  timeout: string;
  catchUp: string;
  tell: Tell;
  needs: string;
  maxUsd: string;
  /** Carried through untouched: not on the form. */
  monthUsd: number | null;
  permissions: "profile" | "ask" | "auto";
}

const BLANK_SCHEDULE = `every day at 09:00 ${HERE}`;

function formOf(view: AutomationView | null, workspaceId: string, launcher: string): Form {
  const parsed = view ? parseAutomation(view.text) : null;
  if (parsed?.ok) {
    const d = parsed.def;
    return {
      name: d.name,
      workspaceId: view?.workspaceId ?? workspaceId,
      schedule: d.schedule,
      run: d.run,
      launcher: d.launcher ?? launcher,
      body: d.body,
      dir: d.dir ?? "",
      timeout: durationText(d.timeoutMs),
      catchUp: d.catchUpMs === null ? "" : d.catchUpMs === 0 ? "none" : durationText(d.catchUpMs),
      tell: d.tell,
      needs: d.needs.join(", "),
      maxUsd: String(d.maxUsd),
      monthUsd: d.monthUsd,
      permissions: d.permissions,
    };
  }
  return {
    name: view?.name ?? "",
    workspaceId: view?.workspaceId ?? workspaceId,
    schedule: view?.schedule || BLANK_SCHEDULE,
    run: "agent",
    launcher,
    body: "",
    dir: "",
    timeout: "60m",
    catchUp: "",
    tell: "finding",
    needs: "",
    maxUsd: "5",
    monthUsd: null,
    permissions: "profile",
  };
}

/** The form as the file it is — or, if it cannot be one yet, why not. */
function textOf(form: Form): { text: string; error: string | null } {
  const lines = [`name: ${form.name.trim()}`, `schedule: ${form.schedule.trim()}`, `run: ${form.run}`];
  if (form.run !== "shell" && form.launcher) lines.push(`launcher: ${form.launcher}`);
  if (form.dir.trim()) lines.push(`dir: ${form.dir.trim()}`);
  if (form.needs.trim()) lines.push(`needs: ${form.needs.trim()}`);
  if (form.timeout.trim()) lines.push(`timeout: ${form.timeout.trim()}`);
  if (form.maxUsd.trim()) lines.push(`max-usd: ${form.maxUsd.trim()}`);
  if (form.monthUsd !== null) lines.push(`month-usd: ${form.monthUsd}`);
  if (form.catchUp.trim()) lines.push(`catch-up: ${form.catchUp.trim()}`);
  lines.push(`tell: ${form.tell}`);
  if (form.permissions !== "profile") lines.push(`permissions: ${form.permissions}`);
  const raw = `---\n${lines.join("\n")}\n---\n${form.body.trim()}\n`;
  const parsed = parseAutomation(raw);
  return parsed.ok ? { text: automationText(parsed.def), error: null } : { text: raw, error: parsed.error };
}

const STATE_WORDS: Record<RunView["state"], string> = {
  running: "running",
  asking: "asking",
  ok: "ok",
  finding: "found something",
  failed: "failed",
  skipped: "skipped",
  missed: "missed",
  interrupted: "interrupted",
};

export function AutomationSheet({
  automationKey,
  onClose,
  onPrompt,
}: {
  automationKey: string | null;
  onClose: () => void;
  onPrompt: (dialog: DialogState) => void;
}) {
  const { snapshot } = useKururu();
  const now = useNow(15_000);
  const [key, setKey] = useState<string | null>(automationKey);
  const view = snapshot?.automations?.find((a) => a.key === key) ?? null;
  const workspaces = snapshot?.profile.workspaces ?? [];
  const launchers = useMemo(() => (snapshot ? visibleLaunchers(snapshot.launch) : []), [snapshot?.launch]);
  const defaultLauncher = launchers.find((l) => l.cli === "claude")?.id ?? launchers[0]?.id ?? "";
  const [form, setForm] = useState<Form>(() =>
    formOf(view, snapshot?.profile.activeWorkspaceId ?? workspaces[0]?.id ?? "", defaultLauncher),
  );
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const [runs, setRuns] = useState<(RunView & { kept: string | null })[] | null>(null);
  const [openOutput, setOpenOutput] = useState<number | null>(null);

  // A key that has gone — deleted from another window — closes the sheet.
  useEffect(() => {
    if (key && snapshot?.automations && !view) onClose();
  }, [key, snapshot?.automations, view, onClose]);

  // The history, again whenever the row's live or last run moves.
  const heads = `${view?.live?.id ?? ""}/${view?.live?.state ?? ""}/${view?.last?.id ?? ""}/${view?.last?.state ?? ""}`;
  useEffect(() => {
    if (!key) return;
    let live = true;
    api.automationRuns(key).then(
      (list) => live && setRuns(list),
      () => live && setRuns([]),
    );
    return () => {
      live = false;
    };
  }, [key, heads]);

  const set = <K extends keyof Form>(field: K, value: Form[K]) => {
    setForm((was) => ({ ...was, [field]: value }));
    setSaid(null);
  };
  const { text, error } = textOf(form);
  const schedule = parseSchedule(form.schedule);
  const anchor = view?.anchor ?? todayIn(schedule.ok && schedule.schedule.kind !== "manual" ? schedule.schedule.zone : HERE, now);
  const five = schedule.ok ? nextFive(schedule.schedule, now, anchor) : [];
  const zone = schedule.ok && schedule.schedule.kind !== "manual" ? schedule.schedule.zone : null;
  const changed = !view || text !== view.text || form.workspaceId !== view.workspaceId;

  const act = (promise: Promise<unknown>, ok?: string) => {
    setBusy(true);
    setSaid(null);
    promise
      .then(
        () => ok && setSaid({ text: ok, bad: false }),
        (err: unknown) => setSaid({ text: err instanceof Error ? err.message : String(err), bad: true }),
      )
      .finally(() => setBusy(false));
  };

  const save = () => {
    if (error || !form.workspaceId) return;
    setBusy(true);
    setSaid(null);
    api
      .saveAutomation(key, form.workspaceId, text)
      .then(
        (result) => {
          setKey(result.key);
          setSaid({ text: key ? "Saved." : "Made, and on.", bad: false });
        },
        (err: unknown) => setSaid({ text: err instanceof Error ? err.message : String(err), bad: true }),
      )
      .finally(() => setBusy(false));
  };

  const launcherKnown = form.run === "shell" || launchers.some((l) => l.id === form.launcher) || !!findLauncher(form.launcher);

  return (
    <div className="scrim db-scrim" onPointerDown={onClose}>
      <div className="db auto-sheet" role="dialog" aria-modal aria-label={view ? `Automation: ${view.name}` : "New automation"} onPointerDown={(event) => event.stopPropagation()}>
        <header className="db-head">
          <h2 className="dialog-title">{view ? view.name : "New automation"}</h2>
          {view && (
            <span className="db-where">
              {view.enabled ? (view.next !== null ? `next ${slotText(view.next, view.zone)}` : view.schedule === "manual" ? "runs only by hand" : "no next run") : `paused${view.whyOff ? `: ${view.whyOff}` : ""}`}
            </span>
          )}
          <button className="mini" onClick={onClose} title="Close" aria-label="Close" style={{ marginLeft: "auto" }}>
            <Icon name="close" />
          </button>
        </header>
        <div className="auto-body">
          <div className="auto-form">
            {view && !view.clock && <p className="auto-note">This server's clock is off — an isolated instance — so nothing fires on schedule here. Run now still works.</p>}
            {view?.error && <p className="auto-note auto-bad">It cannot run as it is: {view.error}</p>}
            <label className="auto-field">
              <span>Name</span>
              <input className="dialog-input" value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="Pasapy crawl review" />
            </label>
            <label className="auto-field">
              <span>Workspace</span>
              <select className="dialog-input" value={form.workspaceId} onChange={(e) => set("workspaceId", e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="auto-field">
              <span>Schedule</span>
              <input className="dialog-input" value={form.schedule} onChange={(e) => set("schedule", e.target.value)} placeholder="every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23" />
            </label>
            <div className="auto-five">
              {!schedule.ok ? (
                <span className="auto-bad">{schedule.error}</span>
              ) : five.length === 0 ? (
                <span>{schedule.schedule.kind === "manual" ? "Runs only when you press Run now." : "No run ahead."}</span>
              ) : (
                <>
                  <span className="auto-five-head">Next {five.length}:</span>
                  <ol>
                    {five.map((at) => (
                      <li key={at}>{slotText(at, zone)}</li>
                    ))}
                  </ol>
                </>
              )}
            </div>
            <div className="auto-field">
              <span>Task</span>
              <div className="auto-seg" role="radiogroup">
                {(["agent", "shell"] as const).map((run) => (
                  <button key={run} role="radio" aria-checked={form.run === run} className={`button button-quiet ${form.run === run ? "auto-seg-on" : ""}`} onClick={() => set("run", run)}>
                    {run === "agent" ? "An agent, with a prompt" : "A shell command"}
                  </button>
                ))}
              </div>
            </div>
            {form.run === "agent" && (
              <label className="auto-field">
                <span>Launcher</span>
                <select className="dialog-input" value={form.launcher} onChange={(e) => set("launcher", e.target.value)}>
                  {!launchers.some((l) => l.id === form.launcher) && <option value={form.launcher}>{findLauncher(form.launcher)?.label ?? form.launcher}</option>}
                  {launchers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <small>Sonnet for checks and digests, Opus for a review that has to judge.</small>
              </label>
            )}
            <label className="auto-field">
              <span>{form.run === "shell" ? "Command" : "Prompt"}</span>
              <textarea
                className="dialog-input auto-body-text"
                value={form.body}
                rows={form.run === "shell" ? 2 : 4}
                onChange={(e) => set("body", e.target.value)}
                placeholder={form.run === "shell" ? "df -h /" : "/crawl-maintenance"}
              />
              <small>
                {form.run === "shell"
                  ? "Run under sh -c in the workspace's folder; a status other than 0 is a failure."
                  : "Typed as the first message, in the workspace's main checkout — where uncommitted work may be. Fine for a review that writes a report; not for editing code."}
              </small>
            </label>
            <div className="auto-row2">
              <label className="auto-field">
                <span>Time limit</span>
                <input className="dialog-input" value={form.timeout} onChange={(e) => set("timeout", e.target.value)} placeholder="60m" />
              </label>
              <label className="auto-field">
                <span>Catch-up</span>
                <input className="dialog-input" value={form.catchUp} onChange={(e) => set("catchUp", e.target.value)} placeholder={schedule.ok && schedule.schedule.kind === "every" && (schedule.schedule.unit === "minutes" || schedule.schedule.unit === "hours") ? "none" : "12h"} />
              </label>
              <label className="auto-field">
                <span>Tell</span>
                <select className="dialog-input" value={form.tell} onChange={(e) => set("tell", e.target.value as Tell)}>
                  {TELLS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="auto-row2">
              <label className="auto-field">
                <span>Folder</span>
                <input className="dialog-input" value={form.dir} onChange={(e) => set("dir", e.target.value)} placeholder="the workspace's own" />
              </label>
              <label className="auto-field">
                <span>Needs</span>
                <input className="dialog-input" value={form.needs} onChange={(e) => set("needs", e.target.value)} placeholder="machine MV, login claude" />
              </label>
              <label className="auto-field">
                <span>Max $ a run</span>
                <input className="dialog-input" value={form.maxUsd} onChange={(e) => set("maxUsd", e.target.value)} placeholder="5" />
              </label>
            </div>
            <small className="auto-note">
              A missed slot runs once if found within the catch-up window (half a day for daily or slower when left empty). A failed, missed or skipped run notifies you and tells Kuru, unless Tell is never.
              Needs and the dollar limit are kept with it and not checked yet.
            </small>
            {(error || said) && <p className={`auto-note ${error || said?.bad ? "auto-bad" : ""}`}>{error ?? said?.text}</p>}
            <div className="dialog-actions auto-actions">
              {view && (
                <>
                  <button
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() =>
                      onPrompt({
                        kind: "confirm",
                        title: `Delete "${view.name}"?`,
                        hint: "It stops running. Its history is kept in the database.",
                        confirmLabel: "Delete",
                        onConfirm: () => {
                          void api.deleteAutomation(view.key).then(onClose, (err: unknown) => setSaid({ text: err instanceof Error ? err.message : String(err), bad: true }));
                        },
                      })
                    }
                  >
                    Delete
                  </button>
                  <button className="button button-quiet" disabled={busy || (!!view.error && !view.enabled)} onClick={() => act(api.pauseAutomation(view.key, !view.enabled), view.enabled ? "Paused." : "Resumed.")}>
                    {view.enabled ? "Pause" : "Resume"}
                  </button>
                  <button className="button button-quiet" disabled={busy || view.live !== null || !!view.error || changed} title={changed ? "Save first" : "Run it once, now"} onClick={() => act(api.runAutomation(view.key), "Started.")}>
                    Run now
                  </button>
                </>
              )}
              <button className="button" disabled={busy || !!error || !changed || !launcherKnown || !form.workspaceId} onClick={save}>
                {view ? "Save" : "Make it"}
              </button>
            </div>
          </div>
          {view && (
            <div className="auto-history">
              <h3>Last runs</h3>
              {runs === null ? (
                <p className="muted">Reading…</p>
              ) : runs.length === 0 ? (
                <p className="muted">Nothing yet. {view.next !== null ? `The first is ${slotText(view.next, view.zone)}.` : ""}</p>
              ) : (
                <ul className="auto-runs">
                  {runs.map((run) => {
                    const length = run.startedAt !== null && run.endedAt !== null ? durationWords(run.endedAt - run.startedAt) : null;
                    const quiet = run.state === "skipped" || run.state === "missed" || run.state === "interrupted";
                    return (
                      <li key={run.id} className={`auto-run ${quiet ? "auto-run-quiet" : ""}`}>
                        <div className="auto-run-line">
                          <span className={`auto-dot auto-dot-${run.state === "ok" ? "quiet" : run.state === "running" ? "running" : run.state === "asking" ? "asking" : run.state === "finding" ? "finding" : "failed"}`} />
                          <span className="auto-run-when" title={run.why === "now" ? "Run now" : `For the slot ${slotText(run.slotAt, view.zone)}`}>
                            {slotLabel(run.startedAt ?? run.slotAt, HERE)}
                          </span>
                          <span className="auto-run-state">
                            {STATE_WORDS[run.state]}
                            {run.why === "catch-up" ? " (catch-up)" : run.why === "now" ? " (run now)" : ""}
                          </span>
                          {length && <span className="auto-run-len">{length}</span>}
                          {(run.agentId || run.sessionId) && (
                            <button className="button button-quiet auto-run-open" onClick={() => act(api.openAutomationRun(view.key, run.id))}>
                              {run.agentId ? "Show" : "Open conversation"}
                            </button>
                          )}
                          {run.output && (
                            <button className="button button-quiet auto-run-open" onClick={() => setOpenOutput((was) => (was === run.id ? null : run.id))}>
                              Output
                            </button>
                          )}
                        </div>
                        {run.words && <div className="auto-run-words">{run.words}</div>}
                        {run.kept && <div className="auto-run-words muted">Left open: {run.kept}</div>}
                        {openOutput === run.id && run.output && <pre className="auto-run-output">{run.output}</pre>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
