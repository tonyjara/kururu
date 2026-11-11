/**
 * A workspace's root as it may be stored (`shared/workspaceroot.ts`): one
 * absolute path, `~` expanded, or nothing — and never a value a process's
 * directory could be surprised by.
 */
import { describe, expect, it } from "bun:test";
import { adoptRoot, tildePath, workspaceRootPath } from "../../shared/workspaceroot";

const HOME = "/Users/me";

describe("a root as it is stored", () => {
  it("expands ~ and folds . and .. away, as a terminal started there would report it", () => {
    expect(workspaceRootPath("~/Desktop/Nyto/kururu", HOME)).toBe("/Users/me/Desktop/Nyto/kururu");
    expect(workspaceRootPath("~", HOME)).toBe("/Users/me");
    expect(workspaceRootPath("  /srv/app/  ", HOME)).toBe("/srv/app");
    expect(workspaceRootPath("/srv//app/./web/..", HOME)).toBe("/srv/app");
    expect(workspaceRootPath("/", HOME)).toBe("/");
  });

  it("reads empty as none, and refuses what is not an absolute path", () => {
    expect(workspaceRootPath("", HOME)).toBeNull();
    expect(workspaceRootPath("   ", HOME)).toBeNull();
    expect(workspaceRootPath(null, HOME)).toBeNull();
    for (const bad of ["code/app", "~other/app", "./app", "/a\nb", "/a\u0000b", 42, {}, `/${"x".repeat(2000)}`]) {
      expect(workspaceRootPath(bad, HOME)).toBeUndefined();
    }
  });

  it("adopts a stored one as none rather than an error when it is not a path", () => {
    expect(adoptRoot("/srv/app", HOME)).toBe("/srv/app");
    expect(adoptRoot("srv/app", HOME)).toBeNull();
    expect(adoptRoot(undefined, HOME)).toBeNull();
  });

  it("is drawn with ~ under the home folder, and only there", () => {
    expect(tildePath("/Users/me/Desktop/x", HOME)).toBe("~/Desktop/x");
    expect(tildePath("/Users/me", HOME)).toBe("~");
    expect(tildePath("/Users/meme/x", HOME)).toBe("/Users/meme/x");
    expect(tildePath("/srv/app", HOME)).toBe("/srv/app");
  });
});
