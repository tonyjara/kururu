/**
 * The `Sleeper` itself: the loop that ends an idle card's agent, driven
 * through its injected deps.
 *
 * `sleep.test.ts` holds the rules it applies — `notIdle`, `stillWanted` —
 * as pure functions. This is the part that strings them together and then
 * calls `sleep`, which ends a real agent, so what it most has to show is the
 * order: nothing reaches `sleep` that the cheap half kept awake, nothing that
 * the deep half kept awake, and above all nothing whose conversation was not
 * found first. The process table is the machine's own `ps`; the agent under
 * the pty is a `sleep` started as `claude`, which `ps` names the way it names
 * the real one and which spends nobody's tokens.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCard, emptyBoard, noteRun, startRun, type Card, type CardRun } from "../../shared/board";
import type { AgentSnapshot, AgentStatus } from "../../shared/model";
import type { HostLink } from "../src/hostlink";
import { Sleeper, type CardAt, type SleepDeps } from "../src/sleep";

const ID = "0b6c2f1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f";
const AGENT = "a1";
const QUIET_SCREEN = "Done — the flaky test is fixed.\r\n\r\n> \r\n";

let dir = "";
let stand: ChildProcess | null = null;
let shell: ChildProcess | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kururu-sleeper-"));
  // `exec -a` keeps the pid and renames argv[0], so `ps` reads "claude 300"
  // under the pty's root exactly as it reads the real CLI.
  stand = spawn("/bin/bash", ["-c", "exec -a claude sleep 300"], { stdio: "ignore" });
  // And a pty whose agent has gone: nothing under the root but itself.
  shell = spawn("sleep", ["300"], { stdio: "ignore" });
  // Until the exec has happened: before it, `ps` reads `/bin/bash -c …`,
  // and on a loaded machine that can be a while.
  for (let i = 0; i < 100; i++) {
    const args = spawnSync("ps", ["-o", "args=", "-p", String(stand.pid)], { encoding: "utf8" }).stdout.trim();
    if (args.startsWith("claude")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

afterAll(() => {
  stand?.kill("SIGKILL");
  shell?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** A transcript whose last reply is `reply`, where the session's own hook said it was. */
function transcript(reply: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}`, `${ID}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  const line = (entry: unknown) => JSON.stringify(entry);
  writeFileSync(
    path,
    [
      line({ type: "user", message: { role: "user", content: "fix it" } }),
      line({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: reply }] } }),
    ].join("\n") + "\n",
  );
  return path;
}

function finishedCard(run: Partial<CardRun> = {}): Card & { run: CardRun } {
  const board = noteRun(
    startRun(addCard(emptyBoard(), { title: "flaky test" }, "c0", 0), "c0", {
      agentId: AGENT,
      launcher: "claude",
      label: "Claude",
      startedAt: 1,
      sessionId: ID,
    }),
    AGENT,
    "done",
    false,
    2,
  );
  const card = board.cards[0]!;
  return { ...card, run: { ...card.run!, ...run } };
}

interface World {
  on?: boolean;
  card?: Card & { run: CardRun };
  agent?: Partial<AgentSnapshot> | null;
  screen?: string | null;
  harness?: boolean;
  holding?: boolean;
  hint?: string | null;
}

/** A Sleeper over one card, and what it did. */
function world(w: World = {}) {
  const card = w.card ?? finishedCard();
  const agent =
    w.agent === null
      ? undefined
      : ({ id: AGENT, status: "idle" as AgentStatus, exited: false, pid: stand!.pid!, command: "claude", ...w.agent } as unknown as AgentSnapshot);
  const at: CardAt = { profileId: "p1", workspaceId: "w1", card, prompt: "fix the flaky test" };
  const slept: { at: CardAt; agent: AgentSnapshot }[] = [];
  const host = {
    find: (id: string) => (agent && id === agent.id ? agent : undefined),
    // A host from before protocol 3, so the screen is read off a backlog.
    text: () => null,
    backlog: async () => {
      if (w.screen === null) throw new Error("gone");
      return w.screen ?? QUIET_SCREEN;
    },
  } as unknown as HostLink;
  const deps: SleepDeps = {
    host,
    // Zero minutes: `quietSince` starts at the Sleeper's own construction and
    // the second look reads the real clock, so anything above zero would keep
    // every agent awake for that long in real time.
    settings: () => ({ on: w.on ?? true, minutes: 0 }),
    cards: () => [at],
    taken: () => new Set(),
    grid: () => ({ cols: 80, rows: 24 }),
    isHarness: () => w.harness ?? false,
    holding: () => w.holding ?? false,
    transcript: () => (w.hint === undefined ? transcript("Fixed, and the test passes.") : w.hint),
    claudeDir: () => join(dir, "no-claude"),
    codexHome: () => join(dir, "no-codex"),
    learned: () => {},
    sleep: (sleptAt, sleptAgent) => slept.push({ at: sleptAt, agent: sleptAgent }),
  };
  const sleeper = new Sleeper(deps);
  const why = () => sleeper.looked().find((look) => look.agentId === AGENT)?.why;
  return { sleeper, slept, why, tick: () => sleeper.tick(Date.now() + 1) };
}

describe("Sleeper", () => {
  it("ends a finished, quiet agent whose conversation is on disk", async () => {
    const w = world();
    await w.tick();
    expect(w.slept).toHaveLength(1);
    expect(w.slept[0]!.agent.id).toBe(AGENT);
    expect(w.slept[0]!.at.card.run.sessionId).toBe(ID);
    expect(w.why()).toBeNull();
  });

  it("does nothing while it is switched off", async () => {
    const w = world({ on: false });
    await w.tick();
    expect(w.slept).toHaveLength(0);
    expect(w.why()).toBe("sleeping idle card agents is switched off");
  });

  it("never looks at the harness, or at an agent that has exited", async () => {
    for (const w of [world({ harness: true }), world({ agent: { exited: true } }), world({ agent: null })]) {
      await w.tick();
      expect(w.slept).toHaveLength(0);
      expect(w.sleeper.looked()).toHaveLength(0);
    }
  });

  it("keeps awake whatever the cheap half says is not idle", async () => {
    const cases: [World, string][] = [
      [{ agent: { status: "working" } }, "working"],
      [{ agent: { status: "blocked" } }, "waiting on you: a prompt"],
      [{ holding: true }, "waiting on you: a message is waiting to be typed into it"],
      [{ card: finishedCard({ state: "working" }) }, "working"],
    ];
    for (const [setup, reason] of cases) {
      const w = world(setup);
      await w.tick();
      expect(w.slept).toHaveLength(0);
      expect(w.why()).toBe(reason);
    }
  });

  it("keeps awake a prompt with something typed in it, until a turn takes it", async () => {
    const w = world();
    w.sleeper.typed(AGENT, "half a sent");
    await w.tick();
    expect(w.slept).toHaveLength(0);
    expect(w.why()).toBe("waiting on you: something is typed into its prompt and not sent");
    w.sleeper.status(AGENT, "working");
    await w.tick();
    expect(w.slept).toHaveLength(1);
  });

  it("keeps awake a run with no conversation id to resume", async () => {
    const w = world({ card: finishedCard({ sessionId: null }) });
    await w.tick();
    expect(w.slept).toHaveLength(0);
    expect(w.why()).toBe("it has no conversation id to resume");
  });

  it("keeps awake a run whose conversation cannot be found — never ends what cannot come back", async () => {
    const w = world({ hint: null });
    await w.tick();
    expect(w.slept).toHaveLength(0);
    expect(w.why()).toBe("its conversation could not be found, so it could not be resumed");
  });

  it("keeps awake a run whose last reply asks something", async () => {
    const w = world({ hint: transcript("Fixed. Want me to commit this?") });
    await w.tick();
    expect(w.slept).toHaveLength(0);
    expect(w.why()).toBe("waiting on you: its last reply asked something");
  });

  it("keeps awake what its screen says is working, asking, or cannot be read", async () => {
    const cases: [string | null, string][] = [
      [null, "its screen could not be read"],
      ["thinking…\r\n✻ Pondering… (esc to interrupt)\r\n", "working, by its screen"],
    ];
    for (const [screen, reason] of cases) {
      const w = world({ screen });
      await w.tick();
      expect(w.slept).toHaveLength(0);
      expect(w.why()).toBe(reason);
    }
  });

  it("keeps awake a terminal whose agent has gone back to a shell", async () => {
    const w = world({ agent: { pid: shell!.pid! } });
    await w.tick();
    expect(w.slept).toHaveLength(0);
    expect(w.why()).toBe("its agent has exited, and what is left is a shell");
  });

  it("forgets a terminal that is no longer a card's", async () => {
    const w = world();
    w.sleeper.typed(AGENT, "x");
    await w.tick();
    expect(w.sleeper.looked()).toHaveLength(1);
    w.sleeper.forget(AGENT);
    expect(w.sleeper.looked()).toHaveLength(0);
  });
});
