#!/usr/bin/env python3
"""Render the town EditableTilemap to a PNG so agents can SEE placements offline.

Decodes the Phaser tilemap (global GIDs → per-tileset local tiles via firstgid)
and composites the tile layers, then optionally overlays object sprites from the
library at given world coords (bottom-center origin) — a preview for dialing in
placement without the live browser. Optional coordinate grid for picking spots.

Usage:
  python3 render_map.py --map scratch/town_tilemap.json --tilesets DIR --out town.png
        [--grid] [--place sprites/street/red-telephone-box.png:196:404] [--place ...]
"""
import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

# Town layers first, then the interior-map layer names (a map renders whichever
# of these it has, in this order).
RENDER_LAYERS = [
    "ground", "paths", "buildings", "buildingTops", "decorations", "decorationTops",
    "floor", "walls", "furnitures", "furnitureTops",
]
_sheets = {}


def sheet_for(tilesets_dir, name):
    if name == "collisions_objects":
        return "collisions_objects.png"
    for sub in ("exterior", "interior"):
        rel = f"{sub}/{name}.png"
        if os.path.exists(os.path.join(tilesets_dir, rel)):
            return rel
    raise FileNotFoundError(f"tileset sheet not found in exterior/ or interior/: {name}")


def get_sheet(tilesets_dir, name):
    if name not in _sheets:
        _sheets[name] = Image.open(os.path.join(tilesets_dir, sheet_for(tilesets_dir, name))).convert("RGBA")
    return _sheets[name]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True)
    ap.add_argument("--tilesets", required=True)
    ap.add_argument("--lib", default=None, help="object library dir (for --place sprite paths)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--grid", action="store_true")
    ap.add_argument("--place", action="append", default=[], help="spriteRelPath:x:y (world px)")
    ap.add_argument("--zoom", type=int, default=2)
    args = ap.parse_args()

    doc = json.load(open(args.map))
    m = doc.get("data", doc)
    W, H, t = m["width"], m["height"], m["tilewidth"]
    tilesets = sorted(m["tilesets"], key=lambda ts: ts["firstgid"])
    # (firstgid, name, cols) descending firstgid for lookup
    ts_lookup = []
    for ts in tilesets:
        sh = get_sheet(args.tilesets, ts["name"])
        ts_lookup.append((ts["firstgid"], ts["name"], sh.width // t))
    ts_lookup.sort(key=lambda x: x[0], reverse=True)

    canvas = Image.new("RGBA", (W * t, H * t), (0, 0, 0, 0))
    by_name = {l["name"]: l for l in m["layers"]}
    for lname in RENDER_LAYERS:
        layer = by_name.get(lname)
        if not layer:
            continue
        data = layer["data"]
        for idx, gid in enumerate(data):
            if gid <= 0:
                continue
            fg, name, cols = next(x for x in ts_lookup if x[0] <= gid)
            local = gid - fg
            sh = get_sheet(args.tilesets, name)
            sx, sy = (local % cols) * t, (local // cols) * t
            tile = sh.crop((sx, sy, sx + t, sy + t))
            col, row = idx % W, idx // W
            canvas.alpha_composite(tile, (col * t, row * t))

    # Overlay object sprites (bottom-center origin) at world coords.
    for spec in args.place:
        rel, x, y = spec.rsplit(":", 2)
        x, y = int(x), int(y)
        base = args.lib or os.path.dirname(args.map)
        sp = Image.open(os.path.join(base, rel) if not os.path.isabs(rel) else rel).convert("RGBA")
        canvas.alpha_composite(sp, (x - sp.width // 2, y - sp.height))
        d = ImageDraw.Draw(canvas)
        d.rectangle([x - sp.width // 2, y - sp.height, x + sp.width // 2, y], outline=(255, 0, 0, 255))

    if args.zoom > 1:
        canvas = canvas.resize((canvas.width * args.zoom, canvas.height * args.zoom), Image.NEAREST)
    if args.grid:
        d = ImageDraw.Draw(canvas)
        z = args.zoom
        font = ImageFont.load_default(size=11)
        for c in range(0, W + 1, 5):
            x = c * t * z
            d.line([(x, 0), (x, canvas.height)], fill=(255, 255, 0, 90), width=1)
            d.text((x + 2, 2), str(c * t), fill=(255, 255, 0, 220), font=font)
        for r in range(0, H + 1, 5):
            y = r * t * z
            d.line([(0, y), (canvas.width, y)], fill=(255, 255, 0, 90), width=1)
            d.text((2, y + 2), str(r * t), fill=(255, 255, 0, 220), font=font)

    canvas.convert("RGBA").save(args.out)
    print(f"rendered {W}x{H} map @ {args.zoom}x -> {args.out} ({canvas.width}x{canvas.height})")


if __name__ == "__main__":
    main()
