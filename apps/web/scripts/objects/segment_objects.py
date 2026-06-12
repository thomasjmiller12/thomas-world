#!/usr/bin/env python3
"""Deterministically segment a LimeZu sheet into object candidates.

LimeZu sheets separate objects with transparent pixels, so connected-component
labeling on the alpha mask yields pixel-perfect object boxes — no vision, no
clipping, no duplicates. We snap each component to the 16px tile grid (objects
are tile-placed), crop it, and lay all crops into NUMBERED montages so a cheap
vision pass only has to NAME each clean candidate (not box it).

Outputs under <out>/:
  candidates.json      [{id, col,row,w,h, pxw,pxh}]   (tile-snapped boxes)
  crops/<id>.png       per-candidate trimmed sprite
  montage_<n>.png      numbered grids for the naming workflow

Usage:
  python3 segment_objects.py INPUT.png --out DIR [--tile 16] [--min-side 8]
          [--min-area 120] [--dilate 1] [--per-montage 36] [--cols 6] [--cell 120]
"""
import argparse
import json
import math
import os
import numpy as np
from scipy import ndimage
from PIL import Image, ImageDraw, ImageFont


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sheet-rel", default=None, help="sheet path stored in candidates (rel to tilesets)")
    ap.add_argument("--tile", type=int, default=16)
    ap.add_argument("--min-side", type=int, default=8, help="drop components thinner than this (px)")
    ap.add_argument("--min-area", type=int, default=120, help="drop components smaller than this (px^2)")
    ap.add_argument("--dilate", type=int, default=1, help="close N-px gaps before labeling")
    ap.add_argument("--per-montage", type=int, default=36)
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--cell", type=int, default=120)
    args = ap.parse_args()

    im = Image.open(args.input).convert("RGBA")
    arr = np.array(im)
    mask = arr[:, :, 3] > 16
    if args.dilate:
        mask = ndimage.binary_dilation(mask, iterations=args.dilate)
    structure = np.ones((3, 3), dtype=bool)  # 8-connectivity keeps diagonal parts together
    lab, n = ndimage.label(mask, structure=structure)
    slices = ndimage.find_objects(lab)

    t = args.tile
    os.makedirs(os.path.join(args.out, "crops"), exist_ok=True)
    candidates = []
    cid = 0
    for sl in slices:
        if sl is None:
            continue
        y0, y1 = sl[0].start, sl[0].stop
        x0, x1 = sl[1].start, sl[1].stop
        pw, ph = x1 - x0, y1 - y0
        if pw < args.min_side or ph < args.min_side or pw * ph < args.min_area:
            continue
        # Snap to whole tiles (objects are tile-placed).
        c0, r0 = x0 // t, y0 // t
        c1, r1 = math.ceil(x1 / t), math.ceil(y1 / t)
        w, h = c1 - c0, r1 - r0
        if w > 14 or h > 16:  # implausibly large single object — likely merged terrain
            continue
        crop = im.crop((c0 * t, r0 * t, c1 * t, r1 * t))
        bbox = crop.getbbox()
        if bbox is None:
            continue
        tight = crop.crop(bbox)
        tight.save(os.path.join(args.out, "crops", f"{cid:04d}.png"))
        candidates.append({"id": cid, "col": c0, "row": r0, "w": w, "h": h,
                           "pxw": tight.width, "pxh": tight.height})
        cid += 1

    sheet_rel = args.sheet_rel or os.path.basename(args.input)
    with open(os.path.join(args.out, "candidates.json"), "w") as f:
        json.dump({"sheet": sheet_rel, "tile": t, "count": len(candidates),
                   "candidates": candidates}, f, indent=2)

    # Numbered montages for the naming pass.
    font = ImageFont.load_default(size=15)
    cols, cell, per = args.cols, args.cell, args.per_montage
    art = cell - 20
    montages = []
    for m, start in enumerate(range(0, len(candidates), per)):
        chunk = candidates[start:start + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGBA", (cols * cell, rows * cell), (26, 26, 32, 255))
        d = ImageDraw.Draw(sheet)
        for i, cand in enumerate(chunk):
            cx, cy = (i % cols) * cell, (i // cols) * cell
            d.rectangle([cx + 1, cy + 1, cx + cell - 2, cy + cell - 2], fill=(46, 46, 56, 255))
            im2 = Image.open(os.path.join(args.out, "crops", f"{cand['id']:04d}.png")).convert("RGBA")
            sc = max(1, min(art // max(1, im2.width), art // max(1, im2.height)))
            im2 = im2.resize((im2.width * sc, im2.height * sc), Image.NEAREST)
            sheet.alpha_composite(im2, (cx + (cell - im2.width) // 2, cy + 18 + (art - im2.height) // 2))
            d.rectangle([cx + 1, cy + 1, cx + 34, cy + 16], fill=(20, 110, 200, 255))
            d.text((cx + 4, cy + 2), f"#{cand['id']}", fill=(255, 255, 255, 255), font=font)
        name = f"montage_{m:02d}.png"
        sheet.save(os.path.join(args.out, name))
        montages.append({"file": os.path.abspath(os.path.join(args.out, name)),
                         "ids": [c["id"] for c in chunk]})

    with open(os.path.join(args.out, "montages.json"), "w") as f:
        json.dump({"montages": montages}, f, indent=2)
    print(f"{sheet_rel}: {n} components -> {len(candidates)} candidates, {len(montages)} montages -> {args.out}/")


if __name__ == "__main__":
    main()
