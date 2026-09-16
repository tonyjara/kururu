/**
 * The frog, as the icon every surface of kururu is found by.
 *
 * Kururu is Guaraní for frog and the badge in the sidebar has been one since the
 * mascot existed, so the app arriving in the Dock as a stock Electron circle was
 * the one place the name was not being kept. What this generates is that same
 * sprite — one cell of `assets/spritesheets/green.png`, the sitting pose — cut
 * out, scaled by whole numbers onto a plate, and written as everything macOS and
 * a browser ask for.
 *
 * It is a tool and not a build step, and the outputs are committed. A favicon
 * that depends on a generator having run is a favicon that is missing from a
 * checkout somebody cloned, and the picture only changes on the afternoon
 * somebody draws a new frog. Run `bun run icon` then; the rest of the time this
 * file is documentation of where the artwork came from.
 *
 * The cell is named here rather than read from `~/.config/kururu/mascot.json`,
 * and that is the decision worth defending. The mascot is a *setting* — pick the
 * cat and your sidebar is cats — but an app's icon is what it is recognised by
 * in a Dock, and an identity that changed when somebody browsed the picker would
 * be a bug wearing a feature's clothes. So the icon is the frog kururu is named
 * after, permanently, and Settings cannot reach it.
 *
 * Everything below is done by hand against `node:zlib` because the alternative
 * is a native image dependency in the root of a project that has none, for a
 * script that resizes one 17-pixel frog. A PNG is a handful of chunks and a
 * scanline filter; the decoder here understands exactly the two colour types our
 * own sheet can be and says so plainly about anything else.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The sheet, and the one cell of it that is the logo. Row 7, column 0: sitting. */
const SHEET = join(ROOT, "assets/spritesheets/green.png");
const CELL = 32;
const POSE = { row: 7, col: 0 };

/**
 * The plate is `chrome` from the kururu theme rather than `bg`, because an icon
 * sits on a wallpaper and not on the app's own background: the slightly lighter
 * surface keeps an edge against a black desktop, and the frog's own outline
 * keeps it against a white one.
 */
const PLATE = "#141817";

/**
 * How much of the plate the frog is across, and the margin macOS draws its own
 * icons in: 100 units of 1024, with a squircle rather than a circular corner —
 * hence the superellipse below rather than a rounded rectangle.
 */
const FILL = 0.78;
const INSET = 100 / 1024;
const CORNER = 5;

/**
 * Below this the integer scaling is what breaks, not the picture. The sprite is
 * 17 pixels across, so a 32-pixel icon can only take it at 1x — half the canvas,
 * a frog swimming in a plate — and there is no smaller whole number. Under the
 * floor we downscale the 1024 master instead, which is blurrier and the right
 * shape, and is also exactly what macOS would do to a bigger icon at that size.
 */
const CRISP = 0.6;

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/** An image is a width, a height and straight (never premultiplied) RGBA. */
function image(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.depth !== 8 || header.interlace !== 0 || (header.colour !== 2 && header.colour !== 6)) {
    throw new Error(
      `${SHEET}: expected an 8-bit RGB or RGBA PNG, got depth ${header.depth} colour type ${header.colour}` +
        (header.interlace ? " (interlaced)" : ""),
    );
  }

  const bpp = header.colour === 6 ? 4 : 3;
  const stride = header.width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = image(header.width, header.height);
  // Scanline filters are defined against the *reconstructed* row above, so the
  // previous row has to be kept as it comes out rather than as it arrived.
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = previous[i];
      const c = i >= bpp ? previous[i - bpp] : 0;
      if (filter === 1) row[i] = (row[i] + a) & 0xff;
      else if (filter === 2) row[i] = (row[i] + b) & 0xff;
      else if (filter === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) row[i] = (row[i] + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} on row ${y}`);
    }
    for (let x = 0; x < header.width; x++) {
      const at = (y * header.width + x) * 4;
      out.data[at] = row[x * bpp];
      out.data[at + 1] = row[x * bpp + 1];
      out.data[at + 2] = row[x * bpp + 2];
      out.data[at + 3] = bpp === 4 ? row[x * bpp + 3] : 255;
    }
    previous = row;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function encodePng(img) {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

function crop(img, x, y, width, height) {
  const out = image(width, height);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * img.width + x) * 4;
    img.data.copy(out.data, row * width * 4, from, from + width * 4);
  }
  return out;
}

/** The tight box of everything that is not fully transparent. */
function opaqueBox(img) {
  let left = img.width;
  let top = img.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) throw new Error("the chosen cell is empty");
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Nearest neighbour at a whole number, which is the only honest way to enlarge this. */
function scale(img, factor) {
  const out = image(img.width * factor, img.height * factor);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      img.data.copy(out.data, (y * out.width + x) * 4, from, from + 4);
    }
  }
  return out;
}

/**
 * A box filter, averaging in premultiplied alpha and dividing back out.
 *
 * Averaging straight RGBA would pull the colour of transparent pixels into the
 * edge — and the transparent pixels of a cut-out sprite are black, so the frog
 * would come back with a dark fringe all the way round exactly where it is
 * meant to meet the plate.
 */
function downscale(img, size) {
  const out = image(size, size);
  const step = img.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y * step); sy < Math.floor((y + 1) * step); sy++) {
        for (let sx = Math.floor(x * step); sx < Math.floor((x + 1) * step); sx++) {
          const at = (sy * img.width + sx) * 4;
          const alpha = img.data[at + 3] / 255;
          r += img.data[at] * alpha;
          g += img.data[at + 1] * alpha;
          b += img.data[at + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const to = (y * size + x) * 4;
      if (a > 0) {
        out.data[to] = Math.round(r / a);
        out.data[to + 1] = Math.round(g / a);
        out.data[to + 2] = Math.round(b / a);
      }
      out.data[to + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/** Straight-alpha source over destination. Everything here composites onto a plate. */
function over(base, top, x, y) {
  for (let row = 0; row < top.height; row++) {
    for (let column = 0; column < top.width; column++) {
      const from = (row * top.width + column) * 4;
      const alpha = top.data[from + 3] / 255;
      if (alpha === 0) continue;
      const to = ((y + row) * base.width + (x + column)) * 4;
      for (let c = 0; c < 3; c++) {
        base.data[to + c] = Math.round(top.data[from + c] * alpha + base.data[to + c] * (1 - alpha));
      }
      base.data[to + 3] = Math.round((alpha + (base.data[to + 3] / 255) * (1 - alpha)) * 255);
    }
  }
}

/**
 * The plate: a superellipse, not a rounded rectangle.
 *
 * macOS corners are continuous — the curvature ramps in rather than meeting the
 * straight edge at a tangent — and `|x|^5 + |y|^5 = 1` is close enough that the
 * icon sits in a Dock beside Apple's own without looking like it was drawn by a
 * different rule. Coverage is measured by sampling, but only for the pixels the
 * curve actually crosses: the corners of a pixel agreeing with each other is the
 * cheap test, and it is true of everything except a one-pixel ring.
 */
function plate(size, inset, colour) {
  const out = image(size, size);
  const [r, g, b] = colour;

  // No margin means no corner either. A home-screen icon is masked by iOS to
  // whatever shape that iOS is drawing this year, and a picture that has already
  // rounded itself shows its own curve sitting inside Apple's.
  if (inset === 0) {
    for (let at = 0; at < out.data.length; at += 4) {
      out.data[at] = r;
      out.data[at + 1] = g;
      out.data[at + 2] = b;
      out.data[at + 3] = 255;
    }
    return out;
  }

  const margin = Math.round(size * inset);
  const centre = size / 2;
  const half = (size - 2 * margin) / 2;
  const inside = (x, y) => {
    const u = Math.abs(x - centre) / half;
    const v = Math.abs(y - centre) / half;
    return u * u * u * u * u + v * v * v * v * v <= 1;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const corners =
        inside(x, y) + inside(x + 1, y) + inside(x, y + 1) + inside(x + 1, y + 1);
      let alpha;
      if (corners === 4) alpha = 1;
      else if (corners === 0) alpha = 0;
      else {
        let hits = 0;
        for (let sy = 0; sy < 8; sy++) {
          for (let sx = 0; sx < 8; sx++) {
            if (inside(x + (sx + 0.5) / 8, y + (sy + 0.5) / 8)) hits++;
          }
        }
        alpha = hits / 64;
      }
      if (alpha === 0) continue;
      const at = (y * size + x) * 4;
      out.data[at] = r;
      out.data[at + 1] = g;
      out.data[at + 2] = b;
      out.data[at + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

function hex(value) {
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
}

// ---------------------------------------------------------------------------
// The icon
// ---------------------------------------------------------------------------

const frog = (() => {
  const sheet = decodePng(readFileSync(SHEET));
  const cell = crop(sheet, POSE.col * CELL, POSE.row * CELL, CELL, CELL);
  const box = opaqueBox(cell);
  return crop(cell, box.x, box.y, box.width, box.height);
})();

const masters = new Map();

/**
 * One icon at one size.
 *
 * `bleed` is the difference between the two places this ends up. A `.icns` is
 * drawn by macOS with its own margin expected inside the picture, so the plate
 * is inset and the corners are cut here. A favicon and a home-screen icon are
 * the opposite: iOS masks the square itself and will composite anything it finds
 * transparent onto a colour of its choosing, so those are edge to edge with the
 * rounding left to whoever is drawing them.
 *
 * The frog is wider than it is tall — 17 by 12 — so it letterboxes in a square
 * and is centred rather than sat on a baseline. A baseline looks right on the
 * one sprite and wrong the moment the pose changes.
 */
function icon(size, { bleed = false } = {}) {
  const inset = bleed ? 0 : INSET;
  const body = size - 2 * Math.round(size * inset);
  const factor = Math.max(1, Math.round((body * FILL) / frog.width));
  const drawn = frog.width * factor;

  if (drawn > body || drawn / size < CRISP) {
    const key = bleed ? "bleed" : "plate";
    if (!masters.has(key)) masters.set(key, icon(1024, { bleed }));
    return downscale(masters.get(key), size);
  }

  const canvas = plate(size, inset, hex(PLATE));
  const sprite = scale(frog, factor);
  over(canvas, sprite, Math.round((size - sprite.width) / 2), Math.round((size - sprite.height) / 2));
  return canvas;
}

function write(path, img) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, encodePng(img));
  console.log(`  ${path} (${img.width}x${img.height})`);
}

console.log(`frog: ${frog.width}x${frog.height} from ${POSE.row},${POSE.col} of green.png`);

/**
 * The web's three, and what each is for. A 32 is what a tab asks for and is
 * sharp enough on a retina one; 180 is what iOS puts on a home screen, where it
 * must be opaque to the edges; 512 is the manifest's, which is what Android
 * installs and what anything else scales from.
 */
write("web/public/favicon-32.png", icon(32, { bleed: true }));
write("web/public/apple-touch-icon.png", icon(180, { bleed: true }));
write("web/public/icon-512.png", icon(512, { bleed: true }));

/** The window's own, which is what Linux and Windows draw; macOS ignores it and uses the bundle. */
write("desktop/icon/icon-1024.png", icon(1024));

/**
 * And the bundle's. `iconutil` ships with macOS and is the only thing that
 * writes a `.icns` anybody trusts, so the iconset is built as a directory and
 * handed to it — and removed again, because it is a hundred kilobytes of the
 * same ten pictures that are already inside the file it produced.
 */
if (process.platform === "darwin") {
  const iconset = join(ROOT, "desktop/icon/kururu.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), encodePng(icon(base)));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), encodePng(icon(base * 2)));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(ROOT, "desktop/icon/kururu.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("  desktop/icon/kururu.icns");
} else {
  console.log("  skipping desktop/icon/kururu.icns: iconutil is macOS only");
}
