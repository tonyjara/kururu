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
  AGY_DEFAULT_MODEL,
  AGY_MODELS,
  LAUNCHERS,
  MODEL_NAME,
  OPENCODE_DEFAULT_MODEL,
  adoptAgyModel,
  adoptLaunch,
  adoptOpencodeModel,
  agyLauncher,
  resumeCommand,
  switchedFrom,
  withPromptFor,
  adoptLaunchers,
  findLauncher,
  launcherCommand,
  launcherFor,
  opencodeLauncher,
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
    for (const cli of AGENT_CLIS.filter((cli) => cli !== "opencode")) expect(LAUNCHERS.some((l) => l.cli === cli && !l.model)).toBe(true);
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
    const none = {
      offClis: [],
      offLaunchers: [],
      bypassClis: [],
      loginsPerProfile: false,
      sleepIdle: true,
      sleepMinutes: 10,
      harnessCli: "claude",
      opencodeModel: OPENCODE_DEFAULT_MODEL,
      agyModel: AGY_DEFAULT_MODEL,
    };
    expect(adoptLaunch(undefined)).toEqual(none);
    expect(adoptLaunch("nonsense")).toEqual(none);
  });

  it("drops CLIs it has never heard of and anything that is not a string", () => {
    expect(
      adoptLaunch({ offClis: ["codex", "gemini", 3, "codex"], offLaunchers: ["x", null], bypassClis: ["gemini", "claude"] }),
    ).toEqual({
      offClis: ["codex"],
      offLaunchers: ["x"],
      bypassClis: ["claude"],
      loginsPerProfile: false,
      sleepIdle: true,
      sleepMinutes: 10,
      harnessCli: "claude",
      opencodeModel: OPENCODE_DEFAULT_MODEL,
      agyModel: AGY_DEFAULT_MODEL,
    });
  });

  it("keeps launcher ids the catalogue no longer has", () => {
    expect(adoptLaunch({ offLaunchers: ["claude:retired-model"] }).offLaunchers).toEqual(["claude:retired-model"]);
  });
});

describe("visibleLaunchers", () => {
  it("shows everything by default, so a new model appears without being ticked", () => {
    const settings = adoptLaunch(undefined);
    expect(visibleLaunchers(settings)).toEqual([...LAUNCHERS]);
  });

  it("leaves out a switched-off CLI and a switched-off model", () => {
    const shown = visibleLaunchers({ ...adoptLaunch(undefined), offClis: ["codex"], offLaunchers: ["claude"] });
    expect(shown.some((l) => l.cli === "codex")).toBe(false);
    expect(shown.some((l) => l.id === "claude")).toBe(false);
    expect(shown.some((l) => l.cli === "claude")).toBe(true);
  });

  it("shows only the configured OpenCode launcher while Runs on is OpenCode", () => {
    const settings = { ...adoptLaunch(undefined), harnessCli: "opencode" as const, opencodeModel: "anthropic/claude-sonnet-5" };
    expect(visibleLaunchers(settings)).toEqual([opencodeLauncher(settings)]);
  });
});

describe("Runs on", () => {
  it("maps default and explicit Claude launchers to the configured OpenCode model", () => {
    const settings = { ...adoptLaunch(undefined), harnessCli: "opencode" as const, opencodeModel: "anthropic/claude-sonnet-5#high" };
    expect(launcherFor(undefined, settings)).toEqual(opencodeLauncher(settings));
    expect(launcherFor("claude:claude-opus-5-5", settings)).toEqual(opencodeLauncher(settings));
    expect(launcherFor("codex:gpt-5.6-sol", settings)?.cli).toBe("codex");
  });

  it("maps an old OpenCode choice back to Claude when Runs on switches back", () => {
    const settings = adoptLaunch(undefined);
    expect(launcherFor("opencode:anthropic/claude-opus-5-5#high", settings)).toEqual(findLauncher("claude"));
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

describe("sleeping idle card agents", () => {
  it("is on at ten minutes unless the file says otherwise", () => {
    expect(adoptLaunch(null)).toMatchObject({ sleepIdle: true, sleepMinutes: 10 });
    expect(adoptLaunch({ sleepIdle: false }).sleepIdle).toBe(false);
    // Only an explicit false turns it off, so a hand-edited "no" leaves it on.
    expect(adoptLaunch({ sleepIdle: "no" }).sleepIdle).toBe(true);
  });

  it("holds the minutes to whole numbers in range, and refuses what is not a number", () => {
    expect(adoptLaunch({ sleepMinutes: 25 }).sleepMinutes).toBe(25);
    expect(adoptLaunch({ sleepMinutes: 2.6 }).sleepMinutes).toBe(3);
    expect(adoptLaunch({ sleepMinutes: 0 }).sleepMinutes).toBe(1);
    expect(adoptLaunch({ sleepMinutes: -40 }).sleepMinutes).toBe(1);
    expect(adoptLaunch({ sleepMinutes: 99999 }).sleepMinutes).toBe(1440);
    expect(adoptLaunch({ sleepMinutes: Number.NaN }).sleepMinutes).toBe(10);
    expect(adoptLaunch({ sleepMinutes: Number.POSITIVE_INFINITY }).sleepMinutes).toBe(10);
    expect(adoptLaunch({ sleepMinutes: "30" }).sleepMinutes).toBe(10);
  });

  it("keeps the minutes while it is switched off, so switching back gives them back", () => {
    const off = adoptLaunch({ sleepIdle: false, sleepMinutes: 45 });
    expect(adoptLaunch({ ...off, sleepIdle: true })).toMatchObject({ sleepIdle: true, sleepMinutes: 45 });
  });
});

describe("adoptLaunchers: another node's + menu, as it arrives", () => {
  it("keeps the rows of the right shape, in order, and drops the rest", () => {
    const got = adoptLaunchers([
      { id: "claude", cli: "claude", label: "Claude" },
      { id: "claude:claude-next-6", cli: "claude", model: "claude-next-6", label: "Claude Next 6" },
      { id: "x", cli: "gemini", label: "Gemini" },
      { id: "claude:bad", cli: "claude", model: "a b; rm -rf ~", label: "Bad" },
      { id: "claude", cli: "claude", label: "Twice" },
      { id: "codex", cli: "codex", label: "  " },
      null,
      "codex",
    ]);
    expect(got).toEqual([
      { id: "claude", cli: "claude", label: "Claude" },
      { id: "claude:claude-next-6", cli: "claude", model: "claude-next-6", label: "Claude Next 6" },
    ]);
  });
  it("is null for a node that sent none, so the caller can fall back", () => {
    expect(adoptLaunchers(undefined)).toBeNull();
    expect(adoptLaunchers({})).toBeNull();
    expect(adoptLaunchers([])).toEqual([]);
  });
  it("is bounded", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `claude:m${i}`, cli: "claude", model: `m${i}`, label: `M${i}` }));
    expect(adoptLaunchers(many)!.length).toBeLessThanOrEqual(64);
  });
});

describe("what Kuru runs on", () => {
  it("is Claude Code unless the file says OpenCode", () => {
    expect(adoptLaunch(null).harnessCli).toBe("claude");
    expect(adoptLaunch({ harnessCli: "gemini" }).harnessCli).toBe("claude");
    expect(adoptLaunch({ harnessCli: "opencode" }).harnessCli).toBe("opencode");
  });

  it("keeps the choice when another page saves its own fields around it", () => {
    const on = adoptLaunch({ harnessCli: "opencode", opencodeModel: "anthropic/claude-sonnet-5-5" });
    expect(adoptLaunch({ ...on, sleepIdle: false })).toMatchObject({ harnessCli: "opencode", opencodeModel: "anthropic/claude-sonnet-5-5" });
  });

  it("takes an OpenCode model as OpenCode spells one, and nothing else", () => {
    expect(adoptOpencodeModel("anthropic/claude-opus-5-5#high")).toBe("anthropic/claude-opus-5-5#high");
    expect(adoptOpencodeModel("  anthropic/claude-sonnet-5-5 ")).toBe("anthropic/claude-sonnet-5-5");
    expect(adoptOpencodeModel("openrouter/anthropic/claude-opus-5-5")).toBe("openrouter/anthropic/claude-opus-5-5");
    for (const bad of ["claude-opus-5-5", "anthropic/", "/x", "a/b c", "a/b;rm -rf", "a/b#", "x".repeat(130) + "/y", 7, null]) {
      expect(adoptOpencodeModel(bad)).toBeNull();
    }
    expect(adoptLaunch({ opencodeModel: "not a model" }).opencodeModel).toBe(OPENCODE_DEFAULT_MODEL);
  });
});

describe("Antigravity's agy", () => {
  it("has a row per model, Opus 5.5 among them, each as agy models names it", () => {
    const rows = LAUNCHERS.filter((l) => l.cli === "agy");
    expect(rows.some((l) => l.model === "claude-opus-5-5-high")).toBe(true);
    expect(rows.find((l) => !l.model)?.id).toBe("agy");
    expect(AGY_MODELS).toContain(AGY_DEFAULT_MODEL);
  });

  it("starts with its model flag, and its bypass only when ticked", () => {
    const row = findLauncher("agy:claude-opus-5-5-high")!;
    expect(launcherCommand(row)).toBe("agy --model claude-opus-5-5-high");
    expect(launcherCommand(row, { ...adoptLaunch(undefined), bypassClis: ["claude"] })).toBe("agy --model claude-opus-5-5-high");
    expect(launcherCommand(row, { ...adoptLaunch(undefined), bypassClis: ["agy"] })).toBe("agy --model claude-opus-5-5-high --dangerously-skip-permissions");
  });

  it("takes a card's words as --prompt-interactive, quoted whole", () => {
    expect(withPromptFor("agy", "agy --model m", "it's -done")).toBe(`agy --model m --prompt-interactive 'it'\\''s -done'`);
    expect(withPromptFor("agy", "agy", "-x")).toBe("agy --prompt-interactive ' -x'");
  });

  it("resumes by the conversation it reported, and not at all without one", () => {
    const row = findLauncher("agy:claude-opus-5-5-high")!;
    const id = "13f042a6-6698-4a14-a210-d71eb5f402eb";
    expect(resumeCommand(row, undefined, id, false)).toBe(`agy --model claude-opus-5-5-high --conversation ${id}`);
    expect(resumeCommand(row, undefined, null, false)).toBeNull();
    expect(resumeCommand(row, undefined, "13f042a6; rm -rf ~", false)).toBeNull();
  });

  it("keeps its model to the catalogue", () => {
    expect(adoptAgyModel("claude-opus-5-5-medium")).toBe("claude-opus-5-5-medium");
    expect(adoptAgyModel("claude-opus-5-5-high; rm")).toBeNull();
    expect(adoptLaunch({ agyModel: "nonsense" }).agyModel).toBe(AGY_DEFAULT_MODEL);
    expect(adoptLaunch({ harnessCli: "agy" }).harnessCli).toBe("agy");
  });
});

describe("Runs on Antigravity", () => {
  const settings = { ...adoptLaunch(undefined), harnessCli: "agy" as const, agyModel: "claude-sonnet-5-5-high" };

  it("puts the default and the Claude rows on the configured agy model", () => {
    expect(launcherFor(undefined, settings)).toEqual(agyLauncher(settings));
    expect(launcherFor("claude:claude-opus-5-5", settings)?.id).toBe("agy:claude-sonnet-5-5-high");
    expect(launcherFor("opencode:anthropic/claude-opus-5-5#high", settings)?.cli).toBe("agy");
  });

  it("leaves a Codex or an Antigravity row asked for by name where it is", () => {
    expect(launcherFor("codex:gpt-5.6-sol", settings)?.cli).toBe("codex");
    expect(launcherFor("agy:gemini-4-argon-high", settings)?.id).toBe("agy:gemini-4-argon-high");
    expect(launcherFor("agy:gemini-4-argon-high", adoptLaunch(undefined))?.id).toBe("agy:gemini-4-argon-high");
  });

  it("offers the switch's row first, then the other agy rows still on", () => {
    const shown = visibleLaunchers({ ...settings, offLaunchers: ["agy:gemini-4-argon-high"] });
    expect(shown[0]?.id).toBe("agy:claude-sonnet-5-5-high");
    expect(shown.every((l) => l.cli === "agy")).toBe(true);
    expect(shown.some((l) => l.id === "agy:gemini-4-argon-high")).toBe(false);
  });

  it("starts a card fresh when the switch moved away from what it ran on, and only then", () => {
    expect(switchedFrom(settings, "claude")).toBe(true);
    expect(switchedFrom(settings, "opencode")).toBe(true);
    expect(switchedFrom(settings, "agy")).toBe(false);
    expect(switchedFrom(settings, "codex")).toBe(false);
    const claude = adoptLaunch(undefined);
    expect(switchedFrom(claude, "agy")).toBe(false);
    expect(switchedFrom(claude, "opencode")).toBe(true);
    expect(switchedFrom({ ...claude, harnessCli: "opencode" }, "agy")).toBe(false);
  });
});

