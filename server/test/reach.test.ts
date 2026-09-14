/**
 * Which address the phone is offered.
 *
 * Every case worth testing is a machine wired some way this one is not — a
 * corporate VPN up, tailscale down, Docker installed, a cable in a dead socket —
 * so the interface table is handed in rather than read. The failure this guards
 * against is quiet and expensive in the same way a wrong QR code is: an address
 * that looks entirely plausible, encodes cleanly, and times out on the phone
 * with nothing to say why.
 */
import { describe, expect, it } from "bun:test";
import { classify, type Address } from "../src/reach";

const v4 = (address: string, internal = false): Address => ({ address, family: "IPv4", internal });
const v6 = (address: string): Address => ({ address, family: "IPv6", internal: false });

describe("classify", () => {
  it("finds the Wi-Fi address and no tailnet when tailscale is down", () => {
    expect(
      classify({
        lo0: [v4("127.0.0.1", true)],
        en0: [v6("fe80::1"), v4("192.168.100.139")],
      }),
    ).toEqual({ lan: ["192.168.100.139"], tailscale: null });
  });

  it("finds the tailnet address when it is up", () => {
    expect(
      classify({
        en0: [v4("192.168.1.20")],
        utun4: [v4("100.101.102.103")],
      }),
    ).toEqual({ lan: ["192.168.1.20"], tailscale: "100.101.102.103" });
  });

  /**
   * The case this machine is actually in, and the reason the interface name is
   * checked at all: a VPN tunnel holds a 10.x address that passes every test an
   * address alone can be given, and is reachable from nowhere the phone is.
   */
  it("does not mistake a VPN tunnel for the local network", () => {
    expect(
      classify({
        en0: [v4("192.168.100.139")],
        utun4: [v4("10.15.16.80")],
      }),
    ).toEqual({ lan: ["192.168.100.139"], tailscale: null });
  });

  it("skips an interface that gave itself an address because nothing answered", () => {
    expect(classify({ en7: [v4("169.254.246.163")] }).lan).toEqual([]);
  });

  it("skips loopback, IPv6 and the machine's own virtual networks", () => {
    expect(
      classify({
        lo0: [v4("127.0.0.1", true), v6("::1")],
        en0: [v4("192.168.1.5"), v6("fe80::c")],
        awdl0: [v6("fe80::a")],
        bridge100: [v4("192.168.64.1")],
        vmnet8: [v4("172.16.83.1")],
        "docker0": [v4("172.17.0.1")],
      }),
    ).toEqual({ lan: ["192.168.1.5"], tailscale: null });
  });

  it("refuses a public address, which is a machine with nothing in front of it", () => {
    expect(classify({ en0: [v4("203.0.113.9")] }).lan).toEqual([]);
  });

  /**
   * Wi-Fi and Ethernet at once is the ordinary way to have two, and which of
   * them the phone can see is not knowable from here — so both are offered,
   * with the likelier one first rather than the other one dropped.
   */
  it("offers every LAN address, likeliest first", () => {
    expect(
      classify({
        en5: [v4("172.20.10.4")],
        en1: [v4("10.0.0.8")],
        en0: [v4("192.168.1.5")],
      }).lan,
    ).toEqual(["192.168.1.5", "10.0.0.8", "172.20.10.4"]);
  });

  it("keeps the kernel's order between addresses of equal rank", () => {
    expect(
      classify({
        en0: [v4("192.168.1.5")],
        en1: [v4("192.168.2.7")],
      }).lan,
    ).toEqual(["192.168.1.5", "192.168.2.7"]);
  });

  it("lists an address once however many interfaces carry it", () => {
    expect(classify({ en0: [v4("192.168.1.5")], en1: [v4("192.168.1.5")] }).lan).toEqual([
      "192.168.1.5",
    ]);
  });

  it("knows where the tailscale range starts and stops", () => {
    // 100.64/10 is 100.64.0.0 – 100.127.255.255. Either side of it is ordinary
    // public space, and calling one of those a tailnet address would put a
    // stranger's IP in the dialog under the word "Tailscale".
    expect(classify({ utun0: [v4("100.64.0.1")] }).tailscale).toBe("100.64.0.1");
    expect(classify({ utun0: [v4("100.127.255.254")] }).tailscale).toBe("100.127.255.254");
    expect(classify({ utun0: [v4("100.63.0.1")] }).tailscale).toBeNull();
    expect(classify({ utun0: [v4("100.128.0.1")] }).tailscale).toBeNull();
  });

  it("says nothing at all on a machine with no networks", () => {
    expect(classify({ lo0: [v4("127.0.0.1", true)] })).toEqual({ lan: [], tailscale: null });
  });
});
