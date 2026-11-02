/**
 * Answering an HTTP request: JSON, text, raw bytes, a file of the built web
 * app, and reading a body with a cap — the helpers every route file shares,
 * so that a limit or a content type is decided once.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { WEB_DIST } from "../preamble";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // A manifest served as anything else is a manifest Chrome refuses to parse,
  // and the symptom is the home-screen icon quietly going back to a screenshot.
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // What a `sound` style may ship — `SOUND_FORMATS`, and nothing wider. These
  // reach a browser through `/api/styles/asset` and `/api/styles/preview`,
  // which serve whatever an entry recorded; a type guessed as
  // `application/octet-stream` is one Safari will not decode.
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

export function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

export function text(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

/**
 * A little over the sheet cap, so a file that is too big is refused by the thing
 * that can say *why* rather than by the socket closing mid-upload.
 */
export const IMPORT_LIMIT = 2 * 1024 * 1024;

/** The body, as bytes. What `readJsonBody` is built on, minus the parse. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("that file is far too big"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** A clip past `CLIP_MAX_BYTES`, told apart so it can be answered as one. */
export class ClipTooLong extends Error {}

/**
 * A clip's body, read to its end even when it is past the cap, so the
 * answer reaches a window still uploading. `readBody` destroys the request
 * instead, which is right for a file nobody will look at the answer to, and
 * was wrong here: a window told nothing but "connection reset" has nothing to
 * tell the person who just spoke for two minutes.
 */
export function readClip(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) reject(new ClipTooLong(`the clip is ${Math.round(size / 32_000)} s, past the ${Math.round(limit / 32_000)} s the server takes`));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Read a JSON request body, with a cap — this endpoint is tailnet-reachable. */
export function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function serveStatic(res: ServerResponse, rel: string): void {
  const file = join(WEB_DIST, rel);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // Unknown paths fall through to index.html so the client router owns them.
    const index = join(WEB_DIST, "index.html");
    if (!existsSync(index)) {
      text(res, "kururu: web app not built. Run `bun run build`.", 404);
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPES[".html"]! });
    createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}


/** A file's bytes, as `/api/file-raw` serves them, from this disk or a node's. */
export function serveRaw(res: ServerResponse, type: string, bytes: Uint8Array): void {
  res.writeHead(200, {
    "content-type": type,
    "content-length": bytes.length,
    // An SVG is a document, and a browser pointed straight at this URL would
    // treat it as one. In an `<img>` — the only way the reader asks for it —
    // none of that runs; these say so for the case somebody opens the link.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": "no-cache",
  });
  res.end(bytes);
}

/** A media type as a node said it, or the one that makes a browser do nothing clever with it. */
export const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+(; ?charset=[a-z0-9-]+)?$/i;
