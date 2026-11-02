/**
 * What the JavaScript half leans on that the libraries' types leave out.
 *
 * Both Node and the DOM clear a `null` timer as a no-op, and these files keep
 * an unarmed timer as `null` throughout; the declared signatures take only
 * `undefined`. Adding the overload is truer than rewriting every
 * `clearTimeout(this.timer)` as `clearTimeout(this.timer ?? undefined)`.
 * Only `tsconfig.js.json` includes this — the TypeScript half never sees it.
 */
declare function clearTimeout(id: NodeJS.Timeout | string | number | null | undefined): void;
declare function clearInterval(id: NodeJS.Timeout | string | number | null | undefined): void;
