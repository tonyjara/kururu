/**
 * The keymap is a thing a user can break, so this pins the three rules that
 * would let them break it silently: an override never survives naming an action
 * that does not exist, `1`–`9` cannot be taken from the workspace jumps, and a
 * binding put back where it was leaves no trace — which is what makes the stored
 * file a list of *differences* rather than a frozen copy of the defaults.
 *
 * The last of those is the one worth a test. A saved whole map would look
 * identical today and would quietly unbind every action added after it.
 */
import { describe, expect, it } from "bun:test";
import {
  ACTION_INFO,
  ACTIONS,
  DEFAULT_KEYMAP,
  adoptKeys,
  bindKey,
  isBindableKey,
  keymapFrom,
  keysByAction,
} from "../../shared/keys";

describe("the defaults", () => {
  it("bind only actions that exist, so nothing in the table is a dead end", () => {
    for (const action of Object.values(DEFAULT_KEYMAP)) expect(ACTIONS).toContain(action);
  });

  it("describe every action, since the description is all the help overlay has", () => {
    for (const action of ACTIONS) expect(ACTION_INFO[action].label.length).toBeGreaterThan(0);
  });

  it("give every action a key, so nothing ships unreachable", () => {
    const bound = keysByAction(DEFAULT_KEYMAP);
    for (const action of ACTIONS) expect(bound[action]?.length ?? 0).toBeGreaterThan(0);
  });

  it("are all keys somebody could actually bind in Settings", () => {
    for (const key of Object.keys(DEFAULT_KEYMAP)) expect(isBindableKey(key)).toBe(true);
  });
});

describe("a key", () => {
  it("is refused when it is the workspace jumps, which are not in the table to argue with", () => {
    for (const digit of "123456789") expect(isBindableKey(digit)).toBe(false);
    expect(bindKey({}, "3", "help")).toEqual({});
  });

  it("is refused when it is not a key at all", () => {
    expect(isBindableKey("")).toBe(false);
    expect(isBindableKey("ctrl+a")).toBe(false);
    expect(isBindableKey(" ")).toBe(false);
    expect(isBindableKey(null)).toBe(false);
  });

  it("is allowed when it is named rather than typed", () => {
    expect(isBindableKey("left")).toBe(true);
    expect(isBindableKey("space")).toBe(true);
    // Escape is the way out of the capture box, so binding it would make the
    // binding unreachable by the only gesture that could undo it.
    expect(isBindableKey("escape")).toBe(false);
  });
});

describe("rebinding", () => {
  it("takes the key from whatever had it, because a key means one thing", () => {
    // `x` was the only key close-pane had, so taking it leaves that action with
    // nothing — which is allowed, and is why Settings says "unbound" in the row
    // rather than pretending the key is still there.
    const map = keymapFrom(bindKey({}, "x", "help"));
    expect(map.x).toBe("help");
    expect(keysByAction(map)["close-pane"]).toBeUndefined();
  });

  it("leaves an action with several keys the rest of them", () => {
    const map = keymapFrom(bindKey({}, "|", null));
    expect(keysByAction(map)["split-right"]).toEqual(["\\", "%", "]"]);
  });

  it("records nothing when a key is put back where it started", () => {
    const moved = bindKey({}, "x", "help");
    expect(bindKey(moved, "x", "close-pane")).toEqual({});
  });

  /**
   * The whole reason the file holds differences. A saved map would pin the
   * keyboard to the version it was saved in, and an action added later would be
   * unbound for everybody who had ever touched a binding.
   */
  it("leaves every key it did not mention on its default", () => {
    const overrides = bindKey({}, "x", "help");
    expect(keymapFrom(overrides).T).toBe("new-tab");
    expect(Object.keys(overrides)).toEqual(["x"]);
  });

  it("can unbind a default, which is the one thing a plain map could not say", () => {
    const overrides = bindKey({}, "T", null);
    expect(overrides).toEqual({ T: null });
    expect(keymapFrom(overrides).T).toBeUndefined();
  });

  it("refuses an action that does not exist rather than storing it", () => {
    expect(bindKey({}, "q", "launch-missiles" as never)).toEqual({});
  });
});

describe("what was saved", () => {
  it("drops an override naming an action a later kururu renamed away", () => {
    expect(adoptKeys({ q: "read-markdown", w: "help" })).toEqual({ w: "help" });
  });

  it("drops a key nobody could press", () => {
    expect(adoptKeys({ "ctrl+a": "help", "4": "help" })).toEqual({});
  });

  it("keeps an unbinding, since null is a thing somebody meant", () => {
    expect(adoptKeys({ T: null })).toEqual({ T: null });
  });

  it("is nothing at all when the file is missing or nonsense", () => {
    expect(adoptKeys(null)).toEqual({});
    expect(adoptKeys("keys")).toEqual({});
    expect(keymapFrom(adoptKeys(undefined))).toEqual(DEFAULT_KEYMAP);
  });
});
