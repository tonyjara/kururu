/**
 * Which of two versions is newer, which is the whole of the update check that
 * can be wrong without anybody noticing.
 *
 * Everything else in `update.ts` is a fetch and a cache — visibly broken when it
 * breaks, since the dialog says so. This is the part that fails *quietly*: a
 * comparison that is wrong by one rule offers somebody a downgrade, or sits
 * there saying they are current for a release they have been waiting for. No
 * network here and nothing to mock; the comparison is arithmetic over two
 * strings.
 */
import { describe, expect, it } from "bun:test";
import { isNewer, parseVersion } from "../src/update";

describe("parseVersion", () => {
  it("reads a tag with or without its v", () => {
    expect(parseVersion("v1.2.3")?.parts).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")?.parts).toEqual([1, 2, 3]);
  });

  it("keeps the prerelease as its dotted identifiers", () => {
    expect(parseVersion("1.2.3-beta.2")?.pre).toEqual(["beta", "2"]);
    expect(parseVersion("1.2.3")?.pre).toEqual([]);
  });

  it("refuses what it cannot read rather than guessing at zero", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
  });
});

describe("isNewer", () => {
  it("compares the three numbers in order", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });

  it("does not read a bigger minor as a bigger number", () => {
    // The one every hand-rolled comparison gets wrong: string order puts 9
    // after 10, and a decimal read of "0.10" makes it smaller than "0.9".
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  /**
   * A prerelease is older than the release it leads to, which is the rule that
   * decides whether somebody on 0.2.0 gets offered 0.2.0-beta.1 as an *update*.
   */
  it("puts a prerelease behind the release it leads to", () => {
    expect(isNewer("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(isNewer("0.2.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
    // Numeric identifiers compare as numbers, so 10 is after 9 here too.
    expect(isNewer("0.2.0-beta.10", "0.2.0-beta.9")).toBe(true);
    // A longer prerelease wins the tie: beta.1 is after plain beta.
    expect(isNewer("0.2.0-beta.1", "0.2.0-beta")).toBe(true);
  });

  /**
   * A checkout reports `0.0.0-dev`, and the dialog must not offer it an update
   * *to* a prerelease of the same triple, nor claim a real release is older
   * than it. The first is the rule above; the second is what this pins.
   */
  it("treats a checkout as behind every published release", () => {
    expect(isNewer("0.1.0", "0.0.0-dev")).toBe(true);
    expect(isNewer("0.0.0-dev", "0.1.0")).toBe(false);
  });

  it("declines rather than guesses when either side is unreadable", () => {
    // "I could not read the number" must never come out as "there is an update",
    // because the thing on the other end of it is a prompt somebody will act on.
    expect(isNewer("latest", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "not-a-version")).toBe(false);
  });
});
