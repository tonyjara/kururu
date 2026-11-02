/**
 * How a verb answers the client that asked: a `reply` with the request's id,
 * the result or the error's sentence, never a throw past the socket. Shared
 * by every area of verbs, with the two checks of a field off the wire that
 * more than one of them makes.
 */
import type { WebSocket } from "ws";
import { type ChannelKind, isChannelKind } from "../../../shared/channels";
import { Channels } from "../channels";
import { channels, send } from "../context";

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** A database id and an optional database name, as the viewer's three requests all carry. */
export function validDbRef(dbId: unknown, database: unknown): dbId is string {
  return typeof dbId === "string" && (database === undefined || typeof database === "string");
}

export function reply(ws: WebSocket, id: number, run: () => unknown): void {
  try {
    send(ws, { type: "reply", id, ok: true, result: run() ?? true });
  } catch (err) {
    send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The same, for anything that has to cross the link and come back. */
/** A channel by its kind off the wire. One kind today; the throw is the sentence a page shows for a kind this server does not know. */
export function channelFor(kind: unknown): Channels["telegram"] {
  if (!isChannelKind(kind)) throw new Error("kururu does not know that channel.");
  const byKind: Record<ChannelKind, Channels["telegram"]> = { telegram: channels.telegram };
  return byKind[kind];
}

export async function replyAsync(ws: WebSocket, id: number, run: () => Promise<unknown>): Promise<void> {
  try {
    send(ws, { type: "reply", id, ok: true, result: (await run()) ?? true });
  } catch (err) {
    send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
