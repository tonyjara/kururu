/**
 * The hooks a Claude Code started into a profile is handed.
 *
 * What is worth pinning is that every event the hand-installed hooks cover is
 * here with the same status, and that the paths are quoted for `sh`: an app
 * lives under `/Applications/Some Name.app`, and a hook whose command splits on
 * the space fails silently on every turn — which is the failure this exists to
 * end.
 */
import { describe, expect, it } from "bun:test";
import { hookSettings } from "../src/hooks";

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
