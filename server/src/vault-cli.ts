/**
 * `vault`: an agent's door into the vault on this Mac.
 *
 * An agent never holds a vault value, and so this process never holds one
 * either: `ask` opens the owner's dialog and waits for a word per field,
 * `list` prints names, and `run` sends the command to the server, which runs
 * it with the items in its environment and streams its output back masked.
 * A CLI that fetched a value and handed it to a command would make a fetch
 * the interface, and anything that can run this can run a fetch and print it.
 *
 * The one exception is `askpass`, which is not for agents: it is what
 * `SUDO_ASKPASS` points at during a `run --askpass`, and it prints the value
 * to sudo, which reads it, for a ticket only that run's environment holds.
 *
 * It knows which agent it is the way `slot` does — `KURURU_AGENT_ID` in the
 * pty's environment — and the server believes that only of an agent it has.
 *
 * Bundled to `dist/vault.mjs` and run as `~/.local/state/kururu/bin/vault`,
 * which the server writes on each start (`vaultbin.ts`); `bun run vault`
 * from the checkout runs this file. Plain `node:http`, as `slot` is, because
 * an ask is held open for up to fifteen minutes and `fetch` gives up at five.
 */
import { request } from "node:http";
import { tokenHeaders } from "../localtoken.mjs";

const NAME = "vault";
const port = Number(process.env.KURURU_PORT || 7717);
const agentId = process.env.KURURU_AGENT_ID || null;

const say = (line: string) => process.stderr.write(`${NAME}: ${line}\n`);
function die(line: string, code = 2): never {
  say(line);
  process.exit(code);
}

const HELP = `vault — keep secrets out of transcripts.

  vault ask --title TEXT [--reason TEXT] --field LABEL --name ITEM [--env FILE:VAR] [--use ask] [--field …]
      Open a dialog on the owner's screen (the Kururu window and the phone)
      with one masked field per --field. Each value is saved to the Mac's
      Keychain as the vault item --name, and with --env also written to that
      one variable of an env file under the home folder (backed up first,
      only that variable replaced, kept 0600). You are told, per field:
      saved, skipped, cancelled or failed — never the value. Waits for the
      owner, up to 15 minutes. Exit 0 when every field was saved.
      Names are lower-case, up to four /-separated parts:
      pylink/bancard-staging-private.

  vault ask --json -
      The same ask as JSON on stdin: {"title", "reason", "fields": [{"label",
      "name", "env": {"file", "variable"}, "use"}]}.

  vault run --secret ITEM=VAR [--secret …] [--askpass ITEM] -- COMMAND [ARGS…]
      Run one command with each item in its environment as VAR. The server
      runs it, in this folder with this environment, stdin closed; its
      output comes back with every value (and its base64 and URL-encoding)
      replaced by [vault:ITEM]. Exits with the command's code. An item set
      to ask makes this wait for the owner to allow it (exit 77 if they do
      not). --askpass gives ITEM to \`sudo -A\` instead of the environment:
      vault run --askpass deck/sudo -- sudo -A systemctl restart thing
      Every run is logged: who, which items, the command, where, when.

  vault list
      The vault's items: name, label, whether a use asks the owner first, the
      env files each was written to. Never a value.

Never print, echo or cat a secret, read it from the Keychain yourself, or
ask the owner to paste one into a chat: ask with \`vault ask\`, use it with
\`vault run\`. Exit codes: 0 done, 1 not everything was saved, 2 a usage
error or a refusal, 6 no kururu server, 77 not allowed; a run otherwise
exits with its command's code.
`;

function call(path: string, body: unknown | null): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const headers: Record<string, string | number> = { ...tokenHeaders() };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const req = request({ host: "127.0.0.1", port, path, method: payload === null ? "GET" : "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { error: text.trim() || `the server said ${res.statusCode}` } });
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

async function ask(path: string, body: unknown | null): Promise<Record<string, unknown>> {
  let answer;
  try {
    answer = await call(path, body);
  } catch (err) {
    die(`no kururu server answered on :${port} (${(err as Error).message}). If it restarted while the dialog was up, the dialog is gone and nothing was saved: ask again.`, 6);
  }
  if (answer.status >= 400) die(String(answer.body.error ?? `the server said ${answer.status}`));
  return answer.body;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

interface Field {
  label: string;
  name?: string;
  env?: { file: string; variable: string };
  use?: string;
}

/** `--field` starts a field and `--name`, `--env` and `--use` fill the last one, so each value can be quoted on its own. */
async function askCommand(args: string[]): Promise<void> {
  let title: string | undefined;
  let reason: string | undefined;
  const fields: Field[] = [];
  let json: Record<string, unknown> | null = null;
  const last = (flag: string): Field => {
    const f = fields[fields.length - 1];
    if (!f) die(`${flag} belongs to a --field; put --field LABEL first`);
    return f;
  };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = (): string => {
      const v = args[i + 1];
      if (v === undefined) die(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === "--title") title = value();
    else if (flag === "--reason") reason = value();
    else if (flag === "--field") fields.push({ label: value() });
    else if (flag === "--name") last(flag).name = value();
    else if (flag === "--use") last(flag).use = value();
    else if (flag === "--env") {
      const spec = value();
      const at = spec.lastIndexOf(":");
      if (at <= 0) die("--env is FILE:VARIABLE, such as ~/.config/pylink-local/env:BANCARD_PRIVATE_KEY");
      last(flag).env = { file: spec.slice(0, at), variable: spec.slice(at + 1) };
    } else if (flag === "--json") {
      const from = value();
      if (from !== "-") die("--json - reads the ask from stdin");
      try {
        json = JSON.parse(await readStdin()) as Record<string, unknown>;
      } catch {
        die("the JSON on stdin could not be read");
      }
    } else die(`unknown flag ${flag}; see vault --help`);
  }
  const body = json ?? { title, reason, fields };
  say("the dialog is on the owner's screen; waiting for them (up to 15 minutes)");
  const answer = await ask("/api/vault/ask", { ...body, agentId });
  process.stdout.write(`${String(answer.text ?? "")}\n`);
  const outcomes = Array.isArray(answer.outcomes) ? (answer.outcomes as { outcome?: string }[]) : [];
  process.exit(outcomes.length && outcomes.every((o) => o.outcome === "saved") ? 0 : 1);
}

/** `--secret ITEM=VAR` and `--askpass ITEM` up to `--`, the command after it. */
async function runCommand(args: string[]): Promise<void> {
  const secrets: { name: string; variable: string }[] = [];
  let askpass: string | null = null;
  let i = 0;
  for (; i < args.length; i += 1) {
    const flag = args[i]!;
    if (flag === "--") break;
    const value = args[i + 1];
    if (value === undefined) die(`${flag} needs a value`);
    i += 1;
    if (flag === "--secret") {
      const at = value.lastIndexOf("=");
      if (at <= 0) die("--secret is ITEM=VARIABLE, such as pylink/bancard-staging-private=BANCARD_PRIVATE_KEY");
      secrets.push({ name: value.slice(0, at), variable: value.slice(at + 1) });
    } else if (flag === "--askpass") askpass = value;
    else die(`unknown flag ${flag}; see vault --help`);
  }
  const argv = args.slice(i + 1);
  if (args[i] !== "--" || !argv.length) die("put the command after --: vault run --secret ITEM=VAR -- command args");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  const payload = JSON.stringify({ argv, cwd: process.cwd(), env, secrets, askpass, agentId });
  await new Promise<void>((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/vault/run", method: "POST", headers: { ...tokenHeaders(), "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            let why = Buffer.concat(chunks).toString("utf8");
            try {
              why = String((JSON.parse(why) as { error?: unknown }).error ?? why);
            } catch {
              // As it came.
            }
            die(why.trim() || `the server said ${res.statusCode}`);
          });
          return;
        }
        let buffered = "";
        let exited = false;
        const line = (text: string) => {
          if (!text) return;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return;
          }
          if (typeof ev.o === "string") process.stdout.write(Buffer.from(ev.o, "base64"));
          else if (typeof ev.e === "string") process.stderr.write(Buffer.from(ev.e, "base64"));
          else if (typeof ev.note === "string") say(ev.note);
          else if ("exit" in ev) {
            exited = true;
            const code = typeof ev.exit === "number" ? ev.exit : ev.signal ? 128 + 15 : 1;
            process.stdout.write("", () => process.exit(code));
          }
        };
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buffered += c;
          let nl = buffered.indexOf("\n");
          while (nl >= 0) {
            line(buffered.slice(0, nl));
            buffered = buffered.slice(nl + 1);
            nl = buffered.indexOf("\n");
          }
        });
        res.on("end", () => {
          line(buffered);
          if (!exited) die("the kururu server went away while the command ran; it was ended with it", 6);
          resolve();
        });
      },
    );
    req.on("error", (err) => die(`no kururu server answered on :${port} (${err.message})`, 6));
    // Ctrl-C here ends the command there: the server ends its process group when this hangs up.
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        req.destroy();
        process.exit(130);
      });
    }
    req.end(payload);
  });
}

/** sudo's askpass during a `run --askpass`: the value to sudo, for the run's ticket. Not for agents. */
async function askpassCommand(): Promise<void> {
  const ticket = process.env.KURURU_VAULT_TICKET;
  if (!ticket) die("askpass is for sudo during a vault run --askpass, not to be run by hand");
  const answer = await call("/api/vault/askpass", { ticket }).catch(() => null);
  const value = answer && answer.status === 200 ? answer.body.value : null;
  if (typeof value !== "string") die("the vault has no password for this run any more");
  process.stdout.write(`${value}\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "ask") return askCommand(rest);
  if (command === "run") return runCommand(rest);
  if (command === "askpass") return askpassCommand();
  if (command === "list") {
    const answer = await ask("/api/vault/list", null);
    process.stdout.write(`${String(answer.text ?? "")}\n`);
    return;
  }
  die(`unknown command ${command}; see vault --help`);
}

void main();
