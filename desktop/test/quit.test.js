/**
 * Quitting, as a decision (KUR-179). A signal must never reach the "agents are
 * still running" dialog, ⌘Q must, and neither may ask twice — all of which is
 * ordering, so it is read here with the beat made a queue the test empties.
 * Which handler the signal reaches is Electron's business and is checked on a
 * built app; what is held here is that the gate does the right thing with
 * either ordering.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QuitGate, listenForSignals } from "../quit.js";

function gate() {
  const queue = [];
  const g = new QuitGate({ defer: (fn) => queue.push(fn) });
  const asked = [];
  const ask = () => void asked.push("asked");
  const beat = async () => {
    while (queue.length) queue.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { g, asked, ask, beat };
}

describe("QuitGate", () => {
  it("asks a beat later when nobody has decided — ⌘Q", async () => {
    const { g, asked, ask, beat } = gate();
    expect(g.beforeQuit(ask)).toBe(false);
    expect(asked).toEqual([]);
    await beat();
    expect(asked).toEqual(["asked"]);
  });

  it("lets the quit through without asking once a signal has decided", async () => {
    const { g, asked, ask, beat } = gate();
    g.quitting = true;
    expect(g.beforeQuit(ask)).toBe(true);
    await beat();
    expect(asked).toEqual([]);
  });

  it("does not ask when the signal's handler runs after the quit it caused", async () => {
    const { g, asked, ask, beat } = gate();
    expect(g.beforeQuit(ask)).toBe(false);
    g.quitting = true;
    await beat();
    expect(asked).toEqual([]);
    // The handler's own app.quit() then comes through.
    expect(g.beforeQuit(ask)).toBe(true);
  });

  it("asks once for a second quit while the first is being decided", async () => {
    const queue = [];
    const g = new QuitGate({ defer: (fn) => queue.push(fn) });
    let answer;
    let asks = 0;
    const ask = () => {
      asks++;
      return new Promise((resolve) => (answer = resolve));
    };
    g.beforeQuit(ask);
    queue.shift()();
    await Promise.resolve();
    expect(asks).toBe(1);
    // ⌘Q again over the open dialog.
    expect(g.beforeQuit(ask)).toBe(false);
    expect(queue).toHaveLength(0);
    // Cancel: the next quit asks again.
    answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    g.beforeQuit(ask);
    queue.shift()();
    await Promise.resolve();
    expect(asks).toBe(2);
  });

  it("a dialog that throws does not leave the gate held", async () => {
    const queue = [];
    const g = new QuitGate({ defer: (fn) => queue.push(fn) });
    const original = console.error;
    console.error = () => {};
    try {
      g.beforeQuit(() => {
        throw new Error("no window");
      });
      queue.shift()();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = original;
    }
    g.beforeQuit(() => undefined);
    expect(queue).toHaveLength(1);
  });
});

describe("listenForSignals", () => {
  it("listens for SIGTERM and SIGINT and says which arrived", () => {
    const handlers = new Map();
    const heard = [];
    listenForSignals((signal) => heard.push(signal), (signal, fn) => handlers.set(signal, fn));
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")();
    expect(heard).toEqual(["SIGTERM"]);
  });

  it("is the only place in the app that listens for a signal, and main.js calls it inside whenReady", () => {
    // An earlier process.on for these signals makes libuv install its handler
    // before Electron's, and Electron's then wins — the bug, back.
    const dir = join(import.meta.dir, "..");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".js") && name !== "quit.js")) {
      const source = readFileSync(join(dir, file), "utf8");
      expect({ file, listens: /process\.(on|once|addListener)\(\s*["'`]SIG/.test(source) }).toEqual({ file, listens: false });
    }
    const main = readFileSync(join(dir, "main.js"), "utf8");
    const ready = main.indexOf("app.whenReady().then(async () => {");
    const call = main.indexOf("  stopOnSignals();");
    expect(ready).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(ready);
    expect(main.slice(ready, call).split("\n").length).toBeLessThan(4);
  });
});

describe("packaging", () => {
  it("ships every module main.js and its modules require", () => {
    // electron-builder.yml lists files by name; one left out is an app that
    // crashes at launch while the dev shell works.
    const dir = join(import.meta.dir, "..");
    const listed = new Set([...readFileSync(join(dir, "electron-builder.yml"), "utf8").matchAll(/^\s+- (\S+\.js)$/gm)].map((m) => m[1]));
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
      for (const [, name] of readFileSync(join(dir, file), "utf8").matchAll(/require\("\.\/([^"]+)"\)/g)) {
        const needed = name.endsWith(".js") ? name : `${name}.js`;
        expect({ from: file, needed, listed: listed.has(needed) }).toEqual({ from: file, needed, listed: true });
      }
    }
  });
});
