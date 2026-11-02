/**
 * A client falling behind (`server/src/backpressure.ts`): a snapshot is held
 * past a megabyte, anything past the cap cuts the client off, and output is
 * never held — a hole in a terminal's stream is a screen drawn wrong.
 */
import { describe, expect, it } from "bun:test";
import { CLIENT_BUFFER_MAX, delivery, liveness, SNAPSHOT_HOLD } from "../src/backpressure";

describe("delivery", () => {
  it("sends anything to a client that is keeping up", () => {
    expect(delivery(0, true)).toBe("send");
    expect(delivery(SNAPSHOT_HOLD, true)).toBe("send");
    expect(delivery(SNAPSHOT_HOLD + 1, false)).toBe("send");
  });

  it("holds a snapshot for a client a megabyte behind, and never output", () => {
    expect(delivery(SNAPSHOT_HOLD + 1, true)).toBe("hold");
    expect(delivery(CLIENT_BUFFER_MAX, false)).toBe("send");
  });

  it("cuts off a client past the cap, whatever the frame", () => {
    expect(delivery(CLIENT_BUFFER_MAX + 1, false)).toBe("cut");
    expect(delivery(CLIENT_BUFFER_MAX + 1, true)).toBe("cut");
  });
});

describe("liveness", () => {
  it("pings a client that answered, and drops one that said nothing since the last ping", () => {
    expect(liveness(true)).toBe("ping");
    expect(liveness(false)).toBe("drop");
  });
});
