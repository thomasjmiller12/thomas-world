#!/usr/bin/env python3
"""Crop individual named object sprites out of the LimeZu sheets.

Reads a catalog of authored object definitions (name, category, source tile
rect) — typically produced by the inventory workflow — and crops each object
into its own labeled PNG under sprites/<category>/<name>.png. Optionally
auto-trims fully-transparent borders (default on) so a slightly-generous box
from a vision agent still yields a tightly-bounded sprite.

catalog.json shape:
  { "objects": [
      { "name": "red-telephone-box", "category": "street",
        "source": {"sheet": "exterior/3_City_Props_16x16.png",
                   "col": 28, "row": 12, "w": 3, "h": 7},
        "collides": true, "tags": ["phone"], "trim": true }, ... ] }

Writes sprites + a _sprites.json index (name -> file, pixel size, trim insets,
tile footprint, collides, tags) consumed by pack_atlas.py.

Usage:
  python3 crop_objects.py --catalog catalog.json --tilesets DIR --out DIR [--tile 16]
"""
import argparse
import json
import os
from PIL import Image

_cache: dict[str, Image.Image] = {}


def sheet(tilesets_dir: str, rel: str) -> Image.Image:
    if rel not in _cache:
        _cache[rel] = Image.open(os.path.join(tilesets_dir, rel)).convert("RGBA")
    return _cache[rel]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--tilesets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tile", type=int, default=16)
    args = ap.parse_args()

    with open(args.catalog) as f:
        catalog = json.load(f)
    t = args.tile
    index = []
    skipped = []
    for obj in catalog["objects"]:
        src = obj["source"]
        img = sheet(args.tilesets, src["sheet"])
        x0, y0 = src["col"] * t, src["row"] * t
        x1, y1 = x0 + src["w"] * t, y0 + src["h"] * t
        if x1 > img.width or y1 > img.height:
            skipped.append({"name": obj["name"], "reason": "rect out of bounds"})
            continue
        crop = img.crop((x0, y0, x1, y1))
        insets = [0, 0, 0, 0]
        if obj.get("trim", True):
            bbox = crop.getbbox()
            if bbox is None:
                skipped.append({"name": obj["name"], "reason": "fully transparent"})
                continue
            insets = [bbox[0], bbox[1], crop.width - bbox[2], crop.height - bbox[3]]
            crop = crop.crop(bbox)

        cat_dir = os.path.join(args.out, "sprites", obj["category"])
        os.makedirs(cat_dir, exist_ok=True)
        fname = f"{obj['name']}.png"
        crop.save(os.path.join(cat_dir, fname))
        index.append({
            "name": obj["name"],
            "category": obj["category"],
            "file": f"sprites/{obj['category']}/{fname}",
            "px": {"w": crop.width, "h": crop.height},
            "tiles": {"w": round(crop.width / t, 2), "h": round(crop.height / t, 2)},
            "trimInsets": insets,
            "collides": obj.get("collides", False),
            "tags": obj.get("tags", []),
            "source": src,
        })

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "_sprites.json"), "w") as f:
        json.dump({"sprites": index, "skipped": skipped}, f, indent=2)
    print(f"cropped {len(index)} sprites, skipped {len(skipped)} -> {args.out}/sprites/")
    for s in skipped:
        print("  SKIP", s["name"], "—", s["reason"])


if __name__ == "__main__":
    main()
