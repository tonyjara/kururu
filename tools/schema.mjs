/**
 * `../kururu-styles/schema/tokens.json`, from kururu's own source.
 *
 *     bun tools/schema.mjs
 *
 * The registry checks a pull request against a *copy* of kururu's token
 * vocabulary rather than against kururu itself, so that it can validate on a
 * machine with nothing else checked out. That copy is this file's output, and
 * the rule in both repositories' briefs is the same: a token is added to
 * `shared/skin.ts` or `shared/theme.ts` here first, and then this is run to
 * publish it there. Hand-editing the schema makes the validator stop catching a
 * mistake without making kururu draw anything.
 *
 * Bun rather than Node because the vocabulary lives in TypeScript and this is
 * the one script in `tools/` that has to import it. Everything it writes is a
 * list of names — nothing about what a token means travels, because the
 * registry's job is to say whether a name is one kururu answers for, not what
 * the answer is.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_NAMES, PAINT_MODES, PAINT_REPEATS, PART_NAMES, skinFor } from "../shared/skin.ts";
import { themeFor } from "../shared/theme.ts";
import { SOUND_FORMATS, STYLES_SCHEMA } from "../shared/styles.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "..", "kururu-styles", "schema", "tokens.json");

const theme = themeFor(null);
const skin = skinFor(null);

const schema = {
  schema: STYLES_SCHEMA,
  note: "The token vocabulary kururu answers for at schema 1. Generated from kururu shared/theme.ts and shared/skin.ts by `bun tools/schema.mjs`; see README.",
  theme: {
    ui: Object.keys(theme.ui),
    terminal: Object.keys(theme.terminal),
    workspace: Object.keys(theme.workspace),
    appearance: ["dark", "light"],
  },
  skin: {
    tokens: Object.keys(skin.tokens),
    icons: [...ICON_NAMES],
    /** The regions a skin may paint with a picture — see `PARTS` in shared/skin.ts. */
    parts: [...PART_NAMES],
    paintModes: [...PAINT_MODES],
    paintRepeats: [...PAINT_REPEATS],
    iconSheetModes: ["mask", "image"],
    /** The chrome colours a skin may override: the theme's `ui` block, by name. */
    colors: Object.keys(theme.ui),
  },
  /**
   * What a sound entry may ship. Narrower than what `server/src/sounds.ts` will
   * play, because a registry entry is downloaded to every machine kururu runs on
   * and has to decode without `afconvert` — see `SOUND_FORMATS`.
   */
  sound: {
    formats: [...SOUND_FORMATS],
  },
};

writeFileSync(OUT, `${JSON.stringify(schema, null, 2)}\n`);
console.log(
  `${OUT}: ${schema.skin.tokens.length} skin tokens, ${schema.skin.parts.length} parts, ` +
    `${schema.theme.ui.length} ui colours, ${schema.sound.formats.length} sound formats`,
);
