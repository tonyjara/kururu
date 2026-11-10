/**
 * The automation's file and its rules: the file read and written back the
 * same, refused in words; `decide` on time, late, missed, stacked and full;
 * the result line read off a reply; a shell run's end read off its screen.
 */
import { describe, expect, it } from "bun:test";
import {
  automationText,
  catchUpFor,
  decide,
  dotOf,
  parseAutomation,
  runPrompt,
  shellEnd,
  shellLine,
  verdictOf,
  type AutomationDef,
} from "../../shared/automation";

const PASAPY = `---
name: Pasapy crawl review
schedule: every 2 weeks on mon at 09:00 America/Asuncion from 2026-11-23
run: agent
launcher: claude:claude-opus-5-5
needs: machine MV, login claude
timeout: 90m
max-usd: 15
catch-up: 3d
tell: always
---
/crawl-maintenance
`;

function def(text: string): AutomationDef {
  const parsed = parseAutomation(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.def;
}

describe("the file", () => {
  it("reads the plan's Pasapy file", () => {
    const d = def(PASAPY);
    expect(d.name).toBe("Pasapy crawl review");
    expect(d.run).toBe("agent");
    expect(d.launcher).toBe("claude:claude-opus-5-5");
    expect(d.needs).toEqual(["machine MV", "login claude"]);
    expect(d.timeoutMs).toBe(90 * 60_000);
    expect(d.maxUsd).toBe(15);
    expect(d.catchUpMs).toBe(3 * 86_400_000);
    expect(d.tell).toBe("always");
    expect(d.body).toBe("/crawl-maintenance");
    expect(catchUpFor(d)).toBe(3 * 86_400_000);
  });

  it("writes it back as the same text, and that text reads as the same definition", () => {
    const d = def(PASAPY);
    expect(automationText(d)).toBe(PASAPY);
    expect(def(automationText(d))).toEqual(d);
  });

  it("leaves defaults out, and gives a daily schedule half a day to catch up", () => {
    const d = def("---\nname: Disk check\nschedule: every day at 07:00 UTC\nrun: shell\n---\ndf -h\n");
    expect(automationText(d)).toBe("---\nname: Disk check\nschedule: every day at 07:00 UTC\nrun: shell\n---\ndf -h\n");
    expect(d.tell).toBe("finding");
    expect(catchUpFor(d)).toBe(12 * 3_600_000);
    expect(catchUpFor(def("---\nname: x\nschedule: every 5 minutes UTC\nrun: shell\n---\ntrue\n"))).toBe(0);
  });

  it("keeps a description on its own line, after the name, and reads it back", () => {
    const purpose = "Every second Monday, reviews the last two weeks of Pasapy's crawls with /crawl-maintenance: finds broken or silent sources and extraction bugs, and reports what to fix.";
    const text = PASAPY.replace("schedule:", `description: ${purpose}\nschedule:`);
    const d = def(text);
    expect(d.description).toBe(purpose);
    expect(automationText(d)).toBe(text);
    expect(def(automationText(d))).toEqual(d);
    // Written where the form or a file put it, it comes back in the one place.
    expect(automationText(def(PASAPY.replace("tell: always", `tell: always\ndescription: ${purpose}`)))).toBe(text);
    expect(def(PASAPY).description).toBeNull();
    expect(def(PASAPY.replace("schedule:", "description:\nschedule:")).description).toBeNull();
  });

  it("refuses in words rather than running a typo as something else", () => {
    const why = (text: string) => {
      const parsed = parseAutomation(text);
      return parsed.ok ? null : parsed.error;
    };
    const base = (extra: string, body = "hello") => `---\nname: x\nschedule: every day at 07:00 UTC\n${extra}\n---\n${body}\n`;
    expect(why("name: x")).toContain("---");
    expect(why(base("launcher: claude:no-such-model"))).toContain("not one of kururu's launchers");
    expect(why(base(""))).toContain("names its launcher");
    expect(why(base("run: shell\nlauncher: claude:claude-opus-5-5"))).toContain("no launcher");
    expect(why(base("run: shell\ndir: ../elsewhere"))).toContain("no ..");
    expect(why(base("run: shell\ndir: /etc"))).toContain("relative");
    expect(why(base("run: shell\ncolour: green"))).toContain("not a key");
    expect(why(base("run: shell\ntimeout: forever"))).toContain("not a duration");
    expect(why(base("run: shell\nneeds: the moon"))).toContain("machine <name>");
    expect(why(base("run: shell\ntell: sometimes"))).toContain("tell is");
    expect(why(base("run: shell", ""))).toContain("command");
    expect(why(base("run: shell\nrun: agent"))).toContain("twice");
    expect(why(base(`run: shell\ndescription: ${"a".repeat(401)}`))).toContain("at most 400");
    expect(why(base("run: shell\ndescription: one\tline"))).toContain("one line");
    expect(why("---\nname: x\nschedule: every 1 minutes UTC\nrun: shell\n---\ntrue\n")).toContain("schedule:");
  });
});

describe("decide", () => {
  const slot = Date.parse("2026-11-23T12:00:00Z");
  const facts = { slot, now: slot, catchUpMs: 3 * 86_400_000, passed: 0, running: false, full: false };

  it("runs a slot on time within two minutes, and never early", () => {
    expect(decide(facts)).toEqual({ act: "run", why: "schedule", words: null });
    expect(decide({ ...facts, now: slot + 119_000 }).act).toBe("run");
    expect(decide({ ...facts, now: slot - 1 })).toEqual({ act: "early" });
  });

  it("runs a late slot once inside the window, and says how late", () => {
    const late = decide({ ...facts, now: slot + 3 * 3_600_000 });
    expect(late).toMatchObject({ act: "run", why: "catch-up" });
    if (late.act === "run") expect(late.words).toContain("late by 3 h");
  });

  it("writes a slot past its window missed, with how many went by", () => {
    const missed = decide({ ...facts, now: slot + 4 * 86_400_000, passed: 2 });
    expect(missed.act).toBe("missed");
    if (missed.act === "missed") {
      expect(missed.words).toContain("past its 3 days catch-up window");
      expect(missed.words).toContain("2 earlier slots");
    }
    // No window at all: anything past the two minutes is missed.
    expect(decide({ ...facts, now: slot + 5 * 60_000, catchUpMs: 0 }).act).toBe("missed");
  });

  it("never stacks runs, and waits rather than skips when the profile is full", () => {
    expect(decide({ ...facts, running: true })).toEqual({ act: "skipped", words: "the last run is still going." });
    expect(decide({ ...facts, full: true })).toEqual({ act: "wait" });
    // A slot past its window is missed whether or not the last run is going.
    expect(decide({ ...facts, running: true, now: slot + 4 * 86_400_000 }).act).toBe("missed");
  });
});

describe("a run's words", () => {
  it("puts the body first, so a slash command is still the first thing typed", () => {
    const prompt = runPrompt({ name: "Pasapy crawl review", body: "/crawl-maintenance" }, "kururu-run-7-ab12");
    expect(prompt.startsWith("/crawl-maintenance\n\n")).toBe(true);
    expect(prompt).toContain("[kururu-run-7-ab12]");
    expect(prompt).toContain("RESULT: ok");
  });

  it("reads the last RESULT line, through markdown, and a doubt is a finding", () => {
    expect(verdictOf("All fine.\n\nRESULT: ok")).toEqual({ state: "ok", words: null });
    expect(verdictOf("RESULT: ok\nthen more\n**RESULT: finding: three sources silent since 12 Nov**")).toEqual({
      state: "finding",
      words: "three sources silent since 12 Nov",
    });
    expect(verdictOf("`RESULT: failed: the database did not answer`")).toEqual({ state: "failed", words: "the database did not answer" });
    expect(verdictOf("I did it, I think.")).toEqual({ state: "finding", words: "it ended without a RESULT line" });
    expect(verdictOf(null).state).toBe("finding");
  });

  it("reads a shell run's status and its last lines off the screen", () => {
    const tag = "kururu-run-3-ff00";
    expect(shellLine("echo 'hi'", tag)).toBe(`sh -c 'echo '\\''hi'\\'''; printf '\\n%s %s\\n' 'kururu-run-3-ff00' "$?"`);
    const screen = `$ something\nline one\nline two\n\n${tag} 3\n\n`;
    expect(shellEnd(screen, tag)).toEqual({ status: 3, output: "$ something\nline one\nline two" });
    expect(shellEnd("no marker here", tag)).toBeNull();
    // The command line itself, echoed, is not the marker: it has no status after it.
    expect(shellEnd(`printf '%s %s' ${tag} "$?"\n${tag} 0`, tag)?.status).toBe(0);
  });

  it("draws the dot from the live run, then paused, then how the last ended", () => {
    const run = (state: "running" | "asking" | "ok" | "failed" | "finding") => ({ state }) as never;
    expect(dotOf({ enabled: true, error: null, live: run("asking"), last: null })).toBe("asking");
    expect(dotOf({ enabled: false, error: null, live: null, last: run("ok") })).toBe("paused");
    expect(dotOf({ enabled: true, error: null, live: null, last: run("failed") })).toBe("failed");
    expect(dotOf({ enabled: true, error: "x", live: null, last: null })).toBe("broken");
    expect(dotOf({ enabled: true, error: null, live: null, last: null })).toBe("quiet");
  });
});
