import { describe, expect, it } from "bun:test";
import { isNvimTab, listenOf, nvimCommand } from "../src/nvim";

describe("nvimCommand", () => {
  // Pinned to the string tabs were started with before it moved here, because
  // `isNvimTab` reads the host's record of it and a tab opened by an older
  // server must still be recognised.
  it("is the command line nvim tabs have always been started with", () => {
    expect(nvimCommand()).toBe(`printf '\\033]2;nvim\\007'; nvim; exec "\${SHELL:-/bin/sh}" -l`);
    expect(nvimCommand("/a/it's.md")).toBe(
      `printf '\\033]2;nvim\\007'; nvim -- '/a/it'\\''s.md'; exec "\${SHELL:-/bin/sh}" -l`,
    );
  });

  it("opens at a line when a link names one, and at the top when it names nonsense", () => {
    expect(nvimCommand("src/a.ts", 120)).toBe(`printf '\\033]2;nvim\\007'; nvim +120 -- 'src/a.ts'; exec "\${SHELL:-/bin/sh}" -l`);
    expect(nvimCommand("src/a.ts", 0)).toBe(nvimCommand("src/a.ts"));
    expect(nvimCommand("src/a.ts", 1.5)).toBe(nvimCommand("src/a.ts"));
    expect(nvimCommand(undefined, 9)).toBe(nvimCommand());
  });
});

describe("isNvimTab", () => {
  it("knows a tab kururu started as nvim, with a file or without", () => {
    expect(isNvimTab(nvimCommand())).toBe(true);
    expect(isNvimTab(nvimCommand("/a/b.ts"))).toBe(true);
    expect(isNvimTab(nvimCommand("/a/b.ts", 40))).toBe(true);
  });

  it("is not every command that mentions nvim", () => {
    expect(isNvimTab("nvim")).toBe(false);
    expect(isNvimTab("/bin/zsh")).toBe(false);
    expect(isNvimTab("claude --model opus")).toBe(false);
    expect(isNvimTab("printf x; nvim")).toBe(false);
    expect(isNvimTab(`printf '\\033]2;nvim\\007'; nvimx`)).toBe(false);
  });
});

describe("listenOf", () => {
  it("is an address nvim was told to listen on, when it can be dialled as written", () => {
    expect(listenOf("nvim --listen /tmp/n.sock foo.md")).toBe("/tmp/n.sock");
    expect(listenOf("nvim --embed --listen=127.0.0.1:6666")).toBe("127.0.0.1:6666");
    expect(listenOf("nvim --listen work foo.md")).toBeNull();
    expect(listenOf("nvim foo.md")).toBeNull();
  });
});
