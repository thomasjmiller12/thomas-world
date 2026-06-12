#!/usr/bin/env python3
"""Merge CC segmentation candidates + the naming-workflow result into catalog.json.

candidates.json gives deterministic tile boxes (from segment_objects.py); the
naming workflow gives {id -> name, category, collides, tags, skip, multi}. This
joins them, drops skipped candidates, de-collides names to unique frame keys, and
writes the catalog.json that crop_objects.py + pack_atlas.py consume.

Usage:
  python3 name_catalog.py --candidates candidates.json --names RESULT_FILE --out catalog.json
          [--keep-multi]   (by default, merged multi-object cells are dropped)
"""
import argparse
import json
from collections import Counter


def load_result(path):
    with open(path) as f:
        txt = f.read()
    s, e = txt.find("{"), txt.rfind("}")
    data = json.loads(txt[s:e + 1])
    return data.get("result", data) if isinstance(data, dict) else data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--names", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep-multi", action="store_true")
    args = ap.parse_args()

    cand_doc = json.load(open(args.candidates))
    sheet = cand_doc["sheet"]
    cand = {c["id"]: c for c in cand_doc["candidates"]}
    names = load_result(args.names).get("items", [])

    objects, dropped = [], Counter()
    for it in names:
        cid = it.get("id")
        if cid not in cand:
            dropped["no-such-candidate"] += 1
            continue
        if it.get("skip"):
            dropped["skip"] += 1
            continue
        if it.get("multi") and not args.keep_multi:
            dropped["multi"] += 1
            continue
        c = cand[cid]
        objects.append({
            "name": it["name"],
            "category": it.get("category", "misc"),
            "source": {"sheet": sheet, "col": c["col"], "row": c["row"], "w": c["w"], "h": c["h"]},
            "collides": bool(it.get("collides", False)),
            "tags": it.get("tags", []),
            "trim": True,
            "candidateId": cid,
        })

    # De-collide names -> unique frame keys.
    seen = Counter()
    for o in sorted(objects, key=lambda o: (o["source"]["row"], o["source"]["col"])):
        seen[o["name"]] += 1
        if seen[o["name"]] > 1:
            s = o["source"]
            o["name"] = f"{o['name']}-r{s['row']}c{s['col']}"

    objects.sort(key=lambda o: (o["category"], o["source"]["row"], o["source"]["col"]))
    json.dump({"version": 1, "sheet": sheet, "objects": objects}, open(args.out, "w"), indent=2)

    hist = Counter(o["category"] for o in objects)
    print(f"named candidates: {len(names)} -> kept objects: {len(objects)}  (dropped: {dict(dropped)})")
    for cat, k in hist.most_common():
        print(f"  {cat:10s} {k}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
