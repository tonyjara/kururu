/**
 * The facts the page states that will go stale, gathered so a release changes
 * one file. The download links name a version on purpose: GitHub's
 * `releases/latest/download/` only redirects to a file of the same name, and
 * ours carry the version in theirs.
 */
export const SITE = {
  url: "https://kururu.dev",
  title: "Kururu — one window for all your coding agents",
  description:
    "Run Claude Code and Codex across every project from one window. Tiled terminals, boards that start agents, a harness you talk to by voice or Telegram, remote machines, and your phone. Free and open source for macOS.",
  github: "https://github.com/tonyjara/kururu",
};

export const RELEASE = {
  version: "0.4.0",
  date: "October 2026",
  page: "https://github.com/tonyjara/kururu/releases/latest",
  appleSilicon: "https://github.com/tonyjara/kururu/releases/download/v0.4.0/Kururu-0.4.0-arm64.dmg",
  intel: "https://github.com/tonyjara/kururu/releases/download/v0.4.0/Kururu-0.4.0.dmg",
};
