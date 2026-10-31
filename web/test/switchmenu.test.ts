/**
 * What a folded list of switches says while it is shut, because that line is
 * all of the setting a page shows until somebody opens it.
 */
import { describe, expect, it } from "bun:test";

import { switchesSummary } from "../src/settings/ui";

describe("switchesSummary", () => {
  it("counts what is on, of how many", () => {
    expect(switchesSummary(3, 5)).toBe("3 of 5 on");
    expect(switchesSummary(1, 7)).toBe("1 of 7 on");
  });

  it("says all and none in words", () => {
    expect(switchesSummary(5, 5)).toBe("All 5 on");
    expect(switchesSummary(0, 5)).toBe("None on");
  });
});
