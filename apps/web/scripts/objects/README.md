# LimeZu object-library pipeline

Turns the monolithic LimeZu tilesets (raw GID grids in `public/assets/tilesets/`)
into a **legible, named, reusable object library** — every placeable object gets
its own labeled PNG (editable source of truth) plus a packed Phaser atlas
(runtime). The object **name** is the shared vocabulary that threads through the
whole stack: agent fixture → `@town/contract` → Phaser drop-in → visitor-clickable.

Non-destructive: the existing tilesets and tilemap layers are untouched. The
library lives in its own folder: `public/assets/objects/`.

## Why

A tile like GID `9222` in `3_City_Props` (32×224 = 7,168 tiles) is meaningless to
a human or an agent. To expand the town you'd have to eyeball a 7,000-tile sheet
and hand-type indices. This pipeline gives every object a name, a category, a
collision flag, and a clean sprite — so the map becomes editable by name.

## Tooling

Python **PIL/Pillow** (12.2 in this env). No `sharp` / ImageMagick needed.

## Pipeline

```
tileset PNG ──slice_sheet.py──▶ labeled inspection blocks (scratch/, throwaway)
                                        │
                          parallel vision agents (Workflow)
                                        ▼
                                 catalog.json  ◀── authored object defs
                                        │            {name, category, source rect, collides, tags}
                          crop_objects.py│
                                        ▼
            public/assets/objects/sprites/<category>/<name>.png  (+ _sprites.json)
                                        │
                            pack_atlas.py│
                                        ▼
   public/assets/objects/atlases/<category>.png + .json   (Phaser JSON-Hash)
   public/assets/objects/library.json   ◀── runtime manifest (name → atlasKey/frame/px/tiles/collides/tags)
```

### 1. Slice a sheet into inspection blocks (`slice_sheet.py`)

Cuts a sheet into upscaled, pixel-crisp blocks with a tile grid + **absolute
tile-coordinate labels** burned into the margins (cols across top, rows down
left, bold red every 4). `--overlap-rows` shares rows between vertically-adjacent
blocks so tall objects are fully visible in at least one block.

```bash
python3 slice_sheet.py public/assets/tilesets/exterior/3_City_Props_16x16.png \
  --out ../../../scratch/sheet-inspection/3_City_Props \
  --block-rows 24 --overlap-rows 10 --scale 7
```

Interior sheets are 16 tiles wide — keep `--block-cols 0` (full width). Blocks +
a `_blocks.json` (tile ranges) are written to the out dir.

### 2. Inventory (parallel vision agents)

A `Workflow` fans out one Sonnet agent per block. Each reads its block image and
returns objects with a **tight tile bounding box** in absolute coords, category,
`collides`, `variant`, `edgeCut`, `tags`. Merge the results (dedup overlap
duplicates by name + box proximity, keep highest confidence) into `catalog.json`:

```json
{ "objects": [
  { "name": "red-telephone-box", "category": "street",
    "source": { "sheet": "exterior/3_City_Props_16x16.png", "col": 28, "row": 12, "w": 3, "h": 7 },
    "collides": true, "tags": ["phone","landmark"], "trim": true } ] }
```

Categories: `street, furniture, lighting, nature, play, vendor, fence, decor, misc`.

### 3. Crop individual sprites (`crop_objects.py`)

```bash
python3 crop_objects.py --catalog ../../public/assets/objects/catalog.json \
  --tilesets ../../public/assets/tilesets --out ../../public/assets/objects
```

Crops each object's tile rect; `trim` (default on) auto-removes transparent
borders via `getbbox`, so a slightly-generous agent box still yields a tight
sprite. Writes `sprites/<category>/<name>.png` + `_sprites.json`.

> Objects sit adjacent with **no gaps**, and some have multiple orientation
> variants — agent boxes must be tight per-object; trim only cleans transparent
> margins, it cannot separate touching objects.

### 4. Pack atlases (`pack_atlas.py`)

```bash
python3 pack_atlas.py --lib ../../public/assets/objects
```

Packs each category's sprites into `atlases/<category>.png` + `.json`
(Phaser JSON-Hash, frame = object name), and emits `library.json` — the runtime
manifest the `TownObjects` Phaser helper and the fixtures model consume.

## Scaling to all sheets

Validated end-to-end on `3_City_Props` first (the keystone — most town props).
Then repeat slice + workflow across the other object-bearing sheets:
exterior `11_Camping, 9_Shopping_Center_and_Markets, 16_Office, 4_Generic_Buildings,
1_Terrains_and_Fences (fences)`; interior furniture packs (`*_Black_Shadow`).
Pure terrain/material sheets (`2_City_Terrains, 5_Floor_Modular, Room_Builder_*`)
stay as tilemap layers — they're materials, not objects.
