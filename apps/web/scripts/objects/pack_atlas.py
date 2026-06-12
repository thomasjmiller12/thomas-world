#!/usr/bin/env python3
"""Pack individual object sprites into per-category Phaser texture atlases.

Reads _sprites.json (from crop_objects.py), packs each category's sprites into
one atlas PNG via a simple height-sorted shelf packer, and emits the Phaser
JSON-Hash atlas alongside it (loadable with `this.load.atlas(key, png, json)`,
frame access by object name). Also emits a top-level library.json — the
runtime/contract-facing manifest mapping object name -> {category, atlas, frame,
px, tiles, collides, tags} — the single shared vocabulary for the drop-in helper
and the future fixtures model.

Individual PNGs remain the editable source of truth; atlases are the generated
runtime artifact. Re-run after any sprite changes.

Usage:
  python3 pack_atlas.py --lib DIR [--pad 1] [--max-width 1024]
"""
import argparse
import json
import math
import os
from PIL import Image


def shelf_pack(items, pad, max_width):
    """items: [(name, Image)] -> (placements{name:(x,y,w,h)}, atlas_w, atlas_h)."""
    ordered = sorted(items, key=lambda it: it[1].height, reverse=True)
    placements = {}
    x = y = shelf_h = 0
    atlas_w = 0
    for name, im in ordered:
        w, h = im.width + pad, im.height + pad
        if x + w > max_width and x > 0:
            x = 0
            y += shelf_h
            shelf_h = 0
        placements[name] = (x, y, im.width, im.height)
        x += w
        shelf_h = max(shelf_h, h)
        atlas_w = max(atlas_w, x)
    atlas_h = y + shelf_h
    return placements, atlas_w, atlas_h


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", required=True, help="object library dir")
    ap.add_argument("--pad", type=int, default=1)
    ap.add_argument("--max-width", type=int, default=1024)
    args = ap.parse_args()

    with open(os.path.join(args.lib, "_sprites.json")) as f:
        sprites = json.load(f)["sprites"]

    by_cat: dict[str, list] = {}
    for s in sprites:
        by_cat.setdefault(s["category"], []).append(s)

    atlas_dir = os.path.join(args.lib, "atlases")
    os.makedirs(atlas_dir, exist_ok=True)
    library = {"version": 1, "categories": {}, "objects": {}}

    for cat, items in sorted(by_cat.items()):
        loaded = [(s["name"], Image.open(os.path.join(args.lib, s["file"])).convert("RGBA"))
                  for s in items]
        placements, w, h = shelf_pack(loaded, args.pad, args.max_width)
        atlas = Image.new("RGBA", (max(w, 1), max(h, 1)), (0, 0, 0, 0))
        frames = {}
        for name, im in loaded:
            x, y, fw, fh = placements[name]
            atlas.paste(im, (x, y))
            frames[name] = {
                "frame": {"x": x, "y": y, "w": fw, "h": fh},
                "rotated": False, "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": fw, "h": fh},
                "sourceSize": {"w": fw, "h": fh},
            }
        png_name = f"{cat}.png"
        atlas.save(os.path.join(atlas_dir, png_name))
        with open(os.path.join(atlas_dir, f"{cat}.json"), "w") as f:
            json.dump({"frames": frames,
                       "meta": {"image": png_name, "size": {"w": atlas.width, "h": atlas.height},
                                "scale": 1, "app": "thomas-town/pack_atlas.py"}}, f, indent=2)
        library["categories"][cat] = {"atlas": f"atlases/{png_name}",
                                      "json": f"atlases/{cat}.json", "count": len(items)}
        for s in items:
            library["objects"][s["name"]] = {
                "category": cat, "atlasKey": f"obj-{cat}", "frame": s["name"],
                "px": s["px"], "tiles": s["tiles"],
                "collides": s["collides"], "tags": s["tags"],
            }
        print(f"  {cat}: {len(items)} sprites -> {png_name} ({atlas.width}x{atlas.height})")

    with open(os.path.join(args.lib, "library.json"), "w") as f:
        json.dump(library, f, indent=2)
    print(f"packed {len(by_cat)} atlases, {len(library['objects'])} objects -> {args.lib}/library.json")


if __name__ == "__main__":
    main()
