/**
 * How kururu looks, over HTTP: the registry's catalog, assets and previews, installing, wearing and removing a style, the mascots' sheets, and the skin studio.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { defaultMascot } from "../../../shared/model";
import { isStyleId } from "../../../shared/skin";
import { isStyleKind } from "../../../shared/styles";
import { appearance, mascots, provide, pushSnapshot, styles } from "../context";
import { installOne, saveAppearance, wear } from "../look";
import { builtinSheets, importedSheets, importSheet, removeSheet, sheetImage, sheetsDir } from "../mascot";
import { createLocalSkin, localDir, putLocalAsset, readLocalManifest, removeLocalAsset, writeLocalManifest } from "../studio";
import {
  annotate as annotateCatalog,
  assetFile,
  catalog,
  preview as previewStyle,
  readLibrary,
  remove as removeStyle,
  stylesHome,
} from "../styles";
import { CONTENT_TYPES, IMPORT_LIMIT, json, readBody, readJsonBody, text } from "./respond";
import type { Route } from "./router";

export const styleRoutes: Route[] = [
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

  // --- the styles registry -------------------------------------------------
  /**
   * What `../kururu-styles` is offering, and what this machine already has of it.
   *
   * A fetch rather than a snapshot field, and the split is the one the update
   * check draws: the snapshot carries what *kururu* owns, and this is the
   * world's. It changes when somebody merges a pull request in another
   * repository, answering it means a request over the network, and nothing in
   * the window can be drawn without it except the one tab that is asking. The
   * installed half *is* in the snapshot, because a theme you are wearing is not
   * a catalogue.
   *
   * `?refresh=1` is the *Check for updates* button, and it is the only thing
   * that bypasses the ten-minute cache — which is what makes that button a
   * button rather than decoration.
   */
  {
    path: "/api/styles/catalog",
    handle: async (req, res, url) => {
      const { index, stale, error } = await catalog(url.searchParams.get("refresh") === "1");
      json(res, {
        entries: index ? annotateCatalog(index, styles.installed) : [],
        stale,
        ...(error ? { error } : {}),
        home: stylesHome(),
      });
      return;
    },
  },

  /**
   * One file out of an installed style — a font, a stylesheet, a texture.
   *
   * An endpoint rather than static serving for `sheetFile`'s reason and one
   * more. The reason: the name is checked against what the entry actually
   * recorded rather than pasted into a path, and this is reachable from the
   * tailnet. The one more: everything a style brings is served from *kururu's
   * own origin*, which is the entire point of installing rather than linking —
   * a window that fetched a font from somebody else's host would tell that host
   * when its owner was working.
   *
   * Cached hard, because the URL names an entry whose contents cannot change
   * without a version bump and a reinstall.
   */
  {
    path: "/api/styles/asset",
    handle: (req, res, url) => {
      const path = assetFile(
        url.searchParams.get("kind") ?? "",
        url.searchParams.get("id") ?? "",
        url.searchParams.get("file") ?? "",
      );
      if (!path) {
        text(res, "no such asset\n", 404);
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(path);
      } catch {
        text(res, "no such asset\n", 404);
        return;
      }
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(body);
      return;
    },
  },

  /**
   * The picture for a mascot, or the noise for a sound, that nobody has
   * installed yet — proxied from the registry. See `preview` in
   * `server/src/styles.ts` for why this exists at all and why the browser is not
   * the thing fetching it.
   */
  {
    path: "/api/styles/preview",
    handle: async (req, res, url) => {
      const shot = await previewStyle(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "", url.searchParams.get("file"));
      if (!shot) {
        text(res, "no preview\n", 404);
        return;
      }
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(shot.file).toLowerCase()] ?? "application/octet-stream",
        "content-length": shot.bytes.length,
        // Not `immutable`: the URL names an entry rather than a version, so it is
        // the one asset URL in kururu whose contents can change under it — a
        // registry entry updated upstream is exactly that. An hour is long enough
        // that scrolling the list twice is one request.
        "cache-control": "public, max-age=3600",
      });
      res.end(shot.bytes);
      return;
    },
  },

  /**
   * Install one, and — if that is what the gesture was — wear it.
   *
   * `activate` is a parameter rather than something this decides, because the
   * two callers mean different things by the same download. Picking a theme in
   * the Styles tab is "I want this one", and an install that did not put it on
   * would make choosing a two-step gesture for no reason. Pressing *Update* on a
   * style you are not currently wearing is not a request to start wearing it,
   * and one that switched the window out from under you would be the kind of
   * surprise nobody forgives.
   */
  {
    path: "/api/styles/install",
    method: "POST",
    handle: async (req, res, url) => {
      const kind = url.searchParams.get("kind") ?? "";
      const id = url.searchParams.get("id") ?? "";
      const activate = url.searchParams.get("activate") === "1";
      const result = await installOne(kind, id, activate);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      json(res, { ok: true, installed: styles.installed });
      return;
    },
  },

  /**
   * Wear one that is already here. No network, no download, no version.
   *
   * A separate verb from `install` rather than `install?activate=1` on a style
   * that is already on disk, and the difference is the network: this has to work
   * on a plane. Installing checks the registry for the entry, which is right for
   * a download and absurd for "put the pack I have back on" — and it is the
   * gesture somebody makes most, because a pack is five decisions and changing
   * one of them by hand is how you end up wanting the other four back.
   */
  {
    path: "/api/styles/wear",
    method: "POST",
    handle: (req, res, url) => {
      const kind = url.searchParams.get("kind") ?? "";
      const id = url.searchParams.get("id") ?? "";
      if (!isStyleKind(kind) || !isStyleId(id)) {
        json(res, { error: "that is not a style" }, 400);
        return;
      }
      const result = wear(kind, id);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      json(res, { ok: true, installed: styles.installed });
      return;
    },
  },

  {
    path: "/api/styles/remove",
    method: "POST",
    handle: (req, res, url) => {
      const result = removeStyle(url.searchParams.get("kind") ?? "", url.searchParams.get("id") ?? "");
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      /**
       * Nothing here un-picks anything, and that is the point of the design rather
       * than an omission. `appearance.json` keeps the id of a theme you removed,
       * `themeFor` falls back to the default while it is gone, and reinstalling it
       * puts you back where you were — which is only possible because
       * `adoptAppearance` stopped rewriting ids it could not resolve.
       */
      provide("styles", readLibrary());
      pushSnapshot();
      json(res, { ok: true, installed: styles.installed });
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

  // --- the skin studio ------------------------------------------------------
  /**
   * A skin of yours, being made. See `server/src/studio.ts` for what one is —
   * an ordinary installed skin with `local` on its record — and why that is the
   * whole design. What is here is the four verbs and one rule they share: every
   * one of them ends in `styles = readLibrary()` and a snapshot, because the
   * point of the studio is that the window you are looking at *is* the preview,
   * and so is the phone's.
   *
   * Wearing follows editing. Creating a skin puts it on, and so does the first
   * edit to one you are not wearing, on the reasoning the Styles tab gives for
   * picking being installing: nobody opens a skin to edit it and then wonders
   * whether to look at it. It is the studio's one act of switching, and it is
   * the reason the response is the manifest rather than a bare `ok` — the
   * page needs the file names back to draw its thumbnails from.
   */
  {
    path: "/api/studio/skin",
    handle: async (req, res, url) => {
      const id = url.searchParams.get("id") ?? "";
      if (req.method === "GET") {
        const manifest = readLocalManifest(id);
        if (!manifest) {
          json(res, { error: "that is not a skin of yours" }, 404);
          return;
        }
        const record = styles.installed.find((r) => r.kind === "skin" && r.id === id && r.local);
        json(res, { manifest, files: record?.files ?? [], dir: localDir(id) });
        return;
      }
      if (req.method === "POST") {
        const result = createLocalSkin(id, url.searchParams.get("name") ?? "", url.searchParams.get("from"), styles);
        if (!result.ok) {
          json(res, { error: result.error }, 400);
          return;
        }
        provide("styles", readLibrary());
        saveAppearance({ ...appearance, skinId: id });
        json(res, { ok: true, manifest: result.manifest, files: styles.installed.find((r) => r.kind === "skin" && r.id === id)?.files ?? [], dir: localDir(id) });
        return;
      }
      if (req.method === "PUT") {
        let body: unknown;
        try {
          body = await readJsonBody(req, 256 * 1024);
        } catch {
          json(res, { error: "that manifest could not be read" }, 400);
          return;
        }
        const result = writeLocalManifest(id, body);
        if (!result.ok) {
          json(res, { error: result.error }, 400);
          return;
        }
        provide("styles", readLibrary());
        if (appearance.skinId !== id) saveAppearance({ ...appearance, skinId: id });
        else pushSnapshot();
        json(res, { ok: true, manifest: result.manifest });
        return;
      }
      text(res, "GET, POST or PUT", 405);
      return;
    },
  },

  /**
   * A picture or a font, into a skin of yours. The body is the file, on the
   * mascot import's reasoning — one file to one place, and the name in the
   * query so the bytes can stay the bytes. Every check is in `putLocalAsset`,
   * beside the write.
   */
  {
    path: "/api/studio/asset",
    handle: async (req, res, url) => {
      const id = url.searchParams.get("id") ?? "";
      const file = url.searchParams.get("file") ?? "";
      if (req.method === "DELETE") {
        const result = removeLocalAsset(id, file);
        if (!result.ok) {
          json(res, { error: result.error }, 400);
          return;
        }
        provide("styles", readLibrary());
        pushSnapshot();
        json(res, { ok: true, files: result.files });
        return;
      }
      if (req.method !== "POST") {
        text(res, "POST or DELETE", 405);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(req, IMPORT_LIMIT);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : "could not read that file" }, 413);
        return;
      }
      const result = putLocalAsset(id, file, bytes);
      if (!result.ok) {
        json(res, { error: result.error }, 400);
        return;
      }
      provide("styles", readLibrary());
      pushSnapshot();
      json(res, { ok: true, file: result.file, files: result.files, width: result.width, height: result.height, stamp: Date.now() });
      return;
    },
  },

  /**
   * Show the skin's directory in the file manager — of the machine the server
   * is on, which is the only machine that has it. From the phone this opens a
   * Finder window on the desktop, which is odd and correct: the files are
   * there, and "where did my skin go" has one answer. The path is the server's
   * own, built from an id it checked; nothing from the client reaches the
   * command line.
   */
  {
    path: "/api/studio/reveal",
    method: "POST",
    handle: (req, res, url) => {
      const id = url.searchParams.get("id") ?? "";
      if (!readLocalManifest(id)) {
        json(res, { error: "that is not a skin of yours" }, 404);
        return;
      }
      const dir = localDir(id);
      const [cmd, args] = process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
      execFile(cmd, args, () => {
        // A machine with no file manager is a machine where the path in the
        // dialog is the answer, and it is already on screen.
      });
      json(res, { ok: true, dir });
      return;
    },
  },
];
