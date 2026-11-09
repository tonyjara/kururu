/**
 * The mascots' sprite sheets, over HTTP: one sheet, the list of them, and a
 * sheet of the user's own coming in.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { defaultMascot } from "../../../shared/model";
import { mascots } from "../context";
import { builtinSheets, importedSheets, importSheet, removeSheet, sheetImage, sheetsDir } from "../mascot";
import { CONTENT_TYPES, IMPORT_LIMIT, json, readBody, text } from "./respond";
import type { Route } from "./router";

export const mascotRoutes: Route[] = [
  /**
   * One sprite sheet. `?sheet=` names it — Settings asks for each in turn to
   * draw its picker — and without one you get whichever is currently selected,
   * which is all a row drawing a badge ever needs to know.
   *
   * An endpoint rather than a static file because most sheets live outside the
   * app entirely, in the user's config directory, and because the name has to be
   * checked against the list rather than pasted into a path: this is reachable
   * from the tailnet. `no-cache` so a user who overwrites their own sheet sees
   * it after a reload rather than after a restart; the sheets that ship never
   * change, and they are fifteen kilobytes.
   */
  {
    path: "/api/mascot.png",
    handle: (req, res, url) => {
      const body = sheetImage(url.searchParams.get("sheet") ?? defaultMascot(mascots).sheet);
      if (!body) {
        text(res, "no such sheet\n", 404);
        return;
      }
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[".png"]!,
        "content-length": body.length,
        "cache-control": "no-cache",
      });
      res.end(body);
      return;
    },
  },

  /**
   * What Settings may offer. Not in the snapshot: it is a catalogue, wanted once
   * by one dialog, and putting it on every status change would be paying for it
   * continuously to save one request nobody makes twice.
   *
   * The two lists are kept apart because they are not the same kind of thing to
   * the UI: one of them has a remove button. `dir` is there so the dialog can
   * tell you where they went without spelling the path a second time.
   *
   * DELETE removes one of yours. It is the same shape as the import below — a
   * name, checked against the list of imported sheets and nothing else.
   */
  {
    path: "/api/mascot/sheets",
    handle: (req, res, url) => {
      if (req.method === "DELETE") {
        const name = url.searchParams.get("name") ?? "";
        if (!removeSheet(name)) {
          json(res, { error: "no such imported sheet" }, 404);
          return;
        }
        json(res, { ok: true, builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
        return;
      }
      json(res, { builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
      return;
    },
  },

  /**
   * A sheet somebody picked in a file dialog, on its way to `~/.config/kururu/sheets`.
   *
   * The body is the file, not JSON and not a form: it is one PNG going to one
   * place, and multipart would be a parser to maintain for a boundary nobody
   * needs. The name travels in the query so the bytes can stay the bytes.
   *
   * Every check is in `importSheet` rather than here, because this is the one
   * endpoint that writes a file to the user's config directory on behalf of a
   * client, and the checks belong beside the write rather than beside the route.
   */
  {
    path: "/api/mascot/import",
    handle: async (req, res, url) => {
      if (req.method !== "POST") {
        text(res, "POST only", 405);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(req, IMPORT_LIMIT);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : "could not read that file" }, 413);
        return;
      }
      const result = importSheet(url.searchParams.get("name") ?? "", bytes);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      json(res, { name: result.name, builtin: builtinSheets(), imported: importedSheets(), dir: sheetsDir() });
      return;
    },
  },
];
