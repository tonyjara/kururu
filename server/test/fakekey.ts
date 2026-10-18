/**
 * A private key in OpenSSH's own format, for the tests of lending one: the
 * real preamble — magic, cipher, KDF, the public half naming its type — so
 * the code that reads a key's type and passphrase reads what it would read
 * off a disk, and made-up bytes where the key material would be. Nobody's
 * key, and not one ssh could use.
 */
export function fakeOpenSshKey(type = "ssh-ed25519", cipher = "none"): string {
  const s = (v: string | Buffer) => {
    const bytes = typeof v === "string" ? Buffer.from(v) : v;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const pub = Buffer.concat([s(type), s(Buffer.alloc(32, 7))]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), s(cipher), s(cipher === "none" ? "none" : "bcrypt"), s(""), Buffer.from([0, 0, 0, 1]), s(pub), s(Buffer.alloc(64, 9))]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

