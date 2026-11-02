/**
 * The voice's bytes: the sounds, a recording heard, a reply's speech and a notification's sound.
 *
 * One table of routes of a fixed path, cut out of the `if` chain that was
 * `index.ts`'s; `router.ts` puts the tables together and decides what comes
 * before them. Each handler is the body of the `if` it was.
 */
import { randomUUID } from "node:crypto";
import { CLIP_MAX_BYTES, isClipId } from "../../../shared/voice";
import { outbox, voice, workspaces } from "../context";
import { legacyHeard } from "../outbox";
import { soundBytes, sounds } from "../sounds";
import { ClipTooLong, json, readClip, text } from "./respond";
import type { Route } from "./router";

export const voiceRoutes: Route[] = [
  /**
   * What there is to be notified *by*: kururu's own sounds and the machine's.
   *
   * A fetch rather than a snapshot field, on `/api/styles`' split — the snapshot
   * carries what somebody *chose*, and this is what there is to choose from. It
   * is a directory listing of somebody else's files, it changes when they drop a
   * file into `~/Library/Sounds` rather than when kururu does anything, and the
   * only thing in the window that cannot be drawn without it is the one tab
   * asking.
   */
  {
    path: "/api/sounds",
    handle: (req, res, url) => {
      json(res, { sounds: sounds() });
      return;
    },
  },

  /**
   * One sound, in something the browser can actually play.
   *
   * The transcode is `sounds.ts`' business and the reason it exists; what
   * belongs here is the caching, and it is a year because a *sound* is
   * immutable in the way a style asset is: the id names a file on this machine
   * and the phone should fetch each one once, ever. The case that breaks that —
   * somebody replacing `~/Library/Sounds/Frog.wav` — is rare enough and
   * self-inflicted enough that a reload is the right cost, where re-fetching
   * every notification sound on every page load is not.
   */
  /**
   * The voice's two doors. A clip in: a WAV the window recorded, for the
   * profile it names, under the id the window minted for it, answered the
   * moment it is on the disk with the outbox's record of it — see
   * `outbox.ts` for the rest of its way to Kuru. A sentence out: one chunk
   * of an utterance the socket announced, which every client of the profile
   * fetches once. Not cached, since an utterance id is never reused and a
   * reply is nobody's to keep.
   *
   * A clip past the cap is answered with 413 and why, after the body has
   * been read to its end. It used to be refused by destroying the request,
   * which the window saw as a dropped connection and nothing else.
   */
  {
    path: "/api/voice/hear",
    handle: async (req, res, url) => {
      if (req.method !== "POST") {
        text(res, "POST only", 405);
        return;
      }
      const asked = url.searchParams.get("profile") ?? "";
      const profileId = workspaces.profile(asked) ? asked : workspaces.active.id;
      const given = url.searchParams.get("id");
      // A page from before the outbox sends no id, and its clip is still a message.
      const id = isClipId(given) ? given : randomUUID();
      const said = Number(url.searchParams.get("at"));
      const at = Number.isFinite(said) && said > 0 ? said : Date.now();
      let wav: Buffer;
      try {
        wav = await readClip(req, CLIP_MAX_BYTES);
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, err instanceof ClipTooLong ? 413 : 400);
        return;
      }
      try {
        const entry = outbox.take(workspaces.keyOf(profileId)!, id, at, wav);
        // A page from before the outbox holds the upload open for the words
        // and reads them in the old shape; it gets both, once they are made.
        if (isClipId(given)) json(res, { entry });
        else json(res, { entry, ...legacyHeard(entry ? await outbox.firstPass(entry.id) : null) });
      } catch (err) {
        // Not on the disk is not taken: the window keeps it and sends again.
        json(res, { error: `the clip could not be kept: ${err instanceof Error ? err.message : String(err)}` }, 500);
      }
      return;
    },
  },

  {
    path: "/api/speech",
    handle: (req, res, url) => {
      const seq = Number(url.searchParams.get("seq") ?? "0");
      const bytes = Number.isFinite(seq) && seq >= 0 ? voice.chunk(url.searchParams.get("u") ?? "", Math.floor(seq)) : null;
      if (!bytes) {
        text(res, "no such sentence\n", 404);
        return;
      }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": bytes.length, "cache-control": "no-store" });
      res.end(bytes);
      return;
    },
  },

  {
    path: "/api/sound",
    handle: async (req, res, url) => {
      const sound = await soundBytes(url.searchParams.get("id") ?? "");
      if (!sound) {
        text(res, "no such sound\n", 404);
        return;
      }
      res.writeHead(200, {
        "content-type": sound.type,
        "content-length": sound.bytes.length,
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(sound.bytes);
      return;
    },
  },
];
