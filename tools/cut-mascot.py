#!/usr/bin/env python3
"""
Cut one animation out of a frog sprite sheet into a mascot strip.

This is an authoring tool, not part of the build — it exists so the strips in
`assets/mascots/` can be traced back to the sheets in `assets/spritesheets/`
rather than being pixels nobody can account for. Run it when you want a
different animation, a different facing, or a palette that was not cut before.

The sheets are a 16x16 grid of 32px cells. Rows are the eight facings, twice
over; columns are the animations, which `assets/spritesheets/guide.png` labels:

    idle  0-2      croak 3-6      jump 7-10      hop 11-15
    shock/hurt     rows 8-15, columns 0-4

Kururu's runtime contract is deliberately simpler than any of that — a mascot is
a horizontal strip of square frames, and nothing else needs saying, because the
frame count is the width over the height. So this does the cutting once, here,
and what ships is a strip that describes itself.

The crop is the union of the chosen frames' bounding boxes, widened to a square.
It has to be one box for all of them: the frog's *height in the cell* is how the
sheet draws the jump, and trimming each frame to its own content would land every
one of them on the floor and throw the animation away.

    python3 tools/cut-mascot.py                 # re-cut every palette, jumping
    python3 tools/cut-mascot.py --anim hop --row 2

Needs Pillow, which is not a dependency of kururu — it is a dependency of
changing the artwork, which is a thing that happens approximately never.
"""

import argparse
import pathlib
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("this tool needs Pillow: pip install Pillow")

CELL = 32
# First column of each animation in the sheet, and how many frames it runs for.
ANIMATIONS = {
    "idle": (0, 3),
    "croak": (3, 4),
    "jump": (7, 4),
    "hop": (11, 5),
    "shock": (0, 5),
}

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHEETS = ROOT / "assets" / "spritesheets"
OUT = ROOT / "assets" / "mascots"


def cut(sheet: Image.Image, row: int, col: int, count: int) -> Image.Image:
    frames = [
        sheet.crop(((col + i) * CELL, row * CELL, (col + i) * CELL + CELL, row * CELL + CELL))
        for i in range(count)
    ]

    # One box for every frame, so the arc of the jump survives the crop.
    union = Image.new("RGBA", (CELL, CELL))
    for frame in frames:
        union.alpha_composite(frame)
    box = union.getbbox()
    if box is None:
        raise SystemExit(f"row {row}, columns {col}..{col + count - 1} are empty")
    left, top, right, bottom = box

    # Square it up, because "a strip of square frames" is the whole contract and
    # a frame that is taller than it is wide would make the frame count a lie.
    side = max(right - left, bottom - top)
    left -= (side - (right - left)) // 2
    top -= side - (bottom - top)  # grow upwards: the frog stands on the floor
    left, top = max(0, min(left, CELL - side)), max(0, min(top, CELL - side))

    strip = Image.new("RGBA", (side * count, side), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        strip.paste(frame.crop((left, top, left + side, top + side)), (i * side, 0))
    return strip


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--anim", default="jump", choices=sorted(ANIMATIONS))
    parser.add_argument("--row", type=int, default=1, help="facing, 0-7 (1 is three-quarter right)")
    parser.add_argument("--sheet", help="one sheet by name; default is all of them")
    args = parser.parse_args()

    col, count = ANIMATIONS[args.anim]
    row = args.row + 8 if args.anim == "shock" else args.row
    OUT.mkdir(parents=True, exist_ok=True)

    sheets = sorted(SHEETS.glob(f"{args.sheet}.png" if args.sheet else "*.png"))
    for path in sheets:
        if path.stem == "guide":
            continue
        strip = cut(Image.open(path).convert("RGBA"), row, col, count)
        out = OUT / f"frog-{path.stem}.png"
        strip.save(out, optimize=True)
        print(f"{out.relative_to(ROOT)}  {strip.width}x{strip.height}  {count} frames")


if __name__ == "__main__":
    main()
