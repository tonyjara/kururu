/**
 * Running `git`, for the two files allowed to.
 *
 * `worktree.ts` runs it on the user's repositories — a card's checkout, made
 * and retired on a click — and `backup.ts` runs it on one repository kururu
 * owns, the mirror of what is precious. They share the one way of running
 * it so there is one timeout, one answer to "what did git say", and one
 * place that makes sure no git ever sits waiting for a password nobody is
 * there to type: `GIT_TERMINAL_PROMPT=0`, and for the backup's pushes, ssh
 * in batch mode too. What each may *do* with git is their own header's rule,
 * and neither forces anything.
 */
import { execFile } from "node:child_process";

/**
 * A checkout of a large repository is seconds; thirty is a git that is hanging
 * on a prompt or a lock, and the caller should say so rather than spin. A
 * push over a slow link is the one thing that may take longer, and asks.
 */
export const GIT_TIMEOUT_MS = 30_000;

export interface GitOptions {
  timeout?: number;
  /** `BatchMode=yes` for ssh, so a host that wants a passphrase or a confirmation fails at once rather than at the timeout. */
  batch?: boolean;
  /** Extra environment, over the server's own. */
  env?: Record<string, string>;
}

function envFor(options: GitOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...(options.batch ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" } : {}),
    ...options.env,
  };
}

/**
 * Run git and get stdout, or the first line of what it said on stderr as the
 * error.
 */
export function git(args: string[], cwd: string, options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: options.timeout ?? GIT_TIMEOUT_MS, env: envFor(options), maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const said = String(stderr).split("\n").find((line) => line.trim()) ?? err.message;
        reject(new Error(`git: ${said.replace(/^fatal:\s*/, "")}`));
      },
    );
  });
}

/**
 * Run git for its exit status, when the status is the answer: `merge-tree`
 * says "clean" with 0, "conflicts" with 1 and anything else for a question it
 * could not take, and `git()` above folds the last two into one rejection.
 */
export function gitStatus(args: string[], cwd: string, options: GitOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: options.timeout ?? GIT_TIMEOUT_MS, env: envFor(options), maxBuffer: 1 << 20 }, (err) =>
      resolve(err ? (typeof err.code === "number" ? err.code : -1) : 0),
    );
  });
}
