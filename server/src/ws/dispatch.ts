
import type { WebSocket } from "ws";
import { handsOf } from "../../../shared/harness";
import { type ClientMessage, parseClientMessage } from "../../../shared/wire";
import { clients, type ClientState, harness, send, watches } from "../context";
import { paneVerbs } from "./panes";
import { lookVerbs } from "./look";
import { profileVerbs } from "./profiles";
import { terminalVerbs } from "./terminals";
import { workspaceVerbs } from "./workspaces";
import { kuruVerbs } from "./kuru";
import { voiceVerbs } from "./voice";
import { nodeVerbs } from "./nodes";
import { machineVerbs } from "./machines";
import { serviceVerbs } from "./services";
import { dbViewerVerbs } from "./dbviewer";
import { boardVerbs } from "./board";
import { readerVerbs } from "./reader";
import { browserVerbs } from "./browser";

/**
 * One frame off a client's socket. Everything past the gate is trusted to be
 * the user, not to be well formed: `JSON.parse("null")` succeeds, and a verb
 * read off it threw outside any try — `ws.on("message")` has none — which is
 * an uncaught exception, and a server that under `bun run dev` stays down
 * until the next save. So the shape is checked before anything reads it, and
 * a verb that throws on a field it was not sent is logged and answered,
 * never the end of the process.
 */
export function handleMessage(ws: WebSocket, raw: string): void {
  const st = clients.get(ws);
  if (!st) return;
  const msg = parseClientMessage(raw);
  if (!msg) {
    // Its length and not its words: a frame from a terminal can be typing.
    console.error(`kururu: dropped a client message that is not one (${raw.length} characters)`);
    return;
  }
  try {
    dispatchMessage(ws, st, msg);
  } catch (err) {
    console.error(`kururu: a "${msg.type}" message failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    const id = (msg as { id?: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id)) send(ws, { type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function dispatchMessage(ws: WebSocket, st: ClientState, msg: ClientMessage): void {
  // The user typing or moving about, from any client, is what an Auto Swap
  // waits for or gives way to — see `handsOf`. Before the verb runs, so that a
  // switch somebody just made is never followed by a swap that was waiting.
  // Typing also names its terminal, which the harness does not type into
  // while the user is.
  const hands = handsOf(msg.type);
  if (hands) harness.hands(hands, msg.type === "input" ? msg.agentId : undefined);

  // A verb about another node's workspace goes there and is never done here;
  // see `nodewatch.ts`. A watcher's own verbs are this node's, ids bare.
  if (!st.watcher && watches.handle(ws, st, msg)) return;

  for (const verbs of VERBS) if (verbs(ws, st, msg)) return;
}

/**
 * The verbs by area, each answering whether a message was its own. No message
 * type belongs to two areas, so the order is only which are asked first: the
 * ones a person does most.
 */
const VERBS: ReadonlyArray<(ws: WebSocket, st: ClientState, msg: ClientMessage) => boolean> = [
  terminalVerbs,
  paneVerbs,
  workspaceVerbs,
  lookVerbs,
  kuruVerbs,
  voiceVerbs,
  nodeVerbs,
  machineVerbs,
  serviceVerbs,
  dbViewerVerbs,
  profileVerbs,
  boardVerbs,
  readerVerbs,
  browserVerbs,
];
