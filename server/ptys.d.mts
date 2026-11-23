/** Types for `ptys.mjs`, so the host can import the copy `status.mjs` runs. */
export function countPtmx(lsofFields: string): number;
export function isPtmxLink(target: string): boolean;
export function ptysHeld(pid?: number): number | null;
export function ptyLimit(): number | null;
export function canOpenPty(): boolean;
export function leaking(held: number | null, live: number): boolean;
export function outOfTerminals(facts: { limit: number | null; held: number | null; live: number; mac: boolean }): string;
