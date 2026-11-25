import { describe, expect, test } from "bun:test";
import { adoptTestReport, chipName, classifyCommand, commandParts, exitCodeIn, outcomeOf, parseTestCounts, redactCommand, shortDuration, wasRefused } from "../../shared/testing";

/** [command, kind, runner, suite, focused] */
const RUNS: [string, string, string, string, boolean][] = [
  ["bun test", "unit", "bun", "bun test", false],
  ["bun test server/test/testing.test.ts", "unit", "bun", "bun test", true],
  ["cd /x/y && bun run typecheck 2>&1 | tail -5 && bun test 2>&1 | tail -4", "unit", "bun", "bun typecheck + bun test", false],
  ["pnpm chat:e2e", "e2e", "script", "pnpm chat:e2e", false],
  ["pnpm --filter web test", "unit", "script", "pnpm test (web)", false],
  ["pnpm -C apps/api run test:unit -- --reporter dot", "unit", "script", "pnpm test:unit (api)", false],
  ["bun run --cwd web typecheck", "typecheck", "script", "bun typecheck (web)", false],
  ["npm test", "unit", "script", "npm test", false],
  ["npm run lint", "lint", "script", "npm lint", false],
  ["yarn workspace @acme/web build", "build", "script", "yarn build (web)", false],
  ["FOO=bar CI=1 npx vitest run", "unit", "vitest", "vitest", false],
  ["npx vitest run src/a.test.ts -t 'adds'", "unit", "vitest", "vitest", true],
  ["./node_modules/.bin/vitest --config vitest.e2e.config.ts", "e2e", "vitest", "vitest (vitest.e2e.config.ts)", false],
  ["npx jest --maxWorkers 2", "unit", "jest", "jest", false],
  ["pnpm exec playwright test --project=chromium", "e2e", "playwright", "playwright test (chromium)", false],
  ["npx playwright test tests/login.spec.ts", "e2e", "playwright", "playwright test", true],
  ["python -m pytest -q", "unit", "pytest", "pytest", false],
  ["uv run pytest tests/test_api.py -k login", "unit", "pytest", "pytest", true],
  ["go test ./...", "unit", "go", "go test", false],
  ["go vet ./...", "lint", "go", "go vet", false],
  ["cargo clippy -- -D warnings", "lint", "cargo", "cargo clippy", false],
  ["tsc --noEmit -p tsconfig.js.json", "typecheck", "tsc", "tsc (tsconfig.js.json)", false],
  ["npx eslint .", "lint", "eslint", "eslint", false],
  ["biome check .", "lint", "biome", "biome check", false],
  ["prettier --check .", "lint", "prettier", "prettier --check", false],
  ["next build", "build", "next", "next build", false],
  ["xcodebuild -workspace App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' test", "simulator", "xcodebuild", "xcodebuild test (app.xcworkspace)", false],
  ["xcodebuild -scheme App build", "build", "xcodebuild", "xcodebuild build (app)", false],
  ["maestro test flows/", "simulator", "maestro", "maestro test", false],
  ["~/.local/state/kururu/bin/slot run maestro -- maestro test .maestro/smoke.yaml", "simulator", "maestro", "maestro test", false],
  ["vault run --secret DB=DATABASE_URL -- pnpm test:e2e", "e2e", "script", "pnpm test:e2e", false],
  ["timeout 600 pnpm e2e", "e2e", "script", "pnpm e2e", false],
  ["node --test test/", "unit", "node", "node --test", true],
  ["node scripts/check-contract.mjs", "check", "script", "check-contract.mjs", false],
  ["./scripts/e2e.sh --headed", "e2e", "script", "e2e.sh", false],
  ["bash -lc 'pnpm test'", "unit", "script", "pnpm test", false],
  ["make test", "unit", "script", "make test", false],
  ["turbo run build --filter=web", "build", "script", "turbo build", false],
  ["./gradlew :app:testDebugUnitTest", "unit", "gradle", "gradle testDebugUnitTest", false],
  ["docker compose build api", "build", "docker", "docker compose build", false],
  ["python manage.py test accounts", "unit", "django", "manage.py test", false],
];

const NOT_RUNS = [
  "git commit -m 'fix the tests && pnpm test'",
  "cat server/test/testing.test.ts",
  "grep -rn vitest .",
  "ls tests/ | head",
  "rm -rf test-results",
  "echo bun test",
  "pnpm install",
  "pnpm dev",
  "bun run dev",
  "npm ci",
  "npx playwright install chromium",
  "node server.js",
  "curl -H 'Authorization: Bearer abc' https://example.com/test",
  "prettier --write .",
  "cat > /tmp/x.sh <<'EOF'\nbun test\npnpm e2e\nEOF",
  "git log --oneline | grep test",
  "",
];

describe("classifyCommand", () => {
  for (const [command, kind, runner, suite, focused] of RUNS) {
    test(command, () => {
      const call = classifyCommand(command);
      expect(call).not.toBeNull();
      expect([call!.kind, call!.runner, call!.suite, call!.focused]).toEqual([kind, runner, suite, focused]);
    });
  }
  for (const command of NOT_RUNS) {
    test(`not a run: ${command.slice(0, 50)}`, () => expect(classifyCommand(command)).toBeNull());
  }
  test("keeps the run and drops the rest of the line", () => {
    const call = classifyCommand("cd /Users/me/secret-client && API_KEY=sk-live-abcdefgh12345678 pnpm test:e2e --grep checkout 2>&1 | tail -20; echo done")!;
    expect(call.command).toBe("API_KEY=… pnpm test:e2e --grep checkout");
    expect(call.focused).toBe(true);
  });
  test("a heredoc's body is not run", () => {
    const call = classifyCommand("cat > run.sh <<EOF\nvitest\nEOF\nbun test")!;
    expect(call.suite).toBe("bun test");
  });
  test("non-strings are nothing", () => {
    expect(classifyCommand(undefined)).toBeNull();
    expect(classifyCommand({ command: "bun test" })).toBeNull();
  });
});

describe("commandParts", () => {
  test("splits where a shell would, and not inside quotes or a redirect", () => {
    expect(commandParts("a 2>&1 | b && c 'x; y' ; d &>/dev/null\ne")).toEqual(["a 2>&1", "b", "c 'x; y'", "d &>/dev/null", "e"]);
  });
});

describe("redactCommand", () => {
  const cases: [string, string][] = [
    ["DATABASE_URL=postgres://u:p@h/db pnpm test", "DATABASE_URL=… pnpm test"],
    ["pnpm e2e --token abc123 --grep x", "pnpm e2e --token … --grep x"],
    ["pnpm e2e --api-key=abc123", "pnpm e2e --api-key=…"],
    ["playwright test --base-url https://user:hunter2@staging.example.com/x?key=abc&y=1", "playwright test --base-url https://…@staging.example.com/x?key=…&y=…"],
    ["vitest ghp_abcdefghijklmnopqrstuvwxyz0123456789", "vitest …"],
    ["jest eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc", "jest …"],
    ["pytest 0123456789abcdef0123456789abcdef01234567", "pytest …"],
    ["bun   test\n  x", "bun test x"],
  ];
  for (const [from, to] of cases) test(from.slice(0, 40), () => expect(redactCommand(from)).toBe(to));
  test("is cut to a line", () => expect(redactCommand(`vitest ${"a ".repeat(400)}`).length).toBeLessThanOrEqual(240));
});

describe("parseTestCounts", () => {
  const cases: [string, string, (number | null)[], string][] = [
    ["bun", " 3273 pass\n 2 skip\n 1 fail\n 11473 expect() calls\nRan 3276 tests across 182 files. [32.44s]", [3273, 1, 2], "bun"],
    ["vitest", " Test Files  1 failed | 10 passed (11)\n      Tests  3 failed | 120 passed | 2 skipped (125)\n   Duration  4.2s", [120, 3, 2], "vitest"],
    ["vitest all passed", " Test Files  10 passed (10)\n      Tests  120 passed (120)", [120, 0, 0], "vitest"],
    ["jest", "Test Suites: 1 failed, 4 passed, 5 total\nTests:       1 failed, 2 skipped, 30 passed, 33 total\nSnapshots:   0 total", [30, 1, 2], "jest"],
    ["pytest", "==================== 3 failed, 120 passed, 2 skipped in 12.34s ====================", [120, 3, 2], "pytest"],
    ["pytest passed", "======= 5 passed in 0.12s =======", [5, 0, 0], "pytest"],
    ["playwright", "  2 failed\n    [chromium] › a.spec.ts:3:1 › x\n  1 skipped\n  7 passed (12.3s)", [7, 2, 1], "playwright"],
    ["cargo", "test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n\ntest result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured", [15, 2, 1], "cargo"],
    ["node", "ℹ tests 12\nℹ pass 11\nℹ fail 1\nℹ skipped 0", [11, 1, 0], "node"],
    ["mocha", "  12 passing (3s)\n  2 pending\n  1 failing", [12, 1, 2], "mocha"],
    ["xcodebuild", "Executed 12 tests, with 1 failure (0 unexpected) in 3.456 (3.789) seconds\n** TEST FAILED **", [11, 1, 0], "xcodebuild"],
    ["maestro", "3/4 Flows Passed in 2m 1s", [3, 1, 0], "maestro"],
    ["go -v", "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- SKIP: TestC (0.00s)\nFAIL\tpkg/x\t0.012s", [1, 1, 1], "go"],
    ["go", "ok  \tgithub.com/x/a\t0.123s\nok  \tgithub.com/x/b\t(cached)\nFAIL\tgithub.com/x/c\t0.5s", [2, 1, 0], "go"],
    ["maven", "Tests run: 12, Failures: 1, Errors: 1, Skipped: 2", [8, 2, 2], "junit"],
    ["rspec", "12 examples, 1 failure, 2 pending", [9, 1, 2], "rspec"],
    ["tsc", "src/a.ts:1:1 - error TS2322: no\n\nFound 3 errors in 2 files.", [null, 3, null], "tsc"],
    ["tsc plain", "a.ts(1,2): error TS2322: no\nb.ts(3,4): error TS1005: no", [null, 2, null], "tsc"],
    ["eslint", "✖ 12 problems (10 errors, 2 warnings)", [null, 10, null], "eslint"],
    ["ansi", "\x1b[32m 5 pass\x1b[0m\n\x1b[31m 0 fail\x1b[0m", [5, 0, 0], "bun"],
  ];
  for (const [name, output, [passed, failed, skipped], runner] of cases) {
    test(name, () => expect(parseTestCounts(output)).toEqual({ passed: passed!, failed: failed!, skipped: skipped!, runner }));
  }
  test("no summary is no counts", () => {
    expect(parseTestCounts("$ tsc --noEmit\n")).toBeNull();
    expect(parseTestCounts("")).toBeNull();
    expect(parseTestCounts(undefined)).toBeNull();
  });
});

describe("outcome", () => {
  test("counts before the exit code", () => {
    expect(outcomeOf(0, { passed: 3, failed: 1, skipped: 0 }, false)).toBe("fail");
    expect(outcomeOf(1, { passed: 3, failed: 0, skipped: 0 }, false)).toBe("fail");
    expect(outcomeOf(0, null, false)).toBe("pass");
    expect(outcomeOf(null, null, false)).toBeNull();
    expect(outcomeOf(0, null, true)).toBe("stopped");
  });
  test("exit code in Claude Code's error text", () => {
    expect(exitCodeIn("Exit code 1\n 3 pass")).toBe(1);
    expect(exitCodeIn("Error: Exit code 128\nfatal")).toBe(128);
    expect(exitCodeIn("Command timed out after 2m")).toBeNull();
    expect(wasRefused("The user doesn't want to proceed with this tool use.")).toBe(true);
    expect(wasRefused("Exit code 1")).toBe(false);
  });
});

describe("a hook's report", () => {
  const call = { kind: "e2e", runner: "script", suite: "pnpm chat:e2e", command: "TOKEN=abc pnpm chat:e2e", focused: false };
  test("is held to its shape and redacted again", () => {
    const got = adoptTestReport({ phase: "end", session: "s1", callId: "toolu_1", call, durationMs: 1234.4, exit: 1, counts: { passed: 3, failed: 1, skipped: "x", runner: "vitest" } });
    expect(got).toEqual({ phase: "end", session: "s1", callId: "toolu_1", background: false, call: { ...call, command: "TOKEN=… pnpm chat:e2e" } as never, durationMs: 1234, exit: 1, stopped: false, counts: { passed: 3, failed: 1, skipped: null, runner: "vitest" } });
  });
  test("anything else is nothing", () => {
    expect(adoptTestReport(null)).toBeNull();
    expect(adoptTestReport({ phase: "start", session: "s 1", callId: "c", call })).toBeNull();
    expect(adoptTestReport({ phase: "start", session: "s1", callId: "c", call: { ...call, kind: "fun" } })).toBeNull();
    expect(adoptTestReport({ phase: "start", session: "s1", callId: "c", call: { ...call, durationMs: NaN } })?.durationMs).toBeUndefined();
  });
});

test("a chip's words", () => {
  expect(shortDuration(130_000)).toBe("2m10s");
  expect(shortDuration(45_400)).toBe("45s");
  expect(shortDuration(3_840_000)).toBe("1h04m");
  expect(chipName("pnpm chat:e2e")).toBe("chat:e2e");
  expect(chipName("bun test")).toBe("bun test");
  expect(chipName("bun typecheck + bun test")).toBe("typecheck + bun test");
});
