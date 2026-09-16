/**
 * The registry format, as the half of it that is checking rather than fetching.
 *
 * Everything in `shared/styles.ts` is applied to a file somebody else wrote,
 * fetched over the network, on its way to becoming custom properties on the root
 * element of a window that is reachable from the tailnet. That makes it the one
 * module in kururu where "it worked when I tried it" is the wrong standard:
 * these functions are interesting precisely on the inputs nobody will type by
 * hand, and the two that would hurt most are silent.
 *
 * The first is `compareVersions`. A string comparison gets `"1.10.0"` against
 * `"1.2.0"` backwards, so a real update reads as a downgrade and every installed
 * style says it is current forever — a bug with no symptom at all except that
 * nothing ever updates.
 *
 * The second is `cssValue`. It has exactly one job that matters, which is that
 * nothing a manifest says can make the window fetch from a host somebody else
 * controls, and the failure there is not a broken window: it is a border that
 * works perfectly and tells a stranger's server when its owner is at their desk.
 *
 * Nothing here touches the network or the disk. `server/src/styles.ts` is the
 * part that does, and it is deliberately thin for that reason.
 */
import { describe, expect, it } from "bun:test";
import {
  adoptIndex,
  adoptSkinManifest,
  adoptThemeManifest,
  compareVersions,
  cssValue,
  isAssetName,
  isVersion,
} from "../../shared/styles";
import { skinFor } from "../../shared/skin";
import { themeFor } from "../../shared/theme";

describe("compareVersions", () => {
  it("compares numerically, which is the whole reason it is not a string compare", () => {
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("only accepts the three-part form the registry enforces", () => {
    expect(isVersion("1.2.3")).toBe(true);
    expect(isVersion("1.2")).toBe(false);
    expect(isVersion("1.2.3-beta")).toBe(false);
    expect(isVersion("01.2.3")).toBe(false);
    expect(isVersion(3)).toBe(false);
  });
});

describe("cssValue", () => {
  it("keeps the values a skin is actually written in", () => {
    expect(cssValue("0")).toBe("0");
    expect(cssValue("inset 0 0 0 2px var(--chrome)")).toBe("inset 0 0 0 2px var(--chrome)");
    expect(cssValue('"Space Mono", ui-monospace, Menlo, monospace')).toBe(
      '"Space Mono", ui-monospace, Menlo, monospace',
    );
    expect(cssValue("repeating-linear-gradient(to bottom, rgba(0,0,0,0.2) 0 1px, transparent 1px 3px)")).toBe(
      "repeating-linear-gradient(to bottom, rgba(0,0,0,0.2) 0 1px, transparent 1px 3px)",
    );
  });

  it("refuses anything that would fetch from somewhere else", () => {
    expect(cssValue("url(https://example.com/x.png)")).toBeNull();
    expect(cssValue("url(//example.com/x.png)")).toBeNull();
    expect(cssValue('url("http://example.com/x.png")')).toBeNull();
    expect(cssValue("@import url(x.css)")).toBeNull();
    // A bare relative file is refused too, and that is not an oversight: the
    // *server* rewrites `url(paper.png)` into its own asset endpoint before a
    // value ever reaches here, so one that still looks like a file is one that
    // named a file the entry does not contain.
    expect(cssValue("url(paper.png)")).toBeNull();
  });

  it("allows the one url shape the server produces", () => {
    const rewritten = 'url("/api/styles/asset?kind=skin&id=paper&file=grain.png")';
    expect(cssValue(rewritten)).toBe(rewritten);
  });

  it("refuses the characters that could end a declaration and start another", () => {
    expect(cssValue("red; } body { display: none")).toBeNull();
    expect(cssValue("expression(alert(1))")).toBeNull();
    expect(cssValue("</style><script>")).toBeNull();
    expect(cssValue("")).toBeNull();
    expect(cssValue(42)).toBeNull();
  });
});

describe("isAssetName", () => {
  it("is a name, never a path", () => {
    expect(isAssetName("sheet.png")).toBe(true);
    expect(isAssetName("space-mono-400.woff2")).toBe(true);
    expect(isAssetName("../../../.ssh/id_rsa")).toBe(false);
    expect(isAssetName("a/b.png")).toBe(false);
    expect(isAssetName("..")).toBe(false);
    expect(isAssetName(".hidden")).toBe(false);
  });
});

describe("adoptIndex", () => {
  const entry = {
    kind: "theme",
    id: "dracula",
    name: "Dracula",
    version: "1.0.0",
    description: "The purple one.",
    author: "Dracula Theme",
    licence: "MIT",
    digest: `sha256-${"a".repeat(64)}`,
    files: [{ name: "theme.json", size: 1678, digest: `sha256-${"b".repeat(64)}` }],
    preview: { bg: "#282a36" },
  };

  it("takes a well-formed index", () => {
    const index = adoptIndex({ schema: 1, entries: [entry] });
    expect(index?.entries).toHaveLength(1);
    expect(index?.entries[0]!.id).toBe("dracula");
  });

  /**
   * A schema this version does not speak is the one case where refusing beats
   * salvaging: it means kururu and the registry disagree about what a manifest
   * *is*, and a partial reading of a format you do not understand is worse than
   * saying so.
   */
  it("refuses an index from a schema it does not speak", () => {
    expect(adoptIndex({ schema: 2, entries: [entry] })).toBeNull();
    expect(adoptIndex({ entries: [] })).toBeNull();
    expect(adoptIndex(null)).toBeNull();
  });

  /**
   * One bad contribution must not take the tab down for everybody, which is the
   * opposite call from the one above and is right for the opposite reason: a
   * malformed *entry* is a thing the registry will eventually contain, and the
   * others are still perfectly installable.
   */
  it("drops an entry it cannot read rather than failing the fetch", () => {
    const index = adoptIndex({
      schema: 1,
      entries: [entry, { ...entry, id: "../etc" }, { ...entry, id: "nord", version: "one" }],
    });
    expect(index?.entries.map((e) => e.id)).toEqual(["dracula"]);
  });

  /**
   * The path is rebuilt from the kind and the id rather than taken, so an index
   * cannot point kururu at a directory of its own choosing. This is the
   * `files.ts` rule — never learn a root from the other end — applied to the one
   * place a fetched file could supply one.
   */
  it("never follows a path the index supplies", () => {
    const index = adoptIndex({
      schema: 1,
      entries: [{ ...entry, path: "../../secrets", manifest: "../../id_rsa" }],
    });
    expect(index?.entries[0]!.path).toBe("themes/dracula");
    expect(index?.entries[0]!.manifest).toBe("theme.json");
  });

  it("keeps a credit link only when it is https", () => {
    const https = adoptIndex({ schema: 1, entries: [{ ...entry, homepage: "https://draculatheme.com" }] });
    expect(https?.entries[0]!.homepage).toBe("https://draculatheme.com");
    const script = adoptIndex({ schema: 1, entries: [{ ...entry, homepage: "javascript:alert(1)" }] });
    expect(script?.entries[0]!.homepage).toBeUndefined();
  });
});

describe("adoptThemeManifest", () => {
  const base = themeFor(null);

  it("takes a complete palette verbatim", () => {
    const theme = adoptThemeManifest({
      id: "dracula",
      name: "Dracula",
      appearance: "dark",
      ui: { ...base.ui, bg: "#282a36", accent: "#50fa7b" },
      terminal: base.terminal,
      workspace: base.workspace,
    });
    expect(theme?.ui.bg).toBe("#282a36");
    expect(theme?.ui.accent).toBe("#50fa7b");
  });

  /**
   * The forward-compatibility half of "a theme is complete". The registry
   * requires every token *of the author*; kururu fills a gap from its own
   * default rather than refusing, because a manifest written against an older
   * token set is the case a registry guarantees will happen, and the alternative
   * is every published entry dying the day kururu grows a token.
   */
  it("fills a token the manifest predates, rather than refusing the file", () => {
    const theme = adoptThemeManifest({ id: "partial", ui: { bg: "#111111" } });
    expect(theme?.ui.bg).toBe("#111111");
    expect(theme?.ui.accent).toBe(base.ui.accent);
    expect(theme?.terminal.brightWhite).toBe(base.terminal.brightWhite);
    expect(theme?.workspace.lime).toBe(base.workspace.lime);
  });

  it("refuses a value that is not a colour, and keeps the default there", () => {
    const theme = adoptThemeManifest({ id: "bad", ui: { bg: "url(https://x/y.png)", accent: "rebeccapurple" } });
    expect(theme?.ui.bg).toBe(base.ui.bg);
    // A named colour is valid CSS and is deliberately not accepted: these go to
    // ghostty as well as to CSS, and an ANSI palette is not expressed in words.
    expect(theme?.ui.accent).toBe(base.ui.accent);
  });

  it("refuses a manifest that is not a theme at all", () => {
    expect(adoptThemeManifest({ ui: {} })).toBeNull();
    expect(adoptThemeManifest({ id: "no-ui" })).toBeNull();
    expect(adoptThemeManifest({ id: "Bad Id", ui: {} })).toBeNull();
  });
});

describe("adoptSkinManifest", () => {
  const asset = (file: string) => (file === "face.woff2" ? `/api/styles/asset?file=${file}` : null);
  const base = skinFor(null);

  it("merges onto the base, so a skin is only the difference it makes", () => {
    const skin = adoptSkinManifest({ id: "square", name: "Square", tokens: { radiusXl: "0" } }, asset);
    expect(skin?.tokens.radiusXl).toBe("0");
    expect(skin?.tokens.radiusMd).toBe(base.tokens.radiusMd);
    expect(skin?.icons.close).toBe(base.icons.close);
  });

  it("drops a token that is not one kururu answers for, and one that is not a CSS value", () => {
    const skin = adoptSkinManifest(
      { id: "x", tokens: { radiusXl: "0", nonsense: "3px", overlay: "url(https://x/y.png)" } },
      asset,
    );
    expect(skin?.tokens.overlay).toBe(base.tokens.overlay);
    expect("nonsense" in (skin?.tokens ?? {})).toBe(false);
  });

  /**
   * A skin that moved nothing is the default under a different name, and
   * offering it in the picker is offering a choice with one outcome.
   */
  it("refuses a skin that changes nothing", () => {
    expect(adoptSkinManifest({ id: "empty", tokens: {} }, asset)).toBeNull();
    expect(adoptSkinManifest({ id: "junk", tokens: { nonsense: "3px" } }, asset)).toBeNull();
  });

  it("takes a glyph, and leaves the base's where the skin wrote null", () => {
    const skin = adoptSkinManifest({ id: "ascii", tokens: { radiusXl: "0" }, icons: { close: "x", restart: null } }, asset);
    expect(skin?.icons.close).toBe("x");
    expect(skin?.icons.restart).toBe(base.icons.restart);
  });

  it("refuses a label pretending to be a glyph", () => {
    const skin = adoptSkinManifest({ id: "wordy", tokens: { radiusXl: "0" }, icons: { close: "CLOSE" } }, asset);
    expect(skin?.icons.close).toBe(base.icons.close);
  });

  /**
   * A font the entry did not actually ship gets no `@font-face` rather than one
   * pointing at a 404, which the window would re-request on every paint.
   */
  it("keeps a font it can serve and drops one it cannot", () => {
    const skin = adoptSkinManifest(
      {
        id: "faced",
        tokens: { radiusXl: "0" },
        fonts: [
          { family: "Space Mono", file: "face.woff2", weight: "400", style: "normal" },
          { family: "Ghost", file: "missing.woff2", weight: "400", style: "normal" },
        ],
      },
      asset,
    );
    expect(skin?.fonts).toHaveLength(1);
    expect(skin?.fonts?.[0]!.src).toBe("/api/styles/asset?file=face.woff2");
  });

  it("refuses a family name that could close the declaration it lands in", () => {
    const skin = adoptSkinManifest(
      { id: "sneaky", tokens: { radiusXl: "0" }, fonts: [{ family: 'X"; } body {', file: "face.woff2" }] },
      asset,
    );
    expect(skin?.fonts).toBeUndefined();
  });
});
