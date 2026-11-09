/**
 * The nodes view for a caller with no socket, and pairing a new node.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import type { ServerResponse } from "node:http";
import { qualifyRoot } from "../../../shared/remote";
import { nodes, watches } from "../context";
import { json, MEDIA_TYPE, readJsonBody, serveRaw } from "./respond";
import type { Route } from "./router";

export const nodeRoutes: Route[] = [
  /**
   * The nodes view, for a caller with no socket: `kururu child join` reads
   * it for the link coming up, and the desktop's picker and tray
   * read it for the nodes they offer. Behind the gate, since on the parent
   * each node's URL carries its share token.
   */
  {
    path: "/api/nodes",
    handle: (req, res, url) => {
      json(res, nodes.view());
      return;
    },
  },

  /**
   * Join the Mac, for `kururu child join <mac> <code>` on a box with no
   * window: this server makes the post, since it holds the keys and the
   * share token the Mac is handed. Behind the gate like everything else.
   */
  {
    path: "/api/nodes/pair",
    method: "POST",
    handle: async (req, res, url) => {
      try {
        const body = (await readJsonBody(req)) as { text?: unknown } | null;
        json(res, await nodes.join(body?.text));
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 409);
      }
      return;
    },
  },
];

/**
 * `/api/node/<id>/ls`, `docs`, `markdown` and `file-raw`: what the local
 * route of the same name answers, asked of the node. Every root the answer
 * names is qualified on the way to the page, so the tree's and the picker's
 * next verb says whose disk it is about; the markup's image links are
 * pointed back through here, since `/api/file-raw` is this disk's.
 */
export async function nodeRead(res: ServerResponse, node: string, op: string, query: URLSearchParams): Promise<void> {
  const root = query.get("root") ?? "";
  const path = query.get("path") ?? "";
  try {
    switch (op) {
      case "ls":
        return json(res, await watches.ask(node, { type: "files-ask", op: "ls", root, path }));
      case "docs": {
        const answer = (await watches.ask(node, { type: "files-ask", op: "docs", root })) as { roots?: unknown; root?: unknown; docs?: unknown };
        const roots = Array.isArray(answer.roots) ? answer.roots.filter((r): r is string => typeof r === "string") : [];
        return json(res, {
          roots: roots.map((r) => qualifyRoot(node, r)),
          root: typeof answer.root === "string" ? qualifyRoot(node, answer.root) : "",
          docs: Array.isArray(answer.docs) ? answer.docs : [],
        });
      }
      case "markdown": {
        const answer = (await watches.ask(node, { type: "doc-ask", op: "markdown", root, path })) as Record<string, unknown>;
        // An attribute is the only place a bare quote survives the renderer —
        // markdown-it escapes one in text — so this finds the image links and
        // nothing a document says.
        const html = typeof answer.html === "string" ? answer.html.replaceAll('"/api/file-raw?', `"/api/node/${node}/file-raw?`) : "";
        return json(res, { ...answer, html });
      }
      case "file-raw": {
        const answer = (await watches.ask(node, { type: "doc-ask", op: "raw", root, path })) as { type?: unknown; data?: unknown };
        if (typeof answer.data !== "string") throw new Error("that node sent no file");
        const type = typeof answer.type === "string" && MEDIA_TYPE.test(answer.type) ? answer.type : "application/octet-stream";
        return serveRaw(res, type, Buffer.from(answer.data, "base64"));
      }
      default:
        return json(res, { error: "not a read of another computer's this server makes" }, 404);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    json(res, op === "docs" ? { roots: [], root: "", docs: [], error } : { error }, 400);
  }
}
