/**
 * That the OpenRouter chip is drawn for a key kept in the Keychain.
 *
 * On 2026-11-14 it was not: `openrouter.ts` read its key's hint when it was
 * imported, `boot.ts` imports it before `attach` turns the Keychain on, and
 * the file it read held only the `kururu-keychain:` marker — so every server
 * started after the key moved polled the balance and sent the clients null.
 * This imports the module first and turns a sealer on after, which is the
 * order boot has. The sealer is a stand-in that knows one marker, so no real
 * Keychain is touched; it and `KURURU_CONFIG_DIR` are put back after, since
 * bun runs every test file in one process.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyHint } from "../../shared/openrouter";
import { sealConfigSecrets } from "../src/config";
import type { ConfigSealer } from "../src/configkeys";
import { MARKER } from "../src/configkeys";
import { openRouterSnapshot } from "../src/openrouter";

const KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
const SEALED = `${MARKER}0a1b2c3d4e5f`;

const standIn: ConfigSealer = {
  seal: (_file, value) => value,
  open: (file, value) =>
    file === "openrouter.json" && (value as { managementKey?: unknown }).managementKey === SEALED
      ? { ...(value as object), managementKey: KEY }
      : value,
  forget: () => {},
};

describe("the OpenRouter key in the Keychain", () => {
  const dir = mkdtempSync(join(tmpdir(), "kururu-openrouterkey-"));
  const before = process.env.KURURU_CONFIG_DIR;

  beforeAll(() => {
    process.env.KURURU_CONFIG_DIR = dir;
    writeFileSync(join(dir, "openrouter.json"), JSON.stringify({ managementKey: SEALED }), { mode: 0o600 });
    // After the module's import, as `attach` is after boot's.
    sealConfigSecrets(standIn);
  });

  afterAll(() => {
    sealConfigSecrets(null);
    if (before === undefined) delete process.env.KURURU_CONFIG_DIR;
    else process.env.KURURU_CONFIG_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is named on the snapshot when the sealer comes on after the import", () => {
    expect(openRouterSnapshot()?.hint).toBe(keyHint(KEY));
  });
});
