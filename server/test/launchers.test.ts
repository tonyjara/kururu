/**
 * The new-tab menu's catalogue, and what is remembered as switched off.
 *
 * The catalogue is edited by a skill as well as by hand, and every model name in
 * it ends up inside `sh -c`. So the first thing checked is that nothing in it
 * would need quoting — a model name with a space or a `;` in it is a typo today
 * and a command tomorrow.
 */
import { describe, expect, it } from "bun:test";
import {
  AGENT_CLIS,
  LAUNCHERS,
  MODEL_NAME,
  adoptLaunch,
  findLauncher,
  launcherCommand,
  visibleLaunchers,
} from "../../shared/launchers";

describe("LAUNCHERS", () => {
  it("has ids that are unique and say which CLI they belong to", () => {
    const ids = LAUNCHERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of LAUNCHERS) expect(l.id).toBe(l.model ? `${l.cli}:${l.model}` : l.cli);
  });

  it("only has model names a shell will take as one word", () => {
    for (const l of LAUNCHERS) if (l.model !== undefined) expect(l.model).toMatch(MODEL_NAME);
  });

  it("has a default-model row for every CLI", () => {
    for (const cli of AGENT_CLIS) expect(LAUNCHERS.some((l) => l.cli === cli && !l.model)).toBe(true);
  });

  it("builds the command with the model flag", () => {
    expect(launcherCommand(findLauncher("claude")!)).toBe("claude");
    const pinned = LAUNCHERS.find((l) => l.cli === "codex" && l.model)!;
    expect(launcherCommand(pinned)).toBe(`codex --model ${pinned.model}`);
  });

  it("adds the bypass flag only for a CLI that has it switched on", () => {
    const settings = { offClis: [], offLaunchers: [], bypassClis: ["claude" as const] };
    expect(launcherCommand(findLauncher("claude")!, settings)).toBe("claude --dangerously-skip-permissions");
    expect(launcherCommand(findLauncher("codex")!, settings)).toBe("codex");
    const pinned = LAUNCHERS.find((l) => l.cli === "codex" && l.model)!;
    expect(launcherCommand(pinned, { ...settings, bypassClis: ["codex"] })).toBe(
      `codex --model ${pinned.model} --dangerously-bypass-approvals-and-sandbox`,
    );
  });
});

describe("adoptLaunch", () => {
  it("makes defaults out of nothing", () => {
    expect(adoptLaunch(undefined)).toEqual({ offClis: [], offLaunchers: [], bypassClis: [], loginsPerProfile: false });
    expect(adoptLaunch("nonsense")).toEqual({ offClis: [], offLaunchers: [], bypassClis: [], loginsPerProfile: false });
  });

  it("drops CLIs it has never heard of and anything that is not a string", () => {
    expect(
      adoptLaunch({ offClis: ["codex", "gemini", 3, "codex"], offLaunchers: ["x", null], bypassClis: ["gemini", "claude"] }),
    ).toEqual({
      offClis: ["codex"],
      offLaunchers: ["x"],
      bypassClis: ["claude"],
      loginsPerProfile: false,
    });
  });

  it("keeps launcher ids the catalogue no longer has", () => {
    expect(adoptLaunch({ offLaunchers: ["claude:retired-model"] }).offLaunchers).toEqual(["claude:retired-model"]);
  });
});

describe("visibleLaunchers", () => {
  it("shows everything by default, so a new model appears without being ticked", () => {
    expect(visibleLaunchers({ offClis: [], offLaunchers: [], bypassClis: [] })).toEqual([...LAUNCHERS]);
  });

  it("leaves out a switched-off CLI and a switched-off model", () => {
    const shown = visibleLaunchers({ offClis: ["codex"], offLaunchers: ["claude"], bypassClis: [] });
    expect(shown.some((l) => l.cli === "codex")).toBe(false);
    expect(shown.some((l) => l.id === "claude")).toBe(false);
    expect(shown.some((l) => l.cli === "claude")).toBe(true);
  });
});


describe("loginsPerProfile", () => {
  it("is off unless the file says exactly true", () => {
    expect(adoptLaunch(null).loginsPerProfile).toBe(false);
    expect(adoptLaunch({ loginsPerProfile: "yes" }).loginsPerProfile).toBe(false);
    expect(adoptLaunch({ loginsPerProfile: 1 }).loginsPerProfile).toBe(false);
    expect(adoptLaunch({ loginsPerProfile: true }).loginsPerProfile).toBe(true);
  });

  it("survives another page saving its own fields around it", () => {
    const on = adoptLaunch({ loginsPerProfile: true });
    expect(adoptLaunch({ ...on, bypassClis: ["claude"] }).loginsPerProfile).toBe(true);
  });
});
