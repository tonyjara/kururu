/**
 * The servers this window has been pointed at, and how an address typed into a
 * box becomes one.
 *
 * Kururu's desktop no longer runs a server; it connects to one, which may be on
 * this machine or on a box that is always on. That makes the address a thing the
 * user *chose*, and a choice kururu could never invent for them — so it goes in
 * XDG's config directory next to the keymap and the mascot, on `config.ts`'s
 * reasoning, rather than in the state directory that holds things kururu would
 * happily rebuild.
 *
 * `127.0.0.1:7717` is always a candidate whether or not it is in the file. It is
 * where `bun run dev` puts a server, it is what a first launch has to be able to
 * find with nothing saved anywhere, and it is not a preference to be lost — so
 * it is offered as a built-in rather than written in on first use, which would
 * make "the local one" indistinguishable from "one I typed once".
 */
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const FILE = "servers.json";
const LOCAL = "http://127.0.0.1:7717";

function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "kururu");
}

function file() {
  return path.join(configDir(), FILE);
}

/**
 * What somebody typed, as a URL, or null if it cannot be one.
 *
 * People type `100.84.2.19`, `vm:7717` and `http://vm:7717` and mean the same
 * thing all three times, so the scheme and the port are filled in rather than
 * demanded. `vm:7717` is the interesting one: `new URL` reads it as the scheme
 * `vm:` and is perfectly happy, so the test for "has a scheme" has to be the
 * `//`, not the colon.
 */
function normalize(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const withScheme = text.includes("://") ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // A tailnet name served over https is on 443 and says so by being https; only
  // a bare host needs kururu's own port supplied.
  if (!url.port && url.protocol === "http:") url.port = "7717";
  // The address is an origin: a path would be carried into every request the
  // page makes and none of them expect a prefix.
  return url.origin;
}

function read() {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    if (!Array.isArray(parsed?.servers)) return [];
    return parsed.servers
      .map((entry) => ({ address: normalize(entry?.address), lastUsed: Number(entry?.lastUsed) || 0 }))
      .filter((entry) => entry.address);
  } catch {
    // Missing, unreadable or not JSON all mean the same thing: nothing saved.
    return [];
  }
}

/** Atomically, for the reason `config.ts` gives: the alternative to a rename is a truncated file. */
function write(servers) {
  try {
    mkdirSync(configDir(), { recursive: true });
    const temp = `${file()}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
    renameSync(temp, file());
  } catch {
    // A list that could not be saved is still the list for this session.
  }
}

/**
 * Everything worth trying, most recently used first, with the local one always
 * present. `builtin` is what tells the picker not to offer a Forget button for
 * something that would come straight back.
 */
function candidates() {
  const saved = read().sort((a, b) => b.lastUsed - a.lastUsed);
  const entries = saved.map((entry) => ({ ...entry, builtin: entry.address === LOCAL }));
  if (!entries.some((entry) => entry.address === LOCAL)) {
    entries.push({ address: LOCAL, lastUsed: 0, builtin: true });
  }
  return entries;
}

/** Note that we connected, which is also what puts a new address in the file. */
function remember(address) {
  const normalized = normalize(address);
  if (!normalized) return null;
  const servers = read().filter((entry) => entry.address !== normalized);
  servers.unshift({ address: normalized, lastUsed: Date.now() });
  // Enough to be a memory, not so many that the picker becomes a list to read.
  write(servers.slice(0, 12));
  return normalized;
}

function forget(address) {
  const normalized = normalize(address);
  if (!normalized) return;
  write(read().filter((entry) => entry.address !== normalized));
}

module.exports = { LOCAL, candidates, forget, normalize, remember };
