/**
 * Where else this machine answers to — the addresses a phone can type in.
 *
 * Kururu serves the same URL to the Electron window and to a phone, and the
 * desktop half of that has never needed this file: the window loads localhost,
 * which is the machine it is already on. The phone is the whole reason. It is
 * somewhere else, and "somewhere else" is either the same Wi-Fi or the tailnet,
 * so what it needs is an address on one of those two and the port the server is
 * already listening on.
 *
 * **This does not run `tailscale`, and that is not a workaround.** Two reasons,
 * and the second is the one that made the decision. Putting a port on somebody's
 * tailnet is their call and never a side effect of opening a dialog, so nothing
 * in kururu should be holding that command — and the `tailscale` binary is not
 * on `PATH` for anyone who installed it from the App Store, where it lives
 * inside the app bundle, so shelling out would report "tailscale is down" to a
 * decent share of the people running it. Reading the interface list answers the
 * question directly instead: tailscaled's whole job is to put a 100.64/10
 * address on a tunnel interface, so the address being *there* is the same fact
 * as the daemon being up, learned from the kernel rather than from a CLI that
 * may not exist. It also costs nothing, which is what lets the dialog re-ask
 * while it is open and notice tailscale coming up.
 *
 * What it cannot learn this way is the MagicDNS name — that really does need the
 * daemon — which is why the dialog offers the IP. An address is what a QR code
 * is for anyway; nobody is going to type either of them.
 */
import { networkInterfaces } from "node:os";
import type { Reach } from "../../shared/wire";

/**
 * Three notes on the shape, which lives in `shared/wire.ts` because the dialog
 * that draws it is in the browser.
 *
 * `port` is advisory. A client builds its URL from the port it is *itself*
 * loaded from, since in dev that is vite on 5173 and handing the phone 7717
 * would serve it a stale build of the app; this is here so the dialog can say
 * when the two differ.
 *
 * `lan` is a list because a machine on Wi-Fi and Ethernet at once has two, and
 * which of them the phone can see is a question only the phone can answer — so
 * all of them are offered rather than guessed between.
 *
 * `tailscale` being null is a real answer, and the dialog says so out loud:
 * "there is no QR here" and "the QR here will not work" look identical
 * otherwise, and only one of them is fixed by turning tailscale on.
 */
export type { Reach };

/** One entry as `os.networkInterfaces()` gives it, reduced to what matters here. */
export interface Address {
  address: string;
  family: string;
  internal: boolean;
}

/**
 * Interfaces that carry traffic somewhere else rather than to a local network.
 * A VPN's tunnel hands out a perfectly ordinary-looking 10.x address that no
 * phone on the sofa can reach, so the name has to be checked as well as the
 * address — this machine has a `utun` on 10.15.16.80 while its actual LAN is
 * 192.168.100.139, and offering the first would send somebody debugging the
 * wrong thing for an afternoon.
 *
 * `awdl`/`llw` are AirDrop's, `anpi` is the internal bus to the Mac's own
 * controllers, and `bridge`/`vmnet`/`vboxnet`/`docker` belong to virtual
 * machines: all of them are networks with nothing on them but this computer.
 */
const NOT_A_LAN = /^(utun|ipsec|ppp|tun|tap|gpd|awdl|llw|anpi|bridge|vmnet|vboxnet|docker)/i;

/** Tailscale's range, 100.64.0.0/10 — the CGNAT block it assigns out of. */
function isTailscale(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * A private address, and therefore one somebody on the same network could use.
 * A public address on an interface would be a machine with no NAT in front of
 * it, which is not a thing to put in a QR code beside the word "local".
 */
function isPrivate(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Which of two LAN addresses to offer first. Home and office networks are
 * 192.168 far more often than anything else, and a 172.16/12 on a Mac is
 * usually Docker rather than a network — so when a machine has several, the one
 * most likely to be the one the phone is on goes first. It is a guess, which is
 * why the others stay on offer rather than being dropped.
 */
function rank(address: string): number {
  const first = Number(address.split(".")[0]);
  return first === 192 ? 0 : first === 10 ? 1 : 2;
}

/**
 * Sort the interfaces into the two ways in. Pure, and takes the table rather
 * than reading it, because every interesting case here is a machine wired some
 * way this one is not — a VPN up, tailscale down, Docker installed — and none
 * of those can be arranged from a test.
 */
export function classify(interfaces: Record<string, Address[] | undefined>): Omit<Reach, "port"> {
  const lan: string[] = [];
  let tailscale: string | null = null;

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses ?? []) {
      // IPv6 is left out on purpose: a URL has to bracket it, a link-local one
      // needs the scope id with it, and there is no case where a phone can
      // reach this over v6 and not over one of the two below.
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (isTailscale(entry.address)) {
        tailscale ??= entry.address;
        continue;
      }
      // 169.254/16 is what an interface gives itself when nothing answered —
      // a cable plugged into nothing, which is precisely not a way in.
      if (entry.address.startsWith("169.254.")) continue;
      if (NOT_A_LAN.test(name) || !isPrivate(entry.address)) continue;
      if (!lan.includes(entry.address)) lan.push(entry.address);
    }
  }

  // Stable within a rank, so the order the kernel lists interfaces in — which
  // puts the built-in Wi-Fi first — survives as the tie-break.
  lan.sort((a, b) => rank(a) - rank(b));
  return { lan, tailscale };
}

/** The same, asked of this machine, now. */
export function reach(port: number): Reach {
  return { port, ...classify(networkInterfaces()) };
}
