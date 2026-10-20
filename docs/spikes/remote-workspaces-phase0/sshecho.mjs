// sshecho.mjs <host> [samples] — a keystroke's echo through `ssh -tt host cat`, the machines feature's road
import { spawn } from "node:child_process";
const [host, n = "150"] = process.argv.slice(2);
const p = spawn("ssh", ["-tt", host, "stty -icanon; exec cat"], { stdio: ["pipe", "pipe", "inherit"] });
let waiting = null;
p.stdout.on("data", (d) => { if (waiting && String(d).includes(waiting.ch)) { const w = waiting; waiting = null; w.done(performance.now() - w.t0); } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await pause(3000);
const out = [];
for (let i = 0; i < Number(n); i++) {
  const ch = "abcdefghijklmnopqrstuvwxyz"[i % 26];
  out.push(await new Promise((resolve) => {
    const w = { ch, t0: performance.now(), done: null };
    const t = setTimeout(() => { if (waiting === w) { waiting = null; resolve(NaN); } }, 3000);
    w.done = (v) => { clearTimeout(t); resolve(v); };
    waiting = w;
    p.stdin.write(ch);
  }));
  await pause(20 + Math.random() * 60);
}
const ok = out.filter(Number.isFinite).sort((a, b) => a - b);
const q = (x) => ok[Math.min(ok.length - 1, Math.floor(x * ok.length))].toFixed(2);
console.log(JSON.stringify({ label: `ssh -tt ${host} cat`, samples: ok.length, lost: out.length - ok.length, min: q(0), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: ok.at(-1).toFixed(2), mean: (ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(2) }));
p.kill(); process.exit(0);
