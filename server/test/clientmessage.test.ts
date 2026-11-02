/**
 * The floor under every verb a client sends. Each of these is valid JSON,
 * and `null` was a server crash: the dispatch read `msg.type` off it outside
 * any try. The guard around the dispatch itself is `index.ts`'s and is
 * checked against a running server; this is the pure half.
 */
import { describe, expect, it } from "bun:test";
import { parseClientMessage } from "../../shared/wire";

describe("parseClientMessage", () => {
  it("drops valid JSON that is not a message", () => {
    for (const raw of ["null", "[]", "[{\"type\":\"input\"}]", "\"input\"", "42", "true", "{}", "{\"type\":7}", "{\"type\":null}"]) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it("drops what is not JSON at all", () => {
    expect(parseClientMessage("")).toBeNull();
    expect(parseClientMessage("{type:")).toBeNull();
  });

  it("passes an object with a string type, fields and all", () => {
    expect(parseClientMessage(JSON.stringify({ type: "input", agentId: "a1", data: "x" }))).toEqual({ type: "input", agentId: "a1", data: "x" } as never);
  });
});
