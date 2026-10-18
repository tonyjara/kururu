/**
 * Who holds a socket, read off the two tools that know: `ss` on Linux and
 * `lsof` on macOS. Pure parsing of captured output, so the Linux half is
 * checked on a Mac and the other way round. The `ss` samples are the shapes
 * iproute2 6.x prints with `-H`; the `lsof -U` one is macOS 26's.
 */
import { describe, expect, it } from "bun:test";
import { parseLsofUnix, parseSsTcp, parseSsUnix } from "../sockowner.mjs";

const SS_UNIX = [
  'u_str LISTEN 0      4096   /run/user/1000/bus 19530            * 0     users:(("dbus-broker",pid=1234,fd=3),("dbus-broker-lau",pid=1233,fd=3))',
  'u_str LISTEN 0      511    /home/me/.local/state/kururu/ptyhost.sock 88812 * 0 users:(("node",pid=4321,fd=21))',
  "u_seq LISTEN 0      4096   /run/udev/control 1234 * 0",
  'u_str LISTEN 0      4096   @/tmp/.X11-unix/X0 3333 * 0 users:(("Xwayland",pid=900,fd=7))',
  'u_str LISTEN 0      511    /tmp/k2 state/ptyhost.sock 99001 * 0 users:(("node",pid=7001,fd=20))',
  "",
].join("\n");

describe("parseSsUnix", () => {
  it("finds the host by its socket's path", () => {
    const host = parseSsUnix(SS_UNIX).find((socket) => socket.path.endsWith("/kururu/ptyhost.sock"));
    expect(host).toEqual({ path: "/home/me/.local/state/kururu/ptyhost.sock", pids: [4321] });
  });

  it("names every process holding a shared listener once", () => {
    expect(parseSsUnix(SS_UNIX).find((socket) => socket.path === "/run/user/1000/bus")?.pids).toEqual([1234, 1233]);
  });

  it("keeps a socket another user holds, with nobody named", () => {
    expect(parseSsUnix(SS_UNIX).find((socket) => socket.path === "/run/udev/control")?.pids).toEqual([]);
  });

  it("keeps a path with a space in it whole", () => {
    expect(parseSsUnix(SS_UNIX).find((socket) => socket.pids.includes(7001))?.path).toBe("/tmp/k2 state/ptyhost.sock");
  });

  it("reads lines without the netid column too", () => {
    expect(parseSsUnix('LISTEN 0 511 /s/ptyhost.sock 42 * 0 users:(("node",pid=12,fd=3))')).toEqual([{ path: "/s/ptyhost.sock", pids: [12] }]);
  });

  it("is empty for nothing, and for anything that is not a listener", () => {
    expect(parseSsUnix("")).toEqual([]);
    expect(parseSsUnix('u_str ESTAB 0 0 /run/user/1000/bus 19531 * 19530 users:(("node",pid=4321,fd=22))')).toEqual([]);
  });
});

describe("parseSsTcp", () => {
  const sample = [
    'LISTEN 0      511          127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=1234,fd=23))',
    'LISTEN 0      511              [::1]:5173          [::]:*    users:(("node",pid=1234,fd=24))',
    "LISTEN 0      4096              [::]:22            [::]:*",
    'LISTEN 0      4096     127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=15))',
    'LISTEN 0      511                  *:3000             *:*    users:(("next-server (v1",pid=777,fd=22),("node",pid=778,fd=22))',
    'LISTEN 0      511    100.101.102.103:7717       0.0.0.0:*    users:(("node",pid=99,fd=20))',
  ].join("\n");

  it("groups ports under the pid holding them, one port for v4 and v6 alike", () => {
    const byPid = parseSsTcp(sample);
    expect(byPid.get(1234)).toEqual([5173]);
    expect(byPid.get(99)).toEqual([7717]);
  });

  it("reads the port after the last colon, an interface suffix and all", () => {
    expect(parseSsTcp(sample).get(600)).toEqual([53]);
  });

  it("counts a listener two processes share for both, a name with a paren in it included", () => {
    const byPid = parseSsTcp(sample);
    expect(byPid.get(777)).toEqual([3000]);
    expect(byPid.get(778)).toEqual([3000]);
  });

  it("leaves out a socket whose holder it cannot see", () => {
    expect([...parseSsTcp(sample).values()].flat()).not.toContain(22);
  });
});

describe("parseLsofUnix", () => {
  const sample = [
    "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "Kururu    19330   me    3u  unix 0x8c1a5e2b0a1d3f00      0t0      /Users/me/.local/state/kururu/ptyhost.sock",
    "Kururu    19330   me   21u  unix 0x8c1a5e2b0a1d4e00      0t0      /Users/me/.local/state/kururu/ptyhost.sock",
    "node      40001   me   18u  unix 0x8c1a5e2b0a1d5d00      0t0      ->0x8c1a5e2b0a1d4e00",
  ].join("\n");

  it("names the holder of each path, once per line it holds it on", () => {
    const sockets = parseLsofUnix(sample);
    expect(sockets).toEqual([
      { path: "/Users/me/.local/state/kururu/ptyhost.sock", pids: [19330] },
      { path: "/Users/me/.local/state/kururu/ptyhost.sock", pids: [19330] },
    ]);
  });
});
