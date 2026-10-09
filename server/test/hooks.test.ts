/**
 * The hooks a Claude Code started into a profile is handed.
 *
 * What is worth pinning is that every event the hand-installed hooks cover is
 * here with the same status, and that the paths are quoted for `sh`: an app
 * lives under `/Applications/Some Name.app`, and a hook whose command splits on
 * the space fails silently on every turn — which is the failure this exists to
 * end. And that a `Notification` is only `blocked` when it is a question: the
 * idle reminder a minute after every turn was the one that was not.
 */
import { describe, expect, it } from "bun:test";
import { asksNothing, hookSettings, runsReporter } from "../src/hooks";

type Settings = { hooks: Record<string, { hooks: { type: string; async: boolean; command: string }[] }[]> };

describe("hookSettings", () => {
  const settings = hookSettings("/Applications/My App.app/Contents/MacOS/kururu", "/x/it's/report.mjs") as Settings;

  it("covers each event with its status", () => {
    const commands = Object.fromEntries(
      Object.entries(settings.hooks).map(([event, groups]) => [event, groups[0]?.hooks[0]?.command ?? ""]),
    );
    expect(Object.keys(commands).sort()).toEqual(
      ["Notification", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"].sort(),
    );
    expect(commands.Notification).toContain("report.mjs' blocked >");
    expect(commands.Stop).toContain("report.mjs' done >");
    expect(commands.UserPromptSubmit).toContain("report.mjs' working >");
    expect(commands.SessionStart).toContain("report.mjs' >");
  });

  it("quotes both paths and never fails the turn", () => {
    const command = settings.hooks.Stop?.[0]?.hooks[0]?.command ?? "";
    expect(command).toStartWith("ELECTRON_RUN_AS_NODE=1 '/Applications/My App.app/Contents/MacOS/kururu' ");
    expect(command).toContain(`'/x/it'\\''s/report.mjs'`);
    expect(command).toEndWith("|| true");
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.async).toBe(true);
  });
});

describe("runsReporter", () => {
  const script = "/Applications/kururu.app/Contents/Resources/report.mjs";
  const one = (command: unknown) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });

  it("knows the hand-installed line and the bundled one", () => {
    expect(runsReporter(one("bun /src/kururu/server/src/report-cli.ts done || true"), script)).toBe(true);
    expect(runsReporter(hookSettings("/bin/node", script), script)).toBe(true);
  });

  it("does not take somebody else's report.mjs for ours", () => {
    expect(runsReporter(one("node /elsewhere/report.mjs"), script)).toBe(false);
  });

  it("says no to a profile with nothing in it, or nothing it can read", () => {
    for (const settings of [{}, null, "hooks", { hooks: [] }, { hooks: { Stop: "x" } }, one(42)]) {
      expect(runsReporter(settings, script)).toBe(false);
    }
  });
});

describe("asksNothing", () => {
  const note = (fields: Record<string, unknown>) => ({ hook_event_name: "Notification", ...fields });

  it("keeps blocked for the notifications that are questions", () => {
    for (const type of [
      "permission_prompt",
      "worker_permission_prompt",
      "elicitation_dialog",
      "elicitation_url_dialog",
      "agent_needs_input",
    ]) {
      expect(asksNothing(note({ notification_type: type, message: "Claude needs your permission to use Bash" }))).toBe(false);
    }
  });

  it("drops the idle reminder, which is a turn that already ended", () => {
    expect(asksNothing(note({ notification_type: "idle_prompt", message: "Claude is waiting for your input" }))).toBe(true);
  });

  it("drops the rest, and a type it has never heard of", () => {
    for (const type of ["auth_success", "elicitation_complete", "computer_use_enter", "push_notification", "agent_completed", "some_new_type"]) {
      expect(asksNothing(note({ notification_type: type, message: "x" }))).toBe(true);
    }
  });

  it("goes by the words for a Claude Code that sends no type", () => {
    expect(asksNothing(note({ message: "Claude is waiting for your input" }))).toBe(true);
    expect(asksNothing(note({ message: "Claude needs your permission to use Bash" }))).toBe(false);
  });

  it("has nothing to say about any other event, or no payload", () => {
    expect(asksNothing({ hook_event_name: "Stop", notification_type: "idle_prompt" })).toBe(false);
    expect(asksNothing({ hook_event_name: "PreToolUse" })).toBe(false);
    expect(asksNothing(null)).toBe(false);
  });
});
