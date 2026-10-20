// echo.mjs <ws-url> <agentId> [samples] [label] — time a keystroke's echo through a kururu /ws, as a pane does it.
// Run from a checkout (or with KURURU_CHECKOUT) so `ws` resolves. The agent should be a `cat`: its pty's line
// discipline echoes, so what is timed is the road and not a program. Keys go out one at a time, each after the
// last one's echo, at a random 20–80 ms gap so they do not phase-lock to the host's 16 ms flush; after every
// 26th an Enter, then a pause longer than the round trip, or cat's copy of the line is taken for the next echo.
import { createRequire } from "node:module";
const require = createRequire(`${process.env.KURURU_CHECKOUT ?? process.cwd()}/package.json`);
const WebSocket = require("ws");
const [url, agentId, n = "200", label = ""] = process.argv.slice(2);
const N = Number(n);
const ws = new WebSocket(url);
let waiting = null;
let backlog = null;
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.agentId !== agentId) return;
  if (m.type === "backlog") backlog?.(m);
  if (m.type === "output" && waiting && m.data.includes(waiting.ch)) {
    const w = waiting; waiting = null; w.done(performance.now() - w.t0);
  }
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "watch", agentIds: [agentId] }));
  ws.send(JSON.stringify({ type: "propose-size", agentId, cols: 100, rows: 30 }));
  const b = new Promise((r) => (backlog = r));
  const tb = performance.now();
  ws.send(JSON.stringify({ type: "request-backlog", agentId }));
  const bm = await Promise.race([b, pause(5000).then(() => null)]);
  if (!bm) { console.log("no backlog"); process.exit(1); }
  const backlogMs = performance.now() - tb;
  await pause(200);
  const out = [];
  const chars = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < N; i++) {
    const ch = chars[i % 26];
    const ms = await new Promise((resolve) => {
      const w = { ch, t0: 0, done: null };
      const timer = setTimeout(() => { if (waiting === w) { waiting = null; process.stderr.write(`lost #${i} ${ch}\n`); resolve(NaN); } }, 1500);
      w.done = (v) => { clearTimeout(timer); resolve(v); };
      waiting = w;
      w.t0 = performance.now();
      ws.send(JSON.stringify({ type: "input", agentId, data: ch }));
    });
    out.push(ms);
    if (i % 50 === 49) process.stderr.write(`${label}: ${i + 1}\n`);
    if (i % 26 === 25) { ws.send(JSON.stringify({ type: "input", agentId, data: "\r" })); await pause(1500); }
    else await pause(20 + Math.random() * 60);
  }
  const ok = out.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => ok[Math.min(ok.length - 1, Math.floor(p * ok.length))].toFixed(2);
  const mean = (ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(2);
  console.log(JSON.stringify({ label, samples: ok.length, lost: out.length - ok.length, min: q(0), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: ok.at(-1).toFixed(2), mean, backlogMs: backlogMs.toFixed(1), backlogBytes: bm.data.length, grid: `${bm.cols}x${bm.rows}` }));
  ws.close(); process.exit(0);
});
