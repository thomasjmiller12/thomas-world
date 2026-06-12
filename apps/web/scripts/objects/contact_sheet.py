#!/usr/bin/env python3
"""Build labeled contact-sheet montages of the cropped object sprites.

One PNG per category under <lib>/_contact/<category>.png — each cell shows the
sprite (integer-upscaled to fit) + its name, so a human can review crop quality
and naming at a glance and curate the catalog.

Usage:
  python3 contact_sheet.py --lib DIR [--cols 8] [--cell 96]
"""
import argparse
import json
import os
from collections import defaultdict
from PIL import Image, ImageDraw, ImageFont

BG = (28, 28, 34, 255)
CELL_BG = (44, 44, 54, 255)
TXT = (230, 230, 235, 255)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", required=True)
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--cell", type=int, default=104)
    args = ap.parse_args()

    sprites = json.load(open(os.path.join(args.lib, "_sprites.json")))["sprites"]
    by_cat = defaultdict(list)
    for s in sprites:
        by_cat[s["category"]].append(s)

    out_dir = os.path.join(args.lib, "_contact")
    os.makedirs(out_dir, exist_ok=True)
    font = ImageFont.load_default(size=11)
    cell, cols = args.cell, args.cols
    art = cell - 24  # space for art above the label strip

    for cat, items in sorted(by_cat.items()):
        items.sort(key=lambda s: s["name"])
        rows = (len(items) + cols - 1) // cols
        W, H = cols * cell, rows * cell
        sheet = Image.new("RGBA", (W, H), BG)
        d = ImageDraw.Draw(sheet)
        for i, s in enumerate(items):
            cx, cy = (i % cols) * cell, (i // cols) * cell
            d.rectangle([cx + 1, cy + 1, cx + cell - 2, cy + cell - 2], fill=CELL_BG)
            im = Image.open(os.path.join(args.lib, s["file"])).convert("RGBA")
            scale = max(1, min((art) // max(1, im.width), (art) // max(1, im.height)))
            im2 = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
            ox = cx + (cell - im2.width) // 2
            oy = cy + 2 + (art - im2.height) // 2
            sheet.alpha_composite(im2, (max(cx + 2, ox), max(cy + 2, oy)))
            label = s["name"] if len(s["name"]) <= 18 else s["name"][:17] + "…"
            d.text((cx + 3, cy + cell - 21), label, fill=TXT, font=font)
            d.text((cx + 3, cy + cell - 11), f'{s["tiles"]["w"]}x{s["tiles"]["h"]}'
                   + (" ⛒" if s["collides"] else ""), fill=(150, 150, 160, 255), font=font)
        sheet.save(os.path.join(out_dir, f"{cat}.png"))
        print(f"  {cat}: {len(items)} -> _contact/{cat}.png ({W}x{H})")
    print(f"contact sheets -> {out_dir}/")


if __name__ == "__main__":
    main()
