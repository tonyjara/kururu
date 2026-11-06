/**
 * Marks over HTTP: a set posted by the window — a browser tab's marks, or
 * the screen pen's (`kind: "screen"`, `shared/ink.ts`) — and a set's files
 * read back for a chip.
 *
 * The body is JSON with the pictures in it as base64, because a set is one
 * thing — twenty crops and a view and the record that names them — and two
 * dozen requests that each might fail would leave half a set. Behind the gate
 * like `/api/drop`, and nothing in it is Electron's, so any client of the gate
 * can post the same body. `shared/marks.ts` holds the body to its shape;
 * `server/src/marks.ts` writes it.
 */
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MARKS_MAX_BYTES } from "../../../shared/marks";
import { MarksRefused, keepMarks, markFile, markSetExists } from "../marks";
import { json, readJsonBody, text } from "./respond";
import type { Route } from "./router";

export const markRoutes: Route[] = [
  {
    path: "/api/marks",
    handle: async (req, res) => {
      if (req.method !== "POST") {
        text(res, "POST only", 405);
        return;
      }
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MARKS_MAX_BYTES) {
        json(res, { error: `that set is over ${MARKS_MAX_BYTES / 1024 / 1024} MB` }, 413);
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, MARKS_MAX_BYTES);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        return;
      }
      try {
        json(res, keepMarks(body));
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, err instanceof MarksRefused ? 422 : 500);
      }
    },
  },
];

/**
 * `GET /api/marks/<id>` — whether a set is still there, for a chip — and
 * `GET /api/marks/<id>/<file>` for one of its files. Only names a set may
 * hold, under an id the server minted; a swept set's files are a 404 that
 * says "cleaned up".
 */
export function markRead(req: IncomingMessage, res: ServerResponse, id: string, file: string | null): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    text(res, "GET only", 405);
    return;
  }
  if (file === null) {
    json(res, { id, exists: markSetExists(id) });
    return;
  }
  const found = markFile(id, file);
  if ("missing" in found) {
    text(res, found.missing, 404);
    return;
  }
  const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8";
  res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(found.path).on("error", () => res.destroy()).pipe(res);
}
