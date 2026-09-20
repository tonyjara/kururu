/**
 * The parts, as the three properties each one compiles to.
 *
 * `partVars` is the whole of how a picture reaches the stylesheet, and it is
 * pure on purpose — the client writes what it returns onto the root, and the
 * `:root` block in `styles.css` has to say the same thing for a skin that
 * painted nothing, which `web/test/theme.test.ts` checks. What is held here is
 * the other half: that a painted part comes out as a `border-image` the browser
 * will take, that a state left unpainted borrows its parent's rather than going
 * blank, and that a tile is drawn at its own size times its scale — because a
 * tile drawn at `auto` is pixel art at one-third the size the author drew it
 * for, which looks like a bug in the picture rather than in the arithmetic.
 */
import { describe, expect, it } from "bun:test";
import { PART_NAMES, partVars, skinFor, type PartPaint } from "../../shared/skin";

const bezel: PartPaint = { image: "/api/styles/asset?kind=skin&id=x&file=bezel.png", mode: "nine", slice: [8, 8, 12, 8], scale: 3, repeat: "repeat" };

describe("partVars", () => {
  it("compiles nothing to nothing, and a state to its parent", () => {
    const vars = partVars(skinFor(null).parts);
    expect(vars["--p-pane-frame"]).toBe("none");
    expect(vars["--p-pane-w"]).toBe("0px");
    expect(vars["--p-pane-bg"]).toBe("none");
    expect(vars["--p-pane-on-frame"]).toBe("var(--p-pane-frame)");
    expect(vars["--p-tab-on-w"]).toBe("var(--p-tab-w)");
    // The one region that had a line before skins could paint keeps it.
    expect(vars["--p-dialog-w"]).toBe("var(--border)");
    expect(Object.keys(vars)).toHaveLength(PART_NAMES.length * 3);
  });

  it("makes a nine-slice into a border-image whose width is the slice at scale", () => {
    const vars = partVars({ pane: bezel });
    expect(vars["--p-pane-frame"]).toBe(
      'url("/api/styles/asset?kind=skin&id=x&file=bezel.png") 8 8 12 8 fill / 24px 24px 36px 24px / 0 repeat',
    );
    expect(vars["--p-pane-w"]).toBe("24px 24px 36px 24px");
    expect(vars["--p-pane-bg"]).toBe("none");
    // And the focused pane, unpainted, still points at it rather than at none.
    expect(vars["--p-pane-on-frame"]).toBe("var(--p-pane-frame)");
  });

  it("draws a tile at its measured size times its scale, and a stretch to the box", () => {
    const tile: PartPaint = { image: "/a/tile.png", mode: "tile", slice: [0, 0, 0, 0], scale: 2, repeat: "stretch", size: [16, 16] };
    const backdrop: PartPaint = { image: "/a/shell.png", mode: "stretch", slice: [0, 0, 0, 0], scale: 1, repeat: "stretch" };
    const vars = partVars({ sidebar: tile, well: backdrop });
    expect(vars["--p-sidebar-bg"]).toBe('url("/a/tile.png") 0 0 / 32px 32px repeat');
    expect(vars["--p-sidebar-frame"]).toBe("none");
    expect(vars["--p-well-bg"]).toBe('url("/a/shell.png") 0 0 / 100% 100% no-repeat');
  });

  it("falls back to the picture's natural size for a tile nobody measured", () => {
    const vars = partVars({ statusbar: { image: "/a/t.png", mode: "tile", slice: [0, 0, 0, 0], scale: 4, repeat: "stretch" } });
    expect(vars["--p-statusbar-bg"]).toBe('url("/a/t.png") 0 0 / auto repeat');
  });

  it("quotes the url, so a name with a parenthesis in it cannot end the function early", () => {
    const vars = partVars({ pane: { ...bezel, image: "/a/b(1).png" } });
    expect(vars["--p-pane-frame"]!.startsWith('url("/a/b(1).png")')).toBe(true);
  });
});
