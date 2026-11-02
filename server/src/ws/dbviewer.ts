/**
 * The database viewer: a workspace's catalog, a table's rows and a query, every one read-only unless the viewer's switch says otherwise.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { DB_ROW_CAP, DB_SQL_MAX } from "../../../shared/databases";
import type { ClientMessage } from "../../../shared/wire";
import type { ClientState } from "../context";
import { dbCatalog, dbQuery, dbRows } from "../databases";
import { replyAsync, validDbRef } from "./reply";

export function dbViewerVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    // Each is a request, so a malformed one is answered rather than dropped: a
    // viewer left waiting on a reply that never comes is a spinner forever.

    case "db-catalog":
      void replyAsync(ws, msg.id, () => {
        if (!validDbRef(msg.dbId, msg.database)) throw new Error("Not a database kururu knows.");
        return dbCatalog(msg.dbId, msg.database);
      });
      return true;

    case "db-rows":
      void replyAsync(ws, msg.id, () => {
        if (!validDbRef(msg.dbId, msg.database)) throw new Error("Not a database kururu knows.");
        if (typeof msg.schema !== "string" || typeof msg.table !== "string") throw new Error("No table named.");
        // Numbers off the wire: NaN loses every comparison it is in, so a
        // page that is not a number is refused rather than clamped to one.
        if (!Number.isFinite(msg.offset) || !Number.isFinite(msg.limit) || msg.offset < 0 || msg.limit < 1) {
          throw new Error("Not a page.");
        }
        return dbRows(msg.dbId, msg.database, msg.schema, msg.table, msg.offset, Math.min(msg.limit, DB_ROW_CAP));
      });
      return true;

    case "db-query":
      void replyAsync(ws, msg.id, () => {
        if (!validDbRef(msg.dbId, msg.database)) throw new Error("Not a database kururu knows.");
        if (typeof msg.sql !== "string") throw new Error("Nothing to run.");
        if (msg.sql.length > DB_SQL_MAX) throw new Error("That is a file, not a query.");
        return dbQuery(msg.dbId, msg.database, msg.sql, msg.writes === true);
      });
      return true;
  }
  return false;
}
