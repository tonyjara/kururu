/**
 * Markdown, turned into markup on the side that can afford to.
 *
 * This is the thing kururu exists for: a terminal cannot show you a rendered
 * document, and once looking at one is something you do several times a day the
 * answer is a frontend that draws. The rendering happens *here* rather than in
 * the browser for the reason the plan gives for syntax highlighting — the phone
 * should be sent markup, not a parser and a highlighter and every grammar either
 * of them might turn out to need. It also means there is one renderer rather
 * than one per client, which is the same argument the layout makes for living on
 * the server.
 *
 * **Raw HTML is off, and that is the sanitizer.** A markdown file here is not a
 * document somebody wrote you — it is a file in a project, and increasingly one
 * an *agent* wrote, on a server that answers to the tailnet. The usual answer is
 * to render everything and scrub the result, which means a DOM in the server
 * just to hold the thing being scrubbed. The cheaper and stricter answer is to
 * make the renderer incapable of emitting anything but its own constructs:
 * `html: false` means a `<script>` in a README arrives as the text `<script>`,
 * which is also the honest thing to show somebody reading a file.
 *
 * What still has to be checked is URLs, because those are markdown's own
 * constructs and they end up in `href` and `src`. Two jobs there: refuse a
 * scheme that executes, and rewrite a relative path into something a browser
 * pointing at kururu can actually fetch — `![](./diagram.png)` means a file next
 * to the markdown, and the browser has no idea where that is.
 */
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import wasm from "shiki/wasm";
import vitesseDark from "shiki/themes/vitesse-dark.mjs";
import catppuccinFrappe from "shiki/themes/catppuccin-frappe.mjs";
import catppuccinLatte from "shiki/themes/catppuccin-latte.mjs";
import catppuccinMacchiato from "shiki/themes/catppuccin-macchiato.mjs";
import catppuccinMocha from "shiki/themes/catppuccin-mocha.mjs";
import { posix } from "node:path";

/**
 * The grammars, named one by one and bundled with the server.
 *
 * Shiki's convenient entry point carries a lazy loader for all seven hundred of
 * its languages, and "lazy" is a runtime idea that a bundler cannot honour: the
 * server is one file, so every grammar that *could* be reached is in it, and
 * naming them by their loader took the build from about a megabyte to ten. Those
 * ten megabytes are also what `run.mjs` rewrites on every save to `server/src`.
 *
 * So the set is fixed and it is short, and a fence in a language not on it
 * renders as a plain block — which is what an unknown fence did anyway, and is a
 * far better trade than a build that is nine megabytes of Fortran.
 */
import bash from "shiki/langs/bash.mjs";
import c from "shiki/langs/c.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import docker from "shiki/langs/docker.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import java from "shiki/langs/java.mjs";
import json from "shiki/langs/json.mjs";
import lua from "shiki/langs/lua.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import sql from "shiki/langs/sql.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import zig from "shiki/langs/zig.mjs";

const LANGS = [
  bash, c, css, diff, docker, go, html, java, json, lua, markdown,
  python, ruby, rust, sql, swift, toml, tsx, typescript, yaml, zig,
];

/**
 * A syntax theme per kururu theme, and the one colour of each that is dropped.
 *
 * It was one theme and two hardcoded hexes: vitesse-dark, with its background
 * swapped for kururu's own so that a code block did not put a second shade of
 * nearly-black inside a pane that already had one. That substitution was right
 * and its constants were not — the moment kururu had five palettes, a block
 * pinned to `#11140f` was a rectangle of the old theme sitting inside the new
 * one, which is the exact bug the CSS token sweep existed to remove and it would
 * have survived the sweep by being on the wrong side of the wire.
 *
 * So the background is replaced with `transparent` rather than with a colour.
 * A block then sits in the page the way a quote does — it takes whatever `--bg`
 * the pane around it has, which is the client's current theme, resolved by the
 * cascade rather than by anything here agreeing with anything there. Each
 * theme's own background is read off the theme rather than written down beside
 * it, so there is no hex in this file to fall out of step.
 *
 * Shiki ships all four Catppuccin flavours, which is what makes the mapping
 * worth having at all: highlighting Catppuccin Mocha markdown in vitesse-dark
 * would be a pane of one palette with a code block of another. Kururu's own
 * theme keeps vitesse-dark, which is what it was designed against.
 */
const SYNTAX: Record<string, { name: string; theme: ThemeRegistration }> = {
  "catppuccin-mocha": { name: "catppuccin-mocha", theme: catppuccinMocha },
  "catppuccin-macchiato": { name: "catppuccin-macchiato", theme: catppuccinMacchiato },
  "catppuccin-frappe": { name: "catppuccin-frappe", theme: catppuccinFrappe },
  "catppuccin-latte": { name: "catppuccin-latte", theme: catppuccinLatte },
  kururu: { name: "vitesse-dark", theme: vitesseDark },
};

const FALLBACK_SYNTAX = "catppuccin-mocha";

/**
 * The colour a theme paints behind its code, so it can be replaced with nothing.
 * Read out of the theme's own `editor.background` because that is where a
 * TextMate theme keeps it; a theme that somehow has none needs no replacement.
 */
function backgroundOf(theme: ThemeRegistration): string | null {
  return theme.colors?.["editor.background"] ?? null;
}

/**
 * Built once and shared, because building it is the expensive part and the
 * result is immutable apart from the grammars it accumulates.
 *
 * The promise is the value rather than the highlighter, so that two panes
 * opening at the same moment await one construction instead of racing to make
 * two. It is deliberately not created at import: a server that nobody asks for
 * markdown should not pay for a highlighter, and `index.ts` is restarted often.
 */
let highlighting: Promise<HighlighterCore> | null = null;

function highlighter(): Promise<HighlighterCore> {
  return (highlighting ??= createHighlighterCore({
    // Every theme, once. They are a few kilobytes each beside a megabyte of
    // grammars, and loading one lazily would mean rebuilding the highlighter
    // the first time somebody changed theme with a reader open.
    themes: Object.values(SYNTAX).map((s) => s.theme),
    langs: LANGS,
    /**
     * Oniguruma, and its wasm inlined rather than loaded from beside the bundle.
     *
     * The pure-JS engine is half a megabyte cheaper and visibly worse: it cannot
     * express some of what a TextMate grammar asks for, so a TypeScript
     * declaration comes back as two spans where this gives seven. The server is
     * a single file on purpose — `desktop/build.mjs` emits one — so the wasm has
     * to travel inside it, which `shiki/wasm` is exactly for.
     */
    engine: createOnigurumaEngine(wasm),
  }));
}

/**
 * Whether a URL may be left as it was written.
 *
 * `javascript:` is the one that matters and `data:` is the one people forget:
 * both are things markdown's link syntax will happily carry, and both end up in
 * an attribute the browser acts on. Everything that is not a scheme at all — a
 * relative path, an anchor — falls through to be rewritten or kept.
 */
function safeAbsolute(url: string): boolean {
  return /^(https?:)?\/\//i.test(url) || url.startsWith("#") || url.startsWith("mailto:");
}

/**
 * A path written next to the markdown file, as a URL that reaches kururu.
 *
 * Relative means relative to the *document*, not to the root, so `../img/a.png`
 * in `docs/guide.md` is `img/a.png` in the project. The join is done here and
 * the result is still checked by `files.ts` on the way back in — this only has
 * to produce the right path, not to be the thing that stops the wrong one.
 */
function fileUrl(root: string, dir: string, target: string): string {
  const rel = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(dir, target));
  const query = new URLSearchParams({ root, path: rel });
  return `/api/file-raw?${query}`;
}

export interface RenderedMarkdown {
  /** The path asked for, echoed so a late answer can be matched to its request. */
  path: string;
  /** What to call it in a tab strip: its first heading, else its file name. */
  title: string;
  html: string;
}

export async function renderMarkdown(
  text: string,
  root: string,
  rel: string,
  /** Which kururu theme is on, so the code matches the pane it lands in. */
  themeId: string,
): Promise<RenderedMarkdown> {
  const shiki = await highlighter();
  const known = new Set(shiki.getLoadedLanguages());
  const syntax = SYNTAX[themeId] ?? SYNTAX[FALLBACK_SYNTAX]!;
  const bg = backgroundOf(syntax.theme);

  const md = MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    /**
     * Unknown languages render as a plain block rather than throwing, because a
     * fence saying ```mermaid is not an error — it is a diagram this reader
     * cannot draw yet, and the text of it is still worth showing.
     */
    highlight: (code, lang) => {
      if (!lang || !known.has(lang.toLowerCase())) return "";
      try {
        return shiki.codeToHtml(code, {
          lang: lang.toLowerCase(),
          theme: syntax.name,
          colorReplacements: bg ? { [bg]: "transparent" } : undefined,
        });
      } catch {
        return "";
      }
    },
  });

  const dir = posix.dirname(rel);
  const base = dir === "." ? "" : dir;

  const rewrite = (tokens: Token[], idx: number, attr: string) => {
    const token = tokens[idx];
    if (!token) return;
    // `attrGet` answers `string | number | null`, because markdown-it lets a
    // plugin set a numeric attribute. Nothing that reaches here is one.
    const value = token.attrGet(attr);
    if (typeof value !== "string" || !value || safeAbsolute(value)) return;
    // Anything left is either a relative path or a scheme this reader will not
    // carry. A path becomes a fetch; a scheme becomes nothing at all, which
    // renders as unlinked text rather than as a link that does something.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) token.attrSet(attr, "");
    else token.attrSet(attr, fileUrl(root, base, value));
  };

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    rewrite(tokens, idx, "src");
    return self.renderToken(tokens, idx, options);
  };
  const defaultLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    rewrite(tokens, idx, "href");
    // Outward links leave the app, and the app is the whole window. `_blank`
    // hands them to the browser the desktop shell opens rather than replacing
    // kururu with the page, which is the same accident `drop.ts` exists to stop.
    const token = tokens[idx];
    if (token && /^(https?:)?\/\//i.test(String(token.attrGet("href") ?? ""))) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noreferrer noopener");
    }
    return defaultLink ? defaultLink(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };

  const heading = /^#{1,6}[ \t]+(.+?)[ \t]*#*$/m.exec(text)?.[1]?.trim();
  return {
    path: rel,
    title: heading || posix.basename(rel) || rel,
    html: md.render(text),
  };
}
