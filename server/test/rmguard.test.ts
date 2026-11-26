import { describe, expect, test } from "bun:test";
import { commandOfPayload, guardRefusal, systemPath } from "../../shared/rmguard";
import { guardCommandText } from "../src/guardbin";
import { codexGuardFlag, hookSettings } from "../src/hooks";

/** The agent's environment, as the hook would see it. */
const ENV = { HOME: "/Users/owner", TMPDIR: "/var/folders/xy/T/" };

const BLOCK: string[] = [
  // The 2026-11-26 line, as it was run.
  `ssh root@vps 'cd /opt/app && docker compose down; rm -rf /dev/null 2>/dev/null; echo done'`,
  `rm -rf /`,
  `rm -rf "$X"/`,
  `rm -rf $X/*`,
  `rm -rf /*`,
  `rm -rf /dev/null`,
  `rm -fr -- /etc`,
  `sudo rm -rf /usr/local/lib`,
  `/bin/rm -rf /var/lib/docker`,
  `\\rm -rf /boot`,
  `ssh -p 2222 -i ~/.ssh/k root@host "rm -rf /dev/null"`,
  `ssh host sudo rm -rf /etc/nginx`,
  `ssh host <<'EOF'\ncd /srv\nrm -rf /dev/null\nEOF`,
  `bash -c 'rm -rf /dev/null'`,
  `sh -lc "rm -rf /usr"`,
  `docker exec -it web sh -c 'rm -rf /dev/null'`,
  `docker exec web rm -rf /etc/passwd`,
  `docker compose exec -T db bash -c "rm -f /dev/null"`,
  `kubectl exec pod-1 -- rm -rf /dev/null`,
  `echo $(rm -rf /dev/null)`,
  "x=`rm -rf /etc`",
  `eval "rm -rf /etc"`,
  `D=/etc; rm -rf "$D"`,
  `for d in /tmp/a /usr; do rm -rf "$d"; done`,
  `find / -name '*.log' -delete`,
  `find /etc -exec rm -f {} \\;`,
  `echo hi > /etc/hosts`,
  `cat x >> /etc/profile`,
  `: > /dev/sda`,
  `dd if=/dev/zero of=/dev/disk2 bs=1m`,
  `mkfs.ext4 /dev/sdb1`,
  `truncate -s 0 /var/log/syslog`,
  `chmod -R 777 /usr/local`,
  `chown -R me /opt/homebrew`,
  `mv /etc/hosts /tmp/hosts`,
  `cp evil /usr/bin/ls`,
  `tee /etc/sudoers.d/x < f`,
  `rm -rf ~`,
  `rm -rf ~/`,
  `rm -rf /Users/owner`,
  `rm -rf /home/*`,
  `rsync -a --delete empty/ /etc/`,
  `nohup sudo -u root bash -c 'rm -rf /lib/x' &`,
  `xargs rm -rf /System/x < list`,
  `rm -rf /Applications/Slack.app`,
];

const PASS: string[] = [
  `rm -rf /tmp/kururu-guard-test`,
  `rm -rf "$TMPDIR"/kururu-*`,
  `rm -rf "$TMPDIR/scratch"`,
  `rm -rf /private/tmp/claude-501/scratchpad/x`,
  `rm -rf /var/folders/xy/T/x /var/tmp/y`,
  `rm -rf node_modules dist .turbo`,
  `rm -rf ./build ../kururu.worktrees/rm-guard`,
  `rm -rf /Users/owner/Desktop/Nyto/kururu.worktrees/rm-guard`,
  `rm -rf ~/.cache/kururu/voicelab/x`,
  `rm -rf "\${X:?}/"`,
  `ls 2>/dev/null`,
  `cat file >/dev/null 2>&1`,
  `bun test &> /dev/null`,
  `ssh root@vps 'docker ps 2>/dev/null; ls /dev/null'`,
  `git rm -r --cached /etc-looking-but-git`,
  `git rm -rf src/old`,
  `echo "rm -rf /"`,
  `grep -rn "rm -rf /dev/null" docs`,
  `git commit -m "guard: refuse rm -rf /etc"`,
  `cat <<'EOF' > /tmp/x.sh\nrm -rf /etc\nEOF`,
  `find . -name '*.orig' -delete`,
  `find /tmp/x -type f -exec rm {} +`,
  `find /usr/local -name foo`,
  `cp /etc/hosts /tmp/hosts`,
  `chmod +x /tmp/run.sh`,
  `chmod -R u+w ./dist`,
  `dd if=/dev/urandom of=/tmp/blob bs=1k count=1`,
  `mv /Applications/Kururu.app.new /Applications/Kururu.app`,
  `rm -rf /Applications/Kururu.app.new`,
  `docker exec web ls /etc`,
  `ssh host 'rm -rf /srv-backups-old'`,
  `ssh host 'rm -rf $HOME/tmp/x'`,
  `rsync -a --delete dist/ host:/srv/app/`,
  `echo $((1 + 2)) > /tmp/n`,
  `bun run build 2>&1 | tail -5`,
];

describe("guardRefusal", () => {
  for (const command of BLOCK) {
    test(`blocks: ${command}`, () => {
      expect(guardRefusal(command, ENV)).toBeString();
    });
  }
  for (const command of PASS) {
    test(`passes: ${command}`, () => {
      expect(guardRefusal(command, ENV)).toBeNull();
    });
  }

  test("the refusal says what to do instead", () => {
    expect(guardRefusal("rm -rf /dev/null", ENV)).toContain("literal paths inside your own scratch folder or worktree");
  });
});

describe("systemPath", () => {
  test("judges a glob by its folder", () => {
    expect(systemPath("/us*")).toBe("/");
    expect(systemPath("/tmp/x/*")).toBeNull();
    expect(systemPath("/etc/*.conf")).toBe("/etc");
  });
  test("normalizes before judging", () => {
    expect(systemPath("/tmp/../etc")).toBe("/etc");
    expect(systemPath("//dev//null")).toBe("/dev/null");
  });
  test("a home and the folder of homes, but not what is inside a home", () => {
    expect(systemPath("/home")).toBe("/home");
    expect(systemPath("/home/deploy")).toBe("/home/deploy");
    expect(systemPath("/home/deploy/app/node_modules")).toBeNull();
    expect(systemPath("/root")).toBe("/root");
    expect(systemPath("/root/scratch")).toBeNull();
  });
});

describe("commandOfPayload", () => {
  test("Claude Code's and Codex's Bash call", () => {
    expect(commandOfPayload({ tool_name: "Bash", tool_input: { command: "ls" } })).toBe("ls");
  });
  test("an argv is quoted back into one line", () => {
    expect(commandOfPayload({ tool_input: { command: ["bash", "-lc", "rm -rf /dev/null"] } })).toBe("bash -lc 'rm -rf /dev/null'");
  });
  test("anything else is nothing", () => {
    expect(commandOfPayload({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } })).toBeNull();
    expect(commandOfPayload(null)).toBeNull();
  });
});

describe("the guard's hooks", () => {
  type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string; async?: boolean }[] }[]> };
  const guard = "/home/me/.local/state/kururu/bin/rmguard";

  test("rides with the reporter on PreToolUse, and is waited for", () => {
    const settings = hookSettings("/bin/node", "/x/report.mjs", undefined, guard) as Settings;
    const pre = settings.hooks.PreToolUse ?? [];
    expect(pre).toHaveLength(2);
    expect(pre[1]?.matcher).toBe("Bash");
    expect(pre[1]?.hooks[0]?.command).toBe(`'${guard}'`);
    expect(pre[1]?.hooks[0]?.async).toBeUndefined();
  });

  test("alone, for a directory that reports everything itself", () => {
    const settings = hookSettings("/bin/node", "/x/report.mjs", "guard", guard) as Settings;
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse"]);
  });

  test("absent while there is no command to name", () => {
    const settings = hookSettings("/bin/node", "/x/report.mjs", undefined, null) as Settings;
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test("Codex's line is one -c override", () => {
    expect(codexGuardFlag(guard)).toBe(`-c 'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="${guard}",timeout=10}]}]'`);
  });

  test("the script looks past the session's fields before starting node", () => {
    const text = guardCommandText("/bin/node", "/x/guard.mjs");
    expect(text).toContain('c=${p#*\\"tool_input\\"}');
    expect(text).toContain("*rm*|");
    expect(text).toContain("*'>'*");
  });
});
