/**
 * The file tree and the reader: the roots, documents, markdown rendered, a card as markdown, raw bytes, directories, a file operation, and the buffer nvim reports.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { noteCards } from "../../../shared/notecards";
import { host, overlay, workspaces } from "../context";
import { NVIM_BODY_LIMIT, nvimBuffer } from "../editors";
import { parseFileOp, runFileOp } from "../fileops";
import { allowedRoots, findDocs, listDirs, readBytes, readFile } from "../files";
import { renderMarkdown } from "../markdown";
import { json, readBody, readJsonBody, serveRaw } from "./respond";
import type { Route } from "./router";

export const fileRoutes: Route[] = [
  // --- file browsing -------------------------------------------------------
  {
    path: "/api/roots",
    handle: (req, res, url) => {
      json(res, { roots: allowedRoots() });
      return;
    },
  },

  {
    path: "/api/nvim-buffer",
    method: "POST",
    handle: (req, res, url) => {
      void readBody(req, NVIM_BODY_LIMIT)
        .then((body) => nvimBuffer(JSON.parse(body.toString("utf8"))))
        .catch(() => {
          // an editor that sent something unparseable is not worth a log line
        });
      json(res, { ok: true });
      return;
    },
  },

  /**
   * The documents a picker offers, and the projects it could offer them from.
   *
   * The roots travel with every answer rather than being a second request: the
   * list and the thing that changes which list it is belong on screen together,
   * and this is answering a tap on a phone. With exactly one project there is no
   * choice to make and the client is not asked to make one — it gets the
   * documents straight away. With several and no root named, `root` comes back
   * empty and the client draws the projects instead, which is a question kururu
   * genuinely cannot answer for it.
   */
  {
    path: "/api/docs",
    handle: (req, res, url) => {
      const roots = allowedRoots();
      const asked = url.searchParams.get("root") ?? "";
      const root = asked || (roots.length === 1 ? (roots[0] ?? "") : "");
      if (!root) {
        json(res, { roots, root: "", docs: [] });
        return;
      }
      try {
        json(res, { roots, root, docs: findDocs(root) });
      } catch (err) {
        json(res, { roots, root: "", docs: [], error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    },
  },

  {
    path: "/api/markdown",
    handle: (req, res, url) => {
      const root = url.searchParams.get("root") ?? "";
      const path = url.searchParams.get("path") ?? "";
      void (async () => {
        try {
          const file = readFile(root, path);
          json(res, await renderMarkdown(file.text, root, path));
        } catch (err) {
          json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
        }
      })();
      return;
    },
  },

  /**
   * A card's body as markup, for a card popped out as a note
   * (`web/src/components/Notes.tsx`). Through the reader's renderer, for its
   * reason — the phone is sent markup, not a parser — and found by the
   * card's id in the active profile, never handed the text: what is
   * rendered is what the card says. No root, as release notes have none, so
   * a relative image in a card is a fetch `files.ts` refuses rather than a
   * file read from wherever it pointed.
   */
  /**
   * The active profile's cards as the menu bar pops them out as notes —
   * what needs you, then the profile's board (`shared/notecards.ts`). A GET
   * for a caller with no socket, like `/api/kuru/play`; it says no more than
   * the snapshot every client is sent.
   */
  {
    path: "/api/notes/cards",
    handle: (req, res, url) => {
      const profile = workspaces.active;
      const mine = new Set(workspaces.agentsIn(profile.id));
      json(res, noteCards(profile, host.agents.filter((agent) => mine.has(agent.id)).map(overlay)));
      return;
    },
  },

  {
    path: "/api/card-markdown",
    handle: (req, res, url) => {
      const cardId = url.searchParams.get("card") ?? "";
      const profile = workspaces.active;
      const card =
        profile.board.cards.find((c) => c.id === cardId) ??
        profile.workspaces.flatMap((w) => w.board?.cards ?? []).find((c) => c.id === cardId);
      if (!card) {
        json(res, { error: "no such card" }, 404);
        return;
      }
      void renderMarkdown(card.body, "", "card.md").then(
        (rendered) => json(res, { html: rendered.html }),
        (err: unknown) => json(res, { error: err instanceof Error ? err.message : String(err) }, 400),
      );
      return;
    },
  },

  {
    path: "/api/file-raw",
    handle: (req, res, url) => {
      const root = url.searchParams.get("root") ?? "";
      const path = url.searchParams.get("path") ?? "";
      try {
        const file = readBytes(root, path);
        serveRaw(res, file.type, file.bytes);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    },
  },

  {
    path: "/api/dirs",
    handle: (req, res, url) => {
      try {
        json(res, { dirs: listDirs(url.searchParams.get("root") ?? "") });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    },
  },

  /**
   * The tree's edits — see `fileops.ts`, which is the only thing that decides
   * anything here. POST only: a GET that renames a file is one a prefetch, a
   * crawler or a pasted link can trigger, and the gate above is what stops a
   * page somewhere else from sending one of these at all.
   */
  {
    path: "/api/fs",
    method: "POST",
    handle: (req, res, url) => {
      void (async () => {
        let op;
        try {
          op = parseFileOp(await readJsonBody(req));
        } catch {
          op = null;
        }
        if (!op) return json(res, { error: "not a file operation" }, 400);
        const result = await runFileOp(op);
        if (result.ok) json(res, result);
        else json(res, { error: result.error }, 400);
      })();
      return;
    },
  },
];
