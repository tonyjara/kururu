/**
 * Kuru's conversation over HTTP: search, the history and the lines around a hit, a reply played again, and a file dropped on its box.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { DROP_MAX_BYTES } from "../../../shared/drops";
import { KURU_PAGE } from "../../../shared/kuru";
import { isSearchScope } from "../../../shared/store";
import { kuru, voice, workspaces } from "../context";
import { searchFor } from "../conversation";
import { DropRefused, keepDrop } from "../drops";
import { json, readBody, text } from "./respond";
import type { Route } from "./router";

export const kuruRoutes: Route[] = [
  /**
   * Full text over the cards and the conversations — `shared/store.ts`. A
   * GET with the words, answered with hits that carry this session's ids
   * beside the keys, so the window can go to a card.
   */
  {
    path: "/api/search",
    handle: (req, res, url) => {
      const q = url.searchParams.get("q") ?? "";
      const scope = url.searchParams.get("scope");
      const asked = url.searchParams.get("profile");
      const limit = Number(url.searchParams.get("limit") ?? 20);
      json(res, {
        hits: searchFor(asked && workspaces.profile(asked) ? asked : workspaces.active.id, q, isSearchScope(scope) ? scope : "all", Number.isFinite(limit) ? limit : 20),
      });
      return;
    },
  },

  /**
   * The conversation with Kuru before a moment, for the drawer's "Show
   * earlier": the socket carries the newest items and this pages back
   * through the rest. A GET, since it changes nothing. And one verb for a
   * caller with no socket — the menu bar — to play the unheard replies.
   */
  {
    path: "/api/kuru",
    handle: (req, res, url) => {
      const asked = url.searchParams.get("profile");
      const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
      const before = Number(url.searchParams.get("before"));
      const limit = Number(url.searchParams.get("limit") ?? KURU_PAGE);
      json(res, kuru.page(workspaces.keyOf(profileId) ?? "", Number.isFinite(before) && before > 0 ? before : null, Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : KURU_PAGE));
      return;
    },
  },

  /**
   * The drawer's search, as it is typed: a GET like the page above, with the
   * words in the query and never anywhere else — no model hears them, and no
   * log is written of them. A window that has moved on closes the request, and
   * that ends the scan.
   */
  {
    path: "/api/kuru/search",
    handle: (req, res, url) => {
      const asked = url.searchParams.get("profile");
      const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
      let gone = false;
      res.on("close", () => {
        gone = true;
      });
      void kuru
        .search(workspaces.keyOf(profileId) ?? "", url.searchParams.get("q") ?? "", () => gone)
        .then((answer) => {
          if (!gone) json(res, answer);
        })
        .catch((err: unknown) => {
          if (!gone) json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
        });
      return;
    },
  },

  /** The lines around a moment, for a result older than the drawer has loaded; `before=0` reads on from it. */
  {
    path: "/api/kuru/around",
    handle: (req, res, url) => {
      const asked = url.searchParams.get("profile");
      const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
      const at = Number(url.searchParams.get("at"));
      if (!Number.isFinite(at)) {
        json(res, { error: "at must be a time" }, 400);
        return;
      }
      const count = (name: string): number => {
        const asked = Number(url.searchParams.get(name) ?? KURU_PAGE);
        return Number.isFinite(asked) ? Math.max(0, Math.min(200, Math.floor(asked))) : KURU_PAGE;
      };
      json(res, kuru.around(workspaces.keyOf(profileId) ?? "", at, count("before"), count("after")));
      return;
    },
  },

  {
    path: "/api/kuru/play",
    method: "POST",
    handle: (req, res, url) => {
      const asked = url.searchParams.get("profile");
      const profileId = asked && workspaces.profile(asked) ? asked : workspaces.active.id;
      json(res, { ok: true, played: voice.replay(workspaces.keyOf(profileId) ?? "").length });
      return;
    },
  },

  /**
   * A file for Kuru's box that the page cannot name by its path — a picture
   * off the clipboard, a phone's photo — kept in `drops/` and answered with
   * the path of the copy. `?name=` is what the page called it, which is only
   * ever a hint for the copy's name: the bytes decide what it is (see
   * `shared/drops.ts`). The page checks the size before it sends; the
   * declared length is checked here so a body past the cap is answered
   * rather than read, and `readBody` is the backstop for one that lied.
   */
  {
    path: "/api/drop",
    handle: async (req, res, url) => {
      if (req.method !== "POST") {
        text(res, "POST only", 405);
        return;
      }
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > DROP_MAX_BYTES) {
        json(res, { error: `that file is over ${DROP_MAX_BYTES / 1024 / 1024} MB` }, 413);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readBody(req, DROP_MAX_BYTES);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 413);
        return;
      }
      try {
        json(res, keepDrop(bytes, (url.searchParams.get("name") ?? "").slice(0, 255)));
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, err instanceof DropRefused ? 415 : 500);
      }
      return;
    },
  },
];
