#!/usr/bin/env python3
"""Merge a workflow inventory result into a deduped, name-unique catalog.json.

The inventory workflow returns ~1 object per sighting; overlapping inspection
blocks produce duplicate sightings of the same object (same tile bbox). This:
  - loads the workflow result JSON,
  - drops out-of-bounds / degenerate boxes,
  - dedups by exact tile bbox (col,row,w,h): merges tags, majority-vote collides,
    keeps the highest-confidence name,
  - de-collides names so every object has a UNIQUE frame key,
  - writes catalog.json (crop_objects.py input) + prints a category histogram.

Usage:
  python3 build_catalog.py --result FILE --sheet REL --cols N --rows N --out catalog.json
"""
import argparse
import json
from collections import Counter, defaultdict

CONF = {"low": 0, "med": 1, "high": 2}


def load_result(path):
    with open(path) as f:
        txt = f.read()
    # The result file is the workflow's returned JSON object; be tolerant of any
    # leading/trailing noise by slicing to the outermost braces.
    s, e = txt.find("{"), txt.rfind("}")
    data = json.loads(txt[s:e + 1])
    # Workflow result files wrap the script's return value under "result".
    return data.get("result", data) if isinstance(data, dict) else data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", required=True)
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--cols", type=int, required=True)
    ap.add_argument("--rows", type=int, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = load_result(args.result)
    raw = data.get("objects", [])

    # Drop degenerate / out-of-bounds boxes.
    clean = []
    for o in raw:
        c, r, w, h = o.get("col"), o.get("row"), o.get("w"), o.get("h")
        if None in (c, r, w, h):
            continue
        if w < 1 or h < 1 or c < 0 or r < 0:
            continue
        if c + w > args.cols or r + h > args.rows:
            continue
        if w > 12 or h > 14:  # implausibly large for a single object
            continue
        clean.append(o)

    # Dedup by exact tile bbox.
    groups = defaultdict(list)
    for o in clean:
        groups[(o["col"], o["row"], o["w"], o["h"])].append(o)

    merged = []
    for (c, r, w, h), grp in groups.items():
        best = max(grp, key=lambda o: CONF.get(o.get("confidence", "low"), 0))
        tags = sorted({t for o in grp for t in o.get("tags", [])})
        collides = sum(bool(o.get("collides")) for o in grp) >= (len(grp) / 2)
        cats = Counter(o.get("category", "misc") for o in grp)
        merged.append({
            "name": best["name"],
            "category": cats.most_common(1)[0][0],
            "source": {"sheet": args.sheet, "col": c, "row": r, "w": w, "h": h},
            "collides": collides,
            "tags": tags,
            "trim": True,
            "sightings": len(grp),
            "variant": best.get("variant"),
        })

    # Spatial dedup: overlapping inspection blocks report the same object with
    # slightly different boxes (off-by-one), which exact-bbox dedup misses. Greedy
    # IoU pass — keep the higher-confidence/larger box, fold the loser's sightings
    # in. Adjacent distinct objects (a row of signs) have ~0 IoU, so they survive.
    def iou(a, b):
        ax0, ay0, ax1, ay1 = a["col"], a["row"], a["col"] + a["w"], a["row"] + a["h"]
        bx0, by0, bx1, by1 = b["col"], b["row"], b["col"] + b["w"], b["row"] + b["h"]
        ix0, iy0, ix1, iy1 = max(ax0, bx0), max(ay0, by0), min(ax1, bx1), min(ay1, by1)
        iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
        inter = iw * ih
        if inter == 0:
            return 0.0
        return inter / (a["w"] * a["h"] + b["w"] * b["h"] - inter)

    merged.sort(key=lambda o: (CONF.get("high" if o["sightings"] > 1 else "low", 0),
                               o["source"]["w"] * o["source"]["h"], o["sightings"]), reverse=True)
    kept = []
    for o in merged:
        dup = next((k for k in kept if iou(o["source"], k["source"]) > 0.45), None)
        if dup:
            dup["tags"] = sorted(set(dup["tags"]) | set(o["tags"]))
            dup["sightings"] += o["sightings"]
        else:
            kept.append(o)
    merged = kept

    # De-collide names: unique frame keys.
    seen = Counter()
    for o in sorted(merged, key=lambda o: (o["source"]["row"], o["source"]["col"])):
        base = o["name"]
        seen[base] += 1
        if seen[base] > 1:
            s = o["source"]
            o["name"] = f"{base}-r{s['row']}c{s['col']}"

    merged.sort(key=lambda o: (o["category"], o["source"]["row"], o["source"]["col"]))
    with open(args.out, "w") as f:
        json.dump({"version": 1, "sheet": args.sheet, "objects": merged}, f, indent=2)

    hist = Counter(o["category"] for o in merged)
    print(f"raw sightings: {len(raw)} -> in-bounds: {len(clean)} -> unique objects: {len(merged)}")
    print("by category:")
    for cat, n in hist.most_common():
        print(f"  {cat:10s} {n}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
