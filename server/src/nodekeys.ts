/**
 * This node's keys: who it is to the other nodes, and — on the parent — the
 * key that signs the roster.
 *
 * Three key pairs, kept in one `0600` file, `node.json`, made the first time
 * anything asks and never again. Ed25519 to sign the link's handshake,
 * X25519 for the sealed secrets phase 4 pushes, and on the parent a second
 * Ed25519 pair whose only job is the roster. The roster's key is a separate
 * pair from the node's own so that what a link proves ("I am this member")
 * and what a roster proves ("the parent says these are members") can never
 * be confused for each other, and so that the parent's link key is no more
 * precious than any child's.
 *
 * None of it ever leaves the machine. Not to a client — a client is told
 * public keys at most — not into a backup, where `shared/backup.ts` names
 * the file as never going, and not to another node, which is sent public
 * keys and signatures and nothing else. `node:crypto` does all of it; there
 * is no dependency to audit.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import type { NodeKeys } from "../../shared/nodes";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "node.json";

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key is the 32 bytes after it. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

interface StoredPair {
  /** Raw public key, base64. */
  public: string;
  /** PKCS#8 DER, base64. */
  private: string;
}

interface StoredIdentity {
  id: string;
  sign: StoredPair;
  box: StoredPair;
  /** The parent's roster-signing pair. Absent on every other node. */
  roster?: StoredPair;
}

export interface Identity {
  id: string;
  keys: NodeKeys;
}

function pair(kind: "ed25519" | "x25519"): StoredPair {
  const { publicKey, privateKey } = generateKeyPairSync(kind as "ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { public: spki.subarray(spki.length - 32).toString("base64"), private: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}

function validPair(raw: unknown): raw is StoredPair {
  if (!raw || typeof raw !== "object") return false;
  const p = raw as Record<string, unknown>;
  return typeof p.public === "string" && typeof p.private === "string" && Buffer.from(p.public, "base64").length === 32;
}

let held: StoredIdentity | null = null;
const privateKeys = new Map<string, KeyObject>();

export function newNodeId(): string {
  return `n${randomBytes(6).toString("hex")}`;
}

/**
 * Read once and held. A file that is there but unreadable is *not*
 * replaced: a new identity would be a new member nobody enrolled, and every
 * link this node had would be refused. It throws instead, and the caller
 * leaves nodes off for this run.
 */
function load(): StoredIdentity {
  if (held) return held;
  const raw = readConfigFile(FILE) as Partial<StoredIdentity> | null;
  if (raw === null) {
    held = { id: newNodeId(), sign: pair("ed25519"), box: pair("x25519") };
    save(held);
    return held;
  }
  if (typeof raw.id !== "string" || !/^n[0-9a-f]{12}$/.test(raw.id) || !validPair(raw.sign) || !validPair(raw.box)) {
    throw new Error(`${FILE} is not a node identity this server can read; it was left as it is`);
  }
  held = { id: raw.id, sign: raw.sign, box: raw.box, ...(validPair(raw.roster) ? { roster: raw.roster } : {}) };
  return held;
}

function save(value: StoredIdentity): void {
  writeConfigFile(FILE, value, 0o600);
}

export function identity(): Identity {
  const id = load();
  return { id: id.id, keys: { sign: id.sign.public, box: id.box.public } };
}

function privateOf(stored: StoredPair): KeyObject {
  let key = privateKeys.get(stored.private);
  if (!key) {
    key = createPrivateKey({ key: Buffer.from(stored.private, "base64"), format: "der", type: "pkcs8" });
    privateKeys.set(stored.private, key);
  }
  return key;
}

/** Sign with this node's own link key. */
export function signAsNode(payload: string): string {
  return edSign(null, Buffer.from(payload, "utf8"), privateOf(load().sign)).toString("base64");
}

/** The roster-signing public key, or null on a node that is not a parent. */
export function rosterSigner(): string | null {
  return load().roster?.public ?? null;
}

/** Make this node a parent: the roster key, made once. Returns its public half. */
export function becomeParent(): string {
  const id = load();
  if (!id.roster) {
    held = { ...id, roster: pair("ed25519") };
    save(held);
  }
  return held!.roster!.public;
}

/**
 * Stop being a parent, for a lone parent being paired under another. The
 * key is dropped rather than kept aside, because a roster it signed is
 * exactly what must never be accepted again once another parent's is.
 */
export function stopBeingParent(): void {
  const id = load();
  if (!id.roster) return;
  const { roster: _gone, ...rest } = id;
  held = rest;
  save(held);
}

export function signRoster(payload: string): string {
  const roster = load().roster;
  if (!roster) throw new Error("only the parent signs the roster");
  return edSign(null, Buffer.from(payload, "utf8"), privateOf(roster)).toString("base64");
}

/** Ed25519 over a raw base64 public key. False for anything malformed rather than a throw: a bad signature is a no. */
export function verifySigned(payload: string, signature: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The X25519 public key as a key object, for phase 4's sealing. */
export function boxPublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
}

/** This node's own X25519 private key, for opening what the parent sealed to it (`seal.ts`). Never exported from the process. */
export function boxPrivateKey(): KeyObject {
  return privateOf(load().box);
}

/** A fresh challenge for a link's handshake. */
export function challenge(): string {
  return randomBytes(32).toString("base64");
}

/** Forget what is held, for a test that moves the config directory. */
export function forgetIdentity(): void {
  held = null;
  privateKeys.clear();
}
