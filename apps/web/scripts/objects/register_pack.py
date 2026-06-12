#!/usr/bin/env python3
"""Register the object atlases + library manifest into the Phaser asset pack.

Adds (idempotently) one `atlas` entry per category atlas and one `json` entry for
library.json into public/assets/preload-asset-pack.json, so the Preloader's
`this.load.pack('preload', ...)` loads them and the TownObjects helper can place
objects by name. Re-run after packing new atlases.

Usage:
  python3 register_pack.py --lib public/assets/objects --pack public/assets/preload-asset-pack.json
"""
import argparse
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", required=True, help="object library dir (has library.json)")
    ap.add_argument("--pack", required=True, help="Phaser preload asset-pack json")
    ap.add_argument("--asset-base", default="assets/objects",
                    help="URL base for the atlases (relative to the app root)")
    args = ap.parse_args()

    library = json.load(open(f"{args.lib}/library.json"))
    pack = json.load(open(args.pack))
    # The files section is the (non-meta) object holding a "files" array — the
    # section name matches the pack key passed to load.pack() (here "preload").
    section = next(v for k, v in pack.items() if isinstance(v, dict) and "files" in v)
    files = section["files"]
    existing = {f.get("key") for f in files}

    added = 0
    for cat, meta in sorted(library["categories"].items()):
        key = f"obj-{cat}"
        if key in existing:
            continue
        files.append({
            "type": "atlas",
            "key": key,
            "textureURL": f"{args.asset_base}/{meta['atlas']}",
            "atlasURL": f"{args.asset_base}/{meta['json']}",
        })
        added += 1
    if "town-objects" not in existing:
        files.append({"type": "json", "key": "town-objects", "url": f"{args.asset_base}/library.json"})
        added += 1

    json.dump(pack, open(args.pack, "w"), indent=2)
    print(f"registered {added} new entries (atlases + library) into {args.pack}")


if __name__ == "__main__":
    main()
