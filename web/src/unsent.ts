/**
 * Clips the server has not taken yet, kept in the browser until it has.
 *
 * Why a clip needs keeping on this side at all, when the server writes every
 * clip to its disk the moment it arrives: because "arrives" is the part that
 * fails. The server restarts on every save under `bun run dev`, a runner that
 * crashes stays down until somebody notices, and a phone loses the tailnet in
 * a lift. The page holds the clip and sends it again until the server answers
 * that it has it — and the page itself is reloaded by ⌘R, by the reconnect
 * screen, by a phone that put the tab to sleep, any of which used to take a
 * clip still in memory with it. So the clip is written here first, before the
 * upload, and taken out only on the server's word.
 *
 * IndexedDB rather than `localStorage`, which holds strings of a few
 * megabytes and a five-minute clip is ten. Every call is allowed to fail — a
 * private window, storage switched off, a quota — and failing costs only the
 * reload case: the clip is still in memory and still sent.
 */

/** A clip as it is kept: what the upload needs, and nothing the page derives. */
export interface StoredClip {
  id: string;
  profileId: string;
  at: number;
  ms: number;
  wav: ArrayBuffer;
}

const DB = "kururu-voice";
const STORE = "unsent";

let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** One transaction, answered with its request's result, or null for any way it can fail. */
async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const handle = await db();
  if (!handle) return null;
  return new Promise((resolve) => {
    try {
      const req = act(handle.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function keepClip(clip: StoredClip): Promise<void> {
  await run("readwrite", (store) => store.put(clip));
}

export async function dropClip(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
}

/** Every clip still waiting, oldest first. */
export async function keptClips(): Promise<StoredClip[]> {
  const all = (await run("readonly", (store) => store.getAll() as IDBRequest<StoredClip[]>)) ?? [];
  return all
    .filter((c) => c && typeof c.id === "string" && typeof c.profileId === "string" && c.wav instanceof ArrayBuffer)
    .sort((a, b) => a.at - b.at);
}
