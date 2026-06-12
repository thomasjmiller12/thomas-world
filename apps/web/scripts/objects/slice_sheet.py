#!/usr/bin/env python3
"""Slice a LimeZu tileset PNG into labeled, upscaled inspection blocks.

The raw sheets are huge (e.g. 3_City_Props is 32x224 = 7,168 tiles) and a single
downscaled image is unreadable at 16px tile resolution. This cuts a sheet into
blocks of `--block-rows` rows (full width by default), upscales each block with
NEAREST (pixel-crisp, no blur), and burns a tile grid + absolute tile-index
labels into the margins so a vision agent can report objects in ABSOLUTE tile
coordinates (col,row,w,h) that map straight back to the source sheet.

Output: <out>/c{col0}_r{row0}.png  +  <out>/_blocks.json (block -> tile range).

Usage:
  python3 slice_sheet.py INPUT.png --out DIR [--tile 16] [--block-rows 16]
                         [--block-cols 0] [--scale 6]
"""
import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

GRID_FAINT = (120, 120, 140, 255)
GRID_BOLD = (235, 90, 90, 255)
LABEL = (255, 255, 255, 255)
BG = (34, 34, 42, 255)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tile", type=int, default=16)
    ap.add_argument("--block-rows", type=int, default=16)
    ap.add_argument("--block-cols", type=int, default=0, help="0 = full width")
    ap.add_argument("--overlap-rows", type=int, default=0,
                    help="rows shared between vertically-adjacent blocks so tall "
                         "objects are fully visible in at least one block")
    ap.add_argument("--scale", type=int, default=6)
    ap.add_argument("--margin", type=int, default=30, help="label margin in px")
    args = ap.parse_args()

    img = Image.open(args.input).convert("RGBA")
    w, h = img.size
    t = args.tile
    cols, rows = w // t, h // t
    bcols = args.block_cols or cols
    brows = args.block_rows
    s = args.scale
    m = args.margin
    os.makedirs(args.out, exist_ok=True)
    font = ImageFont.load_default(size=max(13, s * 2))

    rstep = max(1, brows - args.overlap_rows)
    if rows <= brows:
        row_starts = [0]
    else:
        row_starts = list(range(0, rows - brows + 1, rstep))
        if row_starts[-1] != rows - brows:
            row_starts.append(rows - brows)  # bottom-align the final block

    blocks = []
    for r0 in row_starts:
        for c0 in range(0, cols, bcols):
            r1, c1 = min(r0 + brows, rows), min(c0 + bcols, cols)
            sub = img.crop((c0 * t, r0 * t, c1 * t, r1 * t))
            sw, sh = (c1 - c0) * t * s, (r1 - r0) * t * s
            sub = sub.resize((sw, sh), Image.NEAREST)

            canvas = Image.new("RGBA", (sw + m, sh + m), BG)
            canvas.paste(sub, (m, m))
            d = ImageDraw.Draw(canvas)

            for cc in range(c0, c1 + 1):
                x = m + (cc - c0) * t * s
                bold = cc % 4 == 0
                d.line([(x, m), (x, sh + m)], fill=GRID_BOLD if bold else GRID_FAINT,
                       width=2 if bold else 1)
                if cc % 2 == 0 and cc < c1:
                    d.text((x + 3, 4), str(cc), fill=LABEL, font=font)
            for rr in range(r0, r1 + 1):
                y = m + (rr - r0) * t * s
                bold = rr % 4 == 0
                d.line([(m, y), (sw + m, y)], fill=GRID_BOLD if bold else GRID_FAINT,
                       width=2 if bold else 1)
                if rr % 2 == 0 and rr < r1:
                    d.text((3, y + 3), str(rr), fill=LABEL, font=font)

            name = f"c{c0:03d}_r{r0:03d}.png"
            canvas.save(os.path.join(args.out, name))
            blocks.append({"file": name, "col0": c0, "row0": r0, "col1": c1, "row1": r1})

    with open(os.path.join(args.out, "_blocks.json"), "w") as f:
        json.dump({"sheet": os.path.basename(args.input), "cols": cols, "rows": rows,
                   "tile": t, "scale": s, "blocks": blocks}, f, indent=2)
    print(f"{os.path.basename(args.input)}: {cols}x{rows} tiles -> {len(blocks)} blocks @ {s}x in {args.out}")


if __name__ == "__main__":
    main()
