/** The types of `sockowner.mjs`, for the server, which bundles the same file. */
export interface UnixSocket {
  path: string;
  pids: number[];
}
export function parseSsUnix(out: string): UnixSocket[];
export function parseSsTcp(out: string): Map<number, number[]>;
export function parseLsofUnix(out: string): UnixSocket[];
export function socketHolders(path: string): number[] | null;
export function socketsNamed(name: string): { pid: number; path: string }[];
