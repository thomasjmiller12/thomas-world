// Procedural cozy pixel-art top-down town for Thomas's Town.
// Renders into a <canvas> at a small native resolution; scale up with
// image-rendering: pixelated for crisp pixel-art. Deterministic (seeded).
//
// renderTown(canvas, opts) -> { buildings: [...], cols, rows, tile, scale }
// opts: { time: 'day'|'dusk'|'night', scale: number }

(function () {
  const AGENTS = {
    career:     { name: 'Career',     roof: '#4A90D9', roofDark: '#3A73AE', door: '#2C547E' },
    researcher: { name: 'Researcher', roof: '#9B59B6', roofDark: '#7B4593', door: '#52305F' },
    builder:    { name: 'Builder',    roof: '#E67E22', roofDark: '#BF6516', door: '#8A4710' },
    writer:     { name: 'Writer',     roof: '#27AE60', roofDark: '#1E8C4C', door: '#155E33' },
    hobby:      { name: 'Hobby',      roof: '#E74C3C', roofDark: '#C13A2C', door: '#82271D' },
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function renderTown(canvas, opts) {
    opts = opts || {};
    const TILE = 16;          // source pixels per tile
    const COLS = 40, ROWS = 26;
    const W = COLS * TILE, H = ROWS * TILE;
    const scale = opts.scale || 2;
    const rng = mulberry32(20260610);

    canvas.width = W; canvas.height = H;
    canvas.style.width = (W * scale) + 'px';
    canvas.style.height = (H * scale) + 'px';
    canvas.style.imageRendering = 'pixelated';
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // palette
    const GRASS = ['#7FB069', '#76A862', '#86B870'];
    const GRASS_DK = '#5E8C4E';
    const PATH = '#C9B89A';
    const PATH_DK = '#B6A487';
    const PATH_EDGE = '#A28E6E';
    const WATER = '#5BB4D6';
    const WATER_LT = '#86CFE6';
    const STONE = '#B7B0A6';
    const STONE_DK = '#938C82';

    function px(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

    // ---- grass base with dither ----
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        const base = GRASS[(rng() * 3) | 0];
        px(tx * TILE, ty * TILE, TILE, TILE, base);
        // sparse darker blades
        if (rng() < 0.22) {
          const bx = tx * TILE + ((rng() * 12) | 0);
          const by = ty * TILE + ((rng() * 12) | 0);
          px(bx, by, 2, 2, GRASS_DK);
          px(bx + 2, by - 1, 1, 2, GRASS_DK);
        }
      }
    }

    // ---- paths (in source pixels) ----
    // vertical main avenue + horizontal cross
    const avX = 18 * TILE, avW = 4 * TILE;
    const crY = 12 * TILE, crH = 4 * TILE;
    function pathRect(x, y, w, h) {
      px(x, y, w, h, PATH);
      // edge shading
      px(x, y, w, 2, PATH_EDGE);
      px(x, y + h - 2, w, 2, PATH_DK);
      px(x, y, 2, h, PATH_EDGE);
      px(x + w - 2, y, 2, h, PATH_DK);
      // speckle
      for (let i = 0; i < (w * h) / 90; i++) {
        px(x + ((rng() * w) | 0), y + ((rng() * h) | 0), 1, 1, PATH_DK);
      }
    }
    pathRect(avX, 0, avW, H);
    pathRect(0, crY, W, crH);

    // building helper
    const buildings = [];
    function building(tx, ty, tw, th, key, label) {
      const a = AGENTS[key];
      const x = tx * TILE, y = ty * TILE, w = tw * TILE, h = th * TILE;
      const roofH = Math.round(h * 0.42);
      // shadow
      px(x + 3, y + h - 2, w, 4, 'rgba(40,50,30,0.18)');
      // walls
      px(x, y + roofH, w, h - roofH, '#EAD9BE');
      px(x, y + roofH, w, 3, '#FFF3DE');           // top wall highlight
      px(x, y + h - 4, w, 4, '#CBB89A');           // base shade
      px(x, y + roofH, 3, h - roofH, '#F4E6CC');
      px(x + w - 3, y + roofH, 3, h - roofH, '#D4C09F');
      // windows
      const winY = y + roofH + Math.round((h - roofH) * 0.22);
      const winSize = TILE;
      function win(wx) {
        px(wx, winY, winSize, winSize, a.door);
        px(wx + 1, winY + 1, winSize - 2, winSize - 2, '#BFE0EE');
        px(wx + 1, winY + 1, winSize - 2, 2, '#E7F4FA');
        px(wx + (winSize / 2 - 1), winY + 1, 1, winSize - 2, a.door);
        px(wx + 1, winY + (winSize / 2 - 1), winSize - 2, 1, a.door);
      }
      win(x + Math.round(w * 0.16));
      win(x + w - Math.round(w * 0.16) - winSize);
      // door (center)
      const dw = TILE, dh = h - roofH - Math.round((h - roofH) * 0.28);
      const dx = x + (w - dw) / 2, dy = y + h - dh;
      px(dx, dy, dw, dh, a.door);
      px(dx + 1, dy + 1, dw - 2, dh - 1, a.roofDark);
      px(dx + dw - 4, dy + Math.round(dh / 2), 2, 2, '#F4E6CC'); // knob
      // roof
      px(x - 2, y, w + 4, roofH, a.roof);
      px(x - 2, y, w + 4, 3, a.roof === '#E67E22' ? '#F2AE6E' : 'rgba(255,255,255,0.25)');
      px(x - 2, y + roofH - 3, w + 4, 3, a.roofDark);
      // roof stripes
      for (let sx = x; sx < x + w; sx += 6) px(sx, y + 4, 1, roofH - 8, a.roofDark);
      // chimney
      px(x + w - 8, y - 5, 5, 8, a.roofDark);
      buildings.push({ key, label, name: a.name, color: a.roof,
        cx: Math.round((x + w / 2) / W * 100), cy: Math.round((y + h / 2) / H * 100) });
    }

    // place 5 buildings around the cross
    building(7, 3, 8, 6, 'career', 'Office');       // top-left
    building(25, 3, 8, 6, 'researcher', 'Library');  // top-right
    building(6, 17, 8, 6, 'builder', 'Workshop');    // bottom-left
    building(26, 17, 8, 6, 'writer', 'Cafe');        // bottom-right

    // ---- central plaza + fountain ----
    const pcx = avX + avW / 2, pcy = crY + crH / 2;
    // plaza stone
    px(pcx - 40, pcy - 40, 80, 80, STONE);
    px(pcx - 40, pcy - 40, 80, 3, '#C9C2B8');
    px(pcx - 40, pcy + 37, 80, 3, STONE_DK);
    // fountain
    px(pcx - 18, pcy - 18, 36, 36, STONE_DK);
    px(pcx - 15, pcy - 15, 30, 30, STONE);
    px(pcx - 12, pcy - 12, 24, 24, WATER);
    px(pcx - 12, pcy - 12, 24, 3, WATER_LT);
    px(pcx - 4, pcy - 8, 8, 8, WATER_LT);
    px(pcx - 2, pcy - 10, 4, 20, '#9ADBEE');     // spout
    // sparkles
    px(pcx - 8, pcy + 4, 2, 2, '#E7F8FF');
    px(pcx + 6, pcy - 2, 2, 2, '#E7F8FF');

    // ---- trees ----
    function tree(x, y, big) {
      const s = big ? 1.4 : 1;
      const tw = Math.round(6 * s), th = Math.round(7 * s);
      // shadow
      px(x - 2, y + th + 6, tw + 14, 4, 'rgba(40,50,30,0.16)');
      // trunk
      px(x + tw / 2 + 2, y + th, 4, 8, '#7A5230');
      px(x + tw / 2 + 2, y + th, 2, 8, '#8C6240');
      // canopy
      const cw = Math.round(18 * s), ch = Math.round(16 * s);
      const cx = x + tw / 2 + 3 - cw / 2, cy = y;
      px(cx, cy + 3, cw, ch - 3, '#4E8C3F');
      px(cx + 2, cy, cw - 4, ch - 3, '#5EA34C');
      px(cx + 3, cy + 1, cw - 10, 4, '#79C265'); // highlight
      // dots
      for (let i = 0; i < 6; i++) px(cx + ((rng() * cw) | 0), cy + ((rng() * ch) | 0), 2, 2, '#3E7333');
    }
    // border + scattered trees (avoid paths/buildings roughly)
    const treeSpots = [
      [2, 2], [2, 22], [36, 2], [37, 22], [2, 11], [37, 11],
      [16, 2], [22, 2], [16, 22], [22, 22], [3, 7], [36, 7], [3, 18], [36, 18],
    ];
    treeSpots.forEach(([tx, ty], i) => tree(tx * TILE, ty * TILE, i % 3 === 0));

    // ---- park (Hobby) area: bottom-center near plaza ----
    // bench + lamp + sign, no building
    const parkX = 16 * TILE, parkY = 19 * TILE;
    px(parkX, parkY + 6, 22, 4, '#9A6A3C');      // bench seat
    px(parkX + 2, parkY + 10, 3, 5, '#7A5230');
    px(parkX + 17, parkY + 10, 3, 5, '#7A5230');
    tree(parkX + 30, parkY - 30, true);
    // hobby sign
    px(parkX - 6, parkY - 4, 4, 12, '#7A5230');
    px(parkX - 14, parkY - 12, 22, 9, AGENTS.hobby.roof);
    px(parkX - 13, parkY - 11, 20, 7, AGENTS.hobby.roofDark);

    // ---- flowers ----
    const FLOWER = ['#E85D75', '#F2C14E', '#F4F1EC', '#C56BE0'];
    for (let i = 0; i < 60; i++) {
      const fx = (rng() * W) | 0, fy = (rng() * H) | 0;
      // skip near center path-ish
      if (Math.abs(fx - avX - avW / 2) < avW / 2 + 4) continue;
      if (Math.abs(fy - crY - crH / 2) < crH / 2 + 4) continue;
      px(fx, fy, 2, 2, FLOWER[(rng() * FLOWER.length) | 0]);
      px(fx, fy + 2, 1, 1, GRASS_DK);
    }

    // ---- lamp posts along avenue ----
    function lamp(x, y) {
      px(x, y, 2, 12, '#4A4036');
      px(x - 2, y - 4, 6, 5, '#F2C14E');
      px(x - 1, y - 3, 4, 3, '#FFF0B8');
      px(x - 3, y - 1, 8, 4, 'rgba(242,193,78,0.18)');
    }
    lamp(avX - 8, 7 * TILE); lamp(avX + avW + 6, 7 * TILE);
    lamp(avX - 8, 18 * TILE); lamp(avX + avW + 6, 18 * TILE);

    // ---- NPCs (5 Thomases) ----
    function npc(x, y, color) {
      px(x - 1, y + 12, 10, 3, 'rgba(40,50,30,0.2)'); // shadow
      px(x + 1, y, 6, 5, '#F0C9A0');     // head
      px(x + 1, y, 6, 2, '#5A3E2A');     // hair
      px(x, y + 5, 8, 6, color);          // body
      px(x + 1, y + 6, 6, 1, 'rgba(255,255,255,0.25)');
      px(x + 1, y + 11, 2, 3, '#3A3A3A'); // legs
      px(x + 5, y + 11, 2, 3, '#3A3A3A');
    }
    npc(10 * TILE, 10 * TILE, AGENTS.career.roof);
    npc(28 * TILE, 10 * TILE, AGENTS.researcher.roof);
    npc(9 * TILE, 16 * TILE + 8, AGENTS.builder.roof);
    npc(29 * TILE, 16 * TILE + 8, AGENTS.writer.roof);
    npc(parkX + 8, parkY - 2, AGENTS.hobby.roof);

    // ---- time-of-day tint ----
    const time = opts.time || 'day';
    if (time === 'dusk') { ctx.fillStyle = 'rgba(255,150,80,0.14)'; ctx.fillRect(0, 0, W, H); }
    if (time === 'night') { ctx.fillStyle = 'rgba(30,40,90,0.34)'; ctx.fillRect(0, 0, W, H); }

    // ---- subtle vignette ----
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(20,30,15,0.22)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    return { buildings, cols: COLS, rows: ROWS, tile: TILE, scale, width: W, height: H };
  }

  window.renderTown = renderTown;
  window.TOWN_AGENTS = AGENTS;
})();
