/**
 * Whose pictures the mascots are, for Settings → About → Credits.
 *
 * It exists because some of them are only ours to show with a name on them.
 * OGA-BY and CC BY ask for the author and the source wherever the art is
 * shown, and while the styles registry was alive its install row carried both;
 * when the registry went on 2026-11-09 the credit went with it, and the Fish,
 * the Coffee, the Owlet and the Platypus were left on screen with nobody's
 * name beside them. About is the one page that edits nothing and says what
 * this kururu is made of, so that is where the names went back.
 *
 * Every found picture is here, the CC0 ones included: none of those asks, but
 * "where did this frog come from" is a question with a cheap answer, and a
 * list that only named the art that obliged us would read as grudging.
 *
 * Static data rather than something read off the mascot list, because the list
 * is the owner's config and says nothing about where a sheet came from, and
 * because a credit owed must not disappear when a mascot is renamed. The
 * plants' full licence files sit beside their sheets in `assets/mascots/`;
 * `web/test/credits.test.ts` holds each manifest there to its entry here, and
 * `CREDITS.md` at the root is the same list for somebody reading the repo.
 */

export interface Credit {
  /** The work's title, as its author published it. */
  work: string;
  author: string;
  /** The page it was taken from. */
  source: string;
  /** An SPDX-style id, or `free-commercial-by-author` for a page with no named licence. */
  licence: string;
  /** Kururu's mascots cut from it, by the name they ship with. */
  mascots: string[];
  /** The exact line a licence asks for, when it asks for one. */
  line?: string;
  /** For a page with no named licence: the author's own words, quoted. */
  words?: string;
}

/** The licences by id, as a reader would want them named. */
export const LICENCES: Record<string, { name: string; url?: string; owes: boolean }> = {
  "CC0-1.0": { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", owes: false },
  "OGA-BY-3.0": { name: "OGA-BY 3.0", url: "https://static.opengameart.org/OGA-BY-3.0.txt", owes: true },
  "CC-BY-4.0": { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", owes: true },
  "CC-BY-SA-3.0": { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/", owes: true },
  "free-commercial-by-author": { name: "the author's permission", owes: false },
};

/** Those that ask for a credit first, then the plants, then the rest, each in the order it arrived. */
export const CREDITS: readonly Credit[] = [
  {
    work: "Pixel Predator Plant Mob Character",
    author: "CraftPix.net 2D Game Assets",
    source: "https://opengameart.org/content/pixel-predator-plant-mob-character",
    licence: "OGA-BY-3.0",
    mascots: ["Predator plant"],
    line: "Pixel Predator Plant by CraftPix.net (craftpix.net), OGA-BY 3.0",
  },
  {
    work: "Cute Fish Sprites",
    author: "chips8688",
    source: "https://opengameart.org/content/cute-fish-sprites",
    licence: "OGA-BY-3.0",
    mascots: ["Fish"],
  },
  {
    work: "Static and animated heart mugs",
    author: "Bansexual",
    source: "https://bansexual.itch.io/heart-mug",
    licence: "CC-BY-4.0",
    mascots: ["Coffee"],
    line: "Animated heart mug by Bansexual is licensed under Attribution 4.0 International",
  },
  {
    work: "Owl and Raven Sprites",
    author: "revangale",
    source: "https://opengameart.org/content/owl-and-raven-sprites",
    licence: "CC-BY-SA-3.0",
    mascots: ["Owlet"],
  },
  {
    work: "Platypus concept and sprites",
    author: "p0ss",
    source: "https://opengameart.org/content/platypus-concept-and-sprites",
    licence: "CC-BY-SA-3.0",
    mascots: ["Platypus"],
  },
  {
    work: "Sprout",
    author: "Eddie's Workshop",
    source: "https://eddies-workshop.itch.io/sprout",
    licence: "free-commercial-by-author",
    mascots: ["Sprout"],
    words: "This package can be used freely and commercially Credits are not required but I would appreciate it.",
  },
  {
    work: "Plant Pets",
    author: "Aswino",
    source: "https://opengameart.org/content/plant-pets",
    licence: "CC0-1.0",
    mascots: ["Plant dog", "Plant cat", "Plant parrot"],
  },
  {
    work: "Plant and Mushroom Enemies charset and battlers",
    author: "NettySvit",
    source: "https://opengameart.org/content/plant-and-mushroom-enemies-charset-and-battlers",
    licence: "CC0-1.0",
    mascots: ["Pumpkin", "Chamomile", "Lotus", "Fly agaric", "Nettle", "Herb Paris", "Morel", "Mandrake"],
  },
  {
    work: "Animated Mushroom Monster (Pixel-Art)",
    author: "ScratchIO",
    source: "https://opengameart.org/content/animated-mushroom-monster-pixel-art",
    licence: "CC0-1.0",
    mascots: ["Toadstool"],
  },
  {
    work: "Cute Mushroom Character Sprite",
    author: "CazBee",
    source: "https://caz-bee.itch.io/cute-mushroom-character-sprite",
    licence: "CC0-1.0",
    mascots: ["Mushroom"],
  },
  {
    work: "Cute Shroom Character Sprite",
    author: "CazBee",
    source: "https://caz-bee.itch.io/cute-shroom-character-sprite",
    licence: "CC0-1.0",
    mascots: ["Shroom"],
  },
  {
    work: "Wild Sunflower",
    author: "Hiross",
    source: "https://opengameart.org/content/wild-sunflower",
    licence: "CC0-1.0",
    mascots: ["Sunflower"],
  },
  {
    work: "Wild Plant",
    author: "Hiross",
    source: "https://opengameart.org/content/wild-plant",
    licence: "CC0-1.0",
    mascots: ["Seedling"],
  },
  {
    work: "Wild cactus",
    author: "Hiross",
    source: "https://opengameart.org/content/wild-cactus",
    licence: "CC0-1.0",
    mascots: ["Cactus"],
  },
  {
    work: "Animated Tree 64x64",
    author: "MScull",
    source: "https://opengameart.org/content/animated-tree-64x64",
    licence: "CC0-1.0",
    mascots: ["Tree"],
  },
  {
    work: "Animated tree and water",
    author: "abetusk",
    source: "https://opengameart.org/content/animated-tree-and-water",
    licence: "CC0-1.0",
    mascots: ["Bush"],
  },
  {
    work: "Animated Wild Animals",
    author: "ScratchIO",
    source: "https://opengameart.org/content/animated-wild-animals",
    licence: "CC0-1.0",
    mascots: ["Bear", "Boar", "Deer", "Fox", "Rabbit", "Wolf"],
  },
  {
    work: "Farming Set (Pixel-Art)",
    author: "ScratchIO",
    source: "https://opengameart.org/content/farming-set-pixel-art",
    licence: "CC0-1.0",
    mascots: ["Horse"],
  },
  { work: "Cat sprites", author: "Shepardskin", source: "https://opengameart.org/content/cat-sprites", licence: "CC0-1.0", mascots: ["Cat"] },
  { work: "Dog Spritesheets", author: "Jason of GDN", source: "https://opengameart.org/content/dog-spritesheets", licence: "CC0-1.0", mascots: ["Dog"] },
  { work: "Flame creature", author: "takeshi", source: "https://opengameart.org/content/flame-creature", licence: "CC0-1.0", mascots: ["Flame"] },
  {
    work: "Animated Birds (32x32)",
    author: "MoikMellah",
    source: "https://opengameart.org/content/animated-birds-32x32",
    licence: "CC0-1.0",
    mascots: ["Gull", "Hawk"],
  },
  { work: "Bird", author: "rmazanek", source: "https://opengameart.org/content/bird-2", licence: "CC0-1.0", mascots: ["Songbird"] },
  {
    work: "Swimming Whale",
    author: "Mepavi @ You're Perfect Studio",
    source: "https://opengameart.org/content/swimming-whale",
    licence: "CC0-1.0",
    mascots: ["Whale"],
  },
  {
    work: "monkey swing",
    author: "woodsmoke",
    source: "https://opengameart.org/node/114636",
    licence: "CC0-1.0",
    mascots: ["Kaipago monkey", "Grey monkey"],
  },
];
