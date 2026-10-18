/** The types of `localtoken.mjs`, for the CLIs written in TypeScript. */
export function localToken(env?: NodeJS.ProcessEnv): string | null;
export function tokenHeaders(env?: NodeJS.ProcessEnv): { authorization?: string };
