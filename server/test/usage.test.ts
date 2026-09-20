/**
 * That a response from somebody else's API cannot become a wrong bar.
 *
 * `limitsFrom` is the only part of the usage path that is pure, and it is also
 * the only part that matters for correctness, because everything downstream of
 * it trusts what it returns: the client multiplies `percent` straight into a CSS
 * width. The endpoint is undocumented, which makes "the shape changed" a thing
 * that will happen rather than a thing to guard against on principle — so what
 * is checked here is mostly the degradation, not the happy path.
 *
 * The rule throughout is the one `layout.ts` states about numbers off the wire
 * and the one `files.ts` states about paths: refuse, never repair. A limit that
 * cannot be read is dropped, because there is no honest default for "how much of
 * somebody's account is left" — zero and a hundred are both assertions a parser
 * would be inventing, and each is badly wrong in one direction.
 */
import { describe, expect, it } from "bun:test";
import { limitsFrom } from "../src/usage";

/** One entry as the account actually sends it, for tests to bend out of shape. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "session",
    group: "session",
    percent: 41,
    severity: "normal",
    resets_at: "2026-09-19T00:40:00.000Z",
    scope: null,
    is_active: true,
    ...over,
  };
}

describe("limitsFrom", () => {
  it("reads a limit as the account states it", () => {
    expect(limitsFrom({ limits: [entry()] })).toEqual([
      {
        kind: "session",
        group: "session",
        percent: 41,
        severity: "normal",
        resetsAt: "2026-09-19T00:40:00.000Z",
        scope: null,
      },
    ]);
  });

  it("takes the model name off a scoped limit", () => {
    const scoped = entry({ kind: "weekly_scoped", scope: { model: { display_name: "Opus" } } });
    expect(limitsFrom({ limits: [scoped] })[0]!.scope).toBe("Opus");
  });

  /**
   * A scope object with no name in it is the shape of a limit scoped to
   * something that is not a model — a surface, in the responses seen so far. It
   * is a real limit and it draws, it just has nothing to add to its label.
   */
  it("keeps a scoped limit whose scope names no model", () => {
    const odd = entry({ kind: "weekly_scoped", scope: { surface: "cowork" } });
    expect(limitsFrom({ limits: [odd] })).toHaveLength(1);
    expect(limitsFrom({ limits: [odd] })[0]!.scope).toBeNull();
  });

  /**
   * The case this whole file exists for. Every one of these is a plausible thing
   * for an endpoint to start sending, and every one of them would otherwise
   * become a bar drawn at a width somebody would act on.
   */
  it("drops a limit whose percent is not a finite number", () => {
    for (const percent of [null, undefined, "41", NaN, Infinity, -Infinity, {}, []]) {
      expect(limitsFrom({ limits: [entry({ percent })] })).toEqual([]);
    }
  });

  /** A percent outside 0–100 is clamped rather than dropped: the reading is real. */
  it("clamps a percent that overshoots", () => {
    expect(limitsFrom({ limits: [entry({ percent: 140 })] })[0]!.percent).toBe(100);
    expect(limitsFrom({ limits: [entry({ percent: -20 })] })[0]!.percent).toBe(0);
  });

  it("drops a limit with no kind, which has nothing to label it with", () => {
    for (const kind of [null, undefined, "", "   ", 7]) {
      expect(limitsFrom({ limits: [entry({ kind })] })).toEqual([]);
    }
  });

  /**
   * `group` and `severity` are the two fields with an honest default. A limit
   * missing its group is still on its own clock, and `normal` is the only
   * severity that claims nothing — guessing `critical` would be alarming
   * somebody on a parser's behalf.
   */
  it("falls back for group and severity rather than dropping the limit", () => {
    const bare = limitsFrom({ limits: [entry({ group: null, severity: null })] })[0]!;
    expect(bare.group).toBe("session");
    expect(bare.severity).toBe("normal");
  });

  it("keeps a limit with no reset clock", () => {
    expect(limitsFrom({ limits: [entry({ resets_at: null })] })[0]!.resetsAt).toBeNull();
  });

  /**
   * An unknown kind is passed through, not filtered. The account has added a
   * limit kind before and will again, and the failure that matters is a new cap
   * going undrawn — by construction, a new cap is the one nobody is expecting.
   */
  it("passes through a kind it has never seen", () => {
    const next = limitsFrom({ limits: [entry({ kind: "monthly_all", group: "monthly" })] });
    expect(next).toHaveLength(1);
    expect(next[0]!.kind).toBe("monthly_all");
  });

  it("says nothing at all when the response is not the shape it expects", () => {
    for (const body of [null, undefined, {}, { limits: null }, { limits: "none" }, 42, "{}"]) {
      expect(limitsFrom(body)).toEqual([]);
    }
  });

  it("skips junk entries without losing the good ones beside them", () => {
    const mixed = { limits: [null, entry(), "nope", entry({ kind: "weekly_all" }), 7] };
    expect(limitsFrom(mixed).map((l) => l.kind)).toEqual(["session", "weekly_all"]);
  });
});
