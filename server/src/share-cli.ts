/**
 * `bun run share`: the phone's link to this server, and its QR code, in the
 * terminal.
 *
 * The Share dialog is where a Mac shows the link, and a child has no window
 * to show one in. Its token is in `access.json`, which is a thing to read
 * once and not a thing to type into a phone, so this asks the server what the
 * dialog asks it (`/api/reach`) and draws the same code the dialog draws
 * (`web/src/qr.ts`), in half-blocks with their colours set outright, so it
 * scans off a dark terminal and a light one alike.
 *
 * Asked of the server rather than worked out here, because which address the
 * phone can use is the bind address, and only the running server knows what
 * that came to. The link carries the token, so it is printed for the person
 * who typed the command and nowhere else: not logged, not in the record.
 *
 *   bun run share           the link and its code
 *   bun run share --url     the link alone, for a script
 *   bun run share --rotate  a new token first, which is "that phone is not mine any more"
 */
import type { Reach, Sharing } from "../../shared/wire";
import { qrMatrix } from "../../web/src/qr";
import { tokenHeaders } from "../localtoken.mjs";

const PORT = Number(process.env.KURURU_PORT ?? 7717);

export type ReachAnswer = Reach & Sharing & { listening?: string[] };

/**
 * The address a phone opens, or null when there is none to give: a server on
 * loopback only, or one with no address anybody else can reach. The address
 * it listens on comes first when that is one address — a child on its
 * tailnet — then the tailnet, then the likeliest LAN address, which is the
 * Share dialog's order. Pure, for the test.
 */
export function shareUrl(answer: ReachAnswer): string | null {
  if (!answer.shared) return null;
  const bound = answer.listening?.[0];
  const specific = bound && !["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(bound) ? bound : null;
  const host = specific ?? answer.tailscale ?? answer.lan[0] ?? null;
  if (!host) return null;
  return `http://${host}:${answer.port}/?k=${encodeURIComponent(answer.token)}`;
}

/**
 * A QR matrix as terminal lines: two modules to a character, `▀` with the top
 * module as its colour and the bottom one as its background, and a quiet zone
 * of four modules around it, as the format asks. Black and bright white are
 * named rather than left to the theme, since a code with its colours
 * inverted is one many phones will not read. Pure, for the test.
 */
export function qrLines(matrix: boolean[][]): string[] {
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const dark = (row: number, col: number) => matrix[row - quiet]?.[col - quiet] === true;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let col = 0; col < size; col++) {
      line += `\x1b[${dark(row, col) ? 30 : 97};${row + 1 < size && dark(row + 1, col) ? 40 : 107}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}

/**
 * A new token, as the dialog's Rotate makes one. Every device is out until it
 * scans again; kururu's own callers read the new one from `access.json`; but
 * an agent already running holds the old one in the `${KURURU_TOKEN}` its MCP
 * configs were started with, and loses kururu's tools until it is started
 * again.
 */
async function rotate(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/share`, {
    method: "POST",
    headers: { "content-type": "application/json", ...tokenHeaders() },
    body: JSON.stringify({ rotate: true }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`the server refused a new token (${response.status})`);
  console.log("A new token: every device is out until it scans this again, and agents already running lose kururu's tools until they are started again.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--rotate")) await rotate();
  let answer: ReachAnswer;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/reach`, { headers: tokenHeaders(), signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    answer = (await response.json()) as ReachAnswer;
  } catch (err) {
    throw new Error(`no server answered on :${PORT} (${err instanceof Error ? err.message : String(err)})`);
  }
  const url = shareUrl(answer);
  if (!url) {
    throw new Error(
      answer.shared
        ? "this server is shared, but this machine has no address a phone could reach — no tailnet and no LAN"
        : "this server answers this machine only, so there is no link to give. Share it from the window, or start it with KURURU_BIND=tailscale",
    );
  }
  if (process.argv.includes("--url")) {
    console.log(url);
    return;
  }
  console.log();
  for (const line of qrLines(qrMatrix(url))) console.log(`  ${line}`);
  console.log();
  console.log(`  ${url}`);
  console.log();
  console.log("  The link carries this server's token: whoever has it is in. `bun run share --rotate` makes a new one.");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`kururu share: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
