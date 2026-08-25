/**
 * Cockpit interior texture set.
 *
 * Generates the maps an A-wing tub and console need, in the same procedural
 * style as the planet maps. Two groups:
 *
 *   cockpit_panel_*    tiling hull panelling for the tub walls and floor
 *   cockpit_console_*  a single non-tiling instrument console
 *
 * The console ships an emissive map, because a dark cockpit lit by its own
 * instruments reads far better than a flatly lit one — and it hides how little
 * geometry the interior actually has.
 *
 * Usage: node scripts/build-cockpit.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

import sharp from 'sharp';

import { clamp01, fbm3, mix, smoothstep } from './lib/noise.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets/generated');

const PANEL_SIZE = 1024;
const CONSOLE_WIDTH = 2048;
const CONSOLE_HEIGHT = 1024;

// Gunmetal with a little warmth, so instrument glow has something to tint.
const HULL = [0.164, 0.172, 0.188];
const SEAM = [0.055, 0.058, 0.066];
const REBEL_RED = [0.42, 0.11, 0.09];

const SCREEN_COLOURS = [
  [0.30, 0.95, 0.62],  // scope green
  [1.00, 0.62, 0.15],  // amber
  [0.35, 0.70, 1.00]   // status blue
];

const BUTTON_COLOURS = [
  [1.00, 0.24, 0.18],
  [1.00, 0.70, 0.16],
  [0.36, 0.95, 0.50],
  [0.40, 0.72, 1.00],
  [0.85, 0.85, 0.90]
];

function makeRandom (seed) {
  let state = seed >>> 0;
  return function random () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Splits a rectangle recursively into panels.
 *
 * Real panelling is irregular but not random: splits favour the long axis, so
 * panels stay broadly rectangular instead of degenerating into slivers.
 */
function subdivide (rect, depth, random, out) {
  const [x, y, w, h] = rect;
  const minimum = 64;

  if (depth <= 0 || (w < minimum * 2 && h < minimum * 2)) {
    out.push(rect);
    return;
  }

  const splitVertical = w > h ? random() < 0.82 : random() < 0.18;
  const t = 0.35 + random() * 0.3;

  if (splitVertical && w >= minimum * 2) {
    const cut = Math.round(w * t);
    subdivide([x, y, cut, h], depth - 1, random, out);
    subdivide([x + cut, y, w - cut, h], depth - 1, random, out);
  } else if (h >= minimum * 2) {
    const cut = Math.round(h * t);
    subdivide([x, y, w, cut], depth - 1, random, out);
    subdivide([x, y + cut, w, h - cut], depth - 1, random, out);
  } else {
    out.push(rect);
  }
}

/** Cross-fades opposite edges so grime and wear tile without a visible seam. */
function healEdges (data, width, height, channels, blend) {
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let i = 0; i < blend; i++) {
      const t = 0.5 * (1 - i / blend);
      const left = row + i * channels;
      const right = row + (width - 1 - i) * channels;
      for (let c = 0; c < channels; c++) {
        const a = data[left + c];
        const b = data[right + c];
        data[left + c] = Math.round(mix(a, b, t));
        data[right + c] = Math.round(mix(b, a, t));
      }
    }
  }

  for (let x = 0; x < width; x++) {
    for (let i = 0; i < blend; i++) {
      const t = 0.5 * (1 - i / blend);
      const top = (i * width + x) * channels;
      const bottom = ((height - 1 - i) * width + x) * channels;
      for (let c = 0; c < channels; c++) {
        const a = data[top + c];
        const b = data[bottom + c];
        data[top + c] = Math.round(mix(a, b, t));
        data[bottom + c] = Math.round(mix(b, a, t));
      }
    }
  }
}

async function buildPanels () {
  const size = PANEL_SIZE;
  const random = makeRandom(90210);

  const panels = [];
  subdivide([0, 0, size, size], 6, random, panels);

  // Per-panel shade and a mask of which panel owns each pixel.
  const owner = new Int32Array(size * size).fill(-1);
  const shade = panels.map(() => 0.86 + random() * 0.28);
  const accent = panels.map(() => random() < 0.06);

  for (let p = 0; p < panels.length; p++) {
    const [px, py, pw, ph] = panels[p];
    for (let y = py; y < py + ph; y++) {
      for (let x = px; x < px + pw; x++) owner[y * size + x] = p;
    }
  }

  const colour = Buffer.alloc(size * size * 3);
  const rough = Buffer.alloc(size * size);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = owner[i];
      const [px, py, pw, ph] = panels[p];

      // Distance to this panel's edge, for seams, bevels and edge wear.
      const edge = Math.min(x - px, px + pw - 1 - x, y - py, py + ph - 1 - y);

      const grime = fbm3(x * 0.012, y * 0.012, 4.2, { octaves: 5, seed: 3 });
      const grain = fbm3(x * 0.09, y * 0.09, 11.5, { octaves: 3, seed: 17 });
      const scuff = fbm3(x * 0.05, y * 0.05, 21.0, { octaves: 4, seed: 29 });

      let base = accent[p] ? REBEL_RED : HULL;
      let r = base[0] * shade[p];
      let g = base[1] * shade[p];
      let b = base[2] * shade[p];

      // Grime settles low, wear brightens the raised panel edges.
      const dirt = 0.82 + grime * 0.36;
      const wear = smoothstep(6, 0, edge) * (0.25 + scuff * 0.4);
      r = r * dirt + wear * 0.12;
      g = g * dirt + wear * 0.12;
      b = b * dirt + wear * 0.13;

      r += (grain - 0.5) * 0.035;
      g += (grain - 0.5) * 0.035;
      b += (grain - 0.5) * 0.035;

      // Seam between panels.
      const seam = smoothstep(2.2, 0.4, edge);
      r = mix(r, SEAM[0], seam);
      g = mix(g, SEAM[1], seam);
      b = mix(b, SEAM[2], seam);

      // Fasteners, spaced along the inside of each seam.
      const inset = 7;
      const nearEdge = edge > inset - 3 && edge < inset + 3;
      const along = ((x % 46) - 23);
      const down = ((y % 46) - 23);
      const stud = nearEdge && (along * along + down * down) < 5;
      if (stud) {
        r *= 0.55; g *= 0.55; b *= 0.58;
      }

      colour[i * 3] = Math.round(clamp01(r) * 255);
      colour[i * 3 + 1] = Math.round(clamp01(g) * 255);
      colour[i * 3 + 2] = Math.round(clamp01(b) * 255);

      // Worn edges polish up; grimy centres stay matte.
      rough[i] = Math.round(clamp01(0.92 - wear * 0.45 - (grime - 0.5) * 0.12) * 255);

      // Panels stand proud, seams cut in, studs bump out.
      height[i] = clamp01(0.62 + smoothstep(0, 3, edge) * 0.3 - seam * 0.5 + (stud ? 0.22 : 0) + (grain - 0.5) * 0.05);
    }
  }

  healEdges(colour, size, size, 3, 24);
  healEdges(rough, size, size, 1, 24);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await sharp(colour, { raw: { width: size, height: size, channels: 3 } })
    .webp({ quality: 88, effort: 6 }).toFile(path.join(OUT_DIR, 'cockpit_panel_color.webp'));
  await sharp(rough, { raw: { width: size, height: size, channels: 1 } })
    .webp({ quality: 90, effort: 6 }).toFile(path.join(OUT_DIR, 'cockpit_panel_roughness.webp'));

  await writeNormal(height, size, size, 2.4, 'cockpit_panel_normal.webp');
}

async function writeNormal (field, width, height, strength, name) {
  const out = Buffer.alloc(width * height * 3);
  const at = (x, y) => field[(((y % height) + height) % height) * width + (((x % width) + width) % width)];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
                 (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
                 (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));

      const nx = -dx * strength;
      const ny = -dy * strength;
      const length = Math.hypot(nx, ny, 1);
      const p = (y * width + x) * 3;
      out[p] = Math.round((nx / length * 0.5 + 0.5) * 255);
      out[p + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      out[p + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
    }
  }

  await sharp(out, { raw: { width, height, channels: 3 } })
    .webp({ quality: 94, effort: 6 }).toFile(path.join(OUT_DIR, name));
}

async function buildConsole () {
  const width = CONSOLE_WIDTH;
  const height = CONSOLE_HEIGHT;
  const random = makeRandom(31337);

  const colour = Buffer.alloc(width * height * 3);
  const emissive = Buffer.alloc(width * height * 3);

  // Lay out the fascia: a few screens, then banks of switchgear.
  const screens = [
    { x: 180, y: 190, w: 470, h: 330, colour: SCREEN_COLOURS[0] },
    { x: 760, y: 150, w: 520, h: 250, colour: SCREEN_COLOURS[1] },
    { x: 760, y: 450, w: 250, h: 190, colour: SCREEN_COLOURS[2] },
    { x: 1420, y: 200, w: 430, h: 400, colour: SCREEN_COLOURS[0] }
  ];

  const buttons = [];
  for (const bank of [
    { x: 200, y: 620, cols: 8, rows: 3 },
    { x: 1060, y: 470, cols: 5, rows: 2 },
    { x: 1420, y: 680, cols: 7, rows: 2 }
  ]) {
    for (let r = 0; r < bank.rows; r++) {
      for (let c = 0; c < bank.cols; c++) {
        buttons.push({
          x: bank.x + c * 54,
          y: bank.y + r * 54,
          radius: 17,
          colour: BUTTON_COLOURS[Math.floor(random() * BUTTON_COLOURS.length)],
          lit: random() < 0.55
        });
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      const grime = fbm3(x * 0.010, y * 0.010, 7.7, { octaves: 5, seed: 41 });
      const grain = fbm3(x * 0.11, y * 0.11, 13.3, { octaves: 3, seed: 53 });

      // Fascia is darker than the tub panelling so the instruments carry.
      let r = 0.088 * (0.8 + grime * 0.45) + (grain - 0.5) * 0.02;
      let g = 0.094 * (0.8 + grime * 0.45) + (grain - 0.5) * 0.02;
      let b = 0.104 * (0.8 + grime * 0.45) + (grain - 0.5) * 0.02;

      let er = 0, eg = 0, eb = 0;

      for (const s of screens) {
        if (x < s.x || x >= s.x + s.w || y < s.y || y >= s.y + s.h) continue;
        const inset = Math.min(x - s.x, s.x + s.w - 1 - x, y - s.y, s.y + s.h - 1 - y);

        if (inset < 8) {                     // bezel
          r = 0.05; g = 0.052; b = 0.058;
          break;
        }

        // Scanlines, plus a slow horizontal readout wash.
        const scan = (y % 4 < 2) ? 1 : 0.62;
        const trace = smoothstep(0.35, 0.95, fbm3(x * 0.03, y * 0.008, 2.1, { octaves: 3, seed: 61 }));
        const level = (0.20 + trace * 0.80) * scan;

        r = s.colour[0] * level * 0.55;
        g = s.colour[1] * level * 0.55;
        b = s.colour[2] * level * 0.55;
        er = s.colour[0] * level;
        eg = s.colour[1] * level;
        eb = s.colour[2] * level;
        break;
      }

      for (const btn of buttons) {
        const dx = x - btn.x;
        const dy = y - btn.y;
        const d = Math.hypot(dx, dy);
        if (d > btn.radius + 3) continue;

        if (d > btn.radius) {                // recessed housing
          r = 0.04; g = 0.042; b = 0.048;
        } else {
          const face = 1 - smoothstep(btn.radius * 0.5, btn.radius, d);
          r = btn.colour[0] * (0.18 + face * 0.30);
          g = btn.colour[1] * (0.18 + face * 0.30);
          b = btn.colour[2] * (0.18 + face * 0.30);
          if (btn.lit) {
            er = btn.colour[0] * (0.35 + face * 0.65);
            eg = btn.colour[1] * (0.35 + face * 0.65);
            eb = btn.colour[2] * (0.35 + face * 0.65);
          }
        }
        break;
      }

      colour[i * 3] = Math.round(clamp01(r) * 255);
      colour[i * 3 + 1] = Math.round(clamp01(g) * 255);
      colour[i * 3 + 2] = Math.round(clamp01(b) * 255);
      emissive[i * 3] = Math.round(clamp01(er) * 255);
      emissive[i * 3 + 1] = Math.round(clamp01(eg) * 255);
      emissive[i * 3 + 2] = Math.round(clamp01(eb) * 255);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await sharp(colour, { raw: { width, height, channels: 3 } })
    .webp({ quality: 90, effort: 6 }).toFile(path.join(OUT_DIR, 'cockpit_console_color.webp'));
  await sharp(emissive, { raw: { width, height, channels: 3 } })
    .webp({ quality: 90, effort: 6 }).toFile(path.join(OUT_DIR, 'cockpit_console_emissive.webp'));
}

async function main () {
  const started = Date.now();
  await buildPanels();
  await buildConsole();

  for (const file of (await fs.readdir(OUT_DIR)).filter((f) => f.startsWith('cockpit_')).sort()) {
    const { size } = await fs.stat(path.join(OUT_DIR, file));
    const meta = await sharp(path.join(OUT_DIR, file)).metadata();
    console.log(`${file.padEnd(32)} ${String(meta.width).padStart(5)}x${String(meta.height).padEnd(5)} ${(size / 1024).toFixed(0)} KB`);
  }
  console.log(`\nbuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

await main();
