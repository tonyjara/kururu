/**
 * A secret sealed to one node: opened by that node and nobody else, and
 * known to have come from the parent.
 *
 * The parent lends a child its keys over a link that is already an
 * authenticated WebSocket on WireGuard, so sealing on top of that can look
 * like belt and braces. It is not, for two reasons. The link's payload passes
 * through the ws library, the server's buffers and any log a later edit
 * adds, and a sealed value is ciphertext in all of them. And sealing makes
 * the envelope the thing that is trusted rather than the road it came by, so
 * a later phase that relays one through a peer — or holds one for a node
 * that is away — cannot weaken anything.
 *
 * The construction is the standard one, from `node:crypto` with nothing to
 * audit beside it: an ephemeral X25519 key agreed with the node's X25519 key
 * from the roster, HKDF-SHA256 over the shared secret with both public keys
 * as salt, and AES-256-GCM with a random nonce and the envelope's header as
 * additional data — so an envelope for one kind or one node cannot be opened
 * as another. A seal says who may open it and not who made it, so the
 * parent's node key signs the whole envelope too.
 */
import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { canonical } from "../../shared/nodes";
import { sealAad, sealSigned, type SealedSecret, type SealHeader } from "../../shared/secrets";
import { boxPublicKey } from "./nodekeys";

const INFO = Buffer.from("kururu-secret-v1", "utf8");

function rawPublic(key: KeyObject): Buffer {
  const spki = key.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32);
}

function keyFor(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, recipient]), INFO, 32));
}

/**
 * Seal `value` to the node whose X25519 public key is `recipientBox` (base64
 * raw, as the roster lists it), and sign it with `sign` — the parent's node
 * key. Throws on a key that is not one.
 */
export function seal(value: unknown, header: Omit<SealHeader, "v">, recipientBox: string, sign: (payload: string) => string): SealedSecret {
  const recipient = boxPublicKey(recipientBox);
  const ephemeral = generateKeyPairSync("x25519");
  const epk = rawPublic(ephemeral.publicKey);
  const key = keyFor(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), epk, rawPublic(recipient));
  const nonce = randomBytes(12);
  const full: SealHeader = { v: 1, ...header };
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(sealAad(full), "utf8"));
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  const unsigned = { ...full, epk: epk.toString("base64"), nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  return { ...unsigned, sig: sign(sealSigned(unsigned)) };
}

/**
 * Open an envelope with this node's X25519 private key. Throws on anything
 * that does not open — a tampered byte, a header changed, another node's
 * envelope — with no more said than that, since the reason is for no one.
 * The signature is the caller's to check first, against the parent's key.
 */
export function unseal(envelope: SealedSecret, privateBox: KeyObject, publicBox: string): unknown {
  const epk = Buffer.from(envelope.epk, "base64");
  const mine = Buffer.from(publicBox, "base64");
  if (epk.length !== 32 || mine.length !== 32) throw new Error("not an envelope this node can open");
  const key = keyFor(diffieHellman({ privateKey: privateBox, publicKey: boxPublicKey(envelope.epk) }), epk, mine);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(sealAad(envelope), "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
  } catch {
    throw new Error("the envelope does not open: it was changed, or it is for another node");
  }
  return JSON.parse(plain.toString("utf8")) as unknown;
}

/**
 * What a value is known by between the two nodes: SHA-256 over its
 * canonical JSON. Sent over the link and kept in the grants, never to a
 * client, which is sent hints. The child holds the value anyway, so its
 * digest tells nobody on either end anything they do not have.
 */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("base64");
}
