/**
 * Planet and sky texture pipeline.
 *
 * Takes the two authored source images in assets/img and produces the map set
 * the scene actually samples, in assets/generated:
 *
 *   planet_color.webp   4096x2048  graded albedo with fractal terrain detail
 *   planet_normal.webp  2048x1024  tangent-space normals derived from height
 *   planet_surface.webp 1024x512   R = roughness, G = ambient occlusion
 *   planet_clouds.webp  2048x1024  greyscale cloud/dust opacity
 *   space_sky.webp      4000x2000  recompressed, graded nebula backdrop
 *
 * Usage: node scripts/build-textures.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

import sharp from 'sharp';

import { clamp01, equirectDirection, fbm3, mix, ridged3, smoothstep } from './lib/noise.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'assets/img');
const OUT_DIR = path.join(ROOT, 'assets/generated');

const COLOR_WIDTH = 4096;
const COLOR_HEIGHT = 2048;
const NORMAL_SCALE = 2; // colour resolution / normal resolution
const SURFACE_SCALE = 4; // colour resolution / roughness+AO resolution
const CLOUD_WIDTH = 2048;
const CLOUD_HEIGHT = 1024;

// Longitude range, in source pixels, over which the two edges of the
// equirectangular source are cross-faded so the wrap seam disappears.
const SEAM_BLEND = 28;

const FROST = [212, 224, 236];

function formatBytes (bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function luminance (r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Cross-fades the left and right edges of an equirectangular image into each
 * other. The source map is a scan of a physical texture and does not wrap, so
 * without this a bright vertical scar runs pole to pole.
 */
function healSeam (pixels, width, height, channels) {
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let i = 0; i < SEAM_BLEND; i++) {
      const t = 0.5 * (1 - i / SEAM_BLEND); // 0.5 at the seam, 0 at the blend edge
      const left = row + i * channels;
      const right = row + (width - 1 - i) * channels;
      for (let c = 0; c < channels; c++) {
        const a = pixels[left + c];
        const b = pixels[right + c];
        pixels[left + c] = Math.round(mix(a, b, t));
        pixels[right + c] = Math.round(mix(b, a, t));
      }
    }
  }
}

/**
 * Replaces the last few rows at each pole with the mean of the band just below
 * them. Equirectangular sources smear badly in the final rows, which shows up
 * as a hard ring when mapped to a sphere.
 */
function flattenPoles (pixels, width, height, channels) {
  const band = Math.max(2, Math.round(height * 0.012));
  const sample = band * 2;

  for (const pole of [0, 1]) {
    const mean = new Float64Array(channels);
    for (let i = 0; i < sample; i++) {
      const y = pole === 0 ? band + i : height - 1 - band - i;
      const row = y * width * channels;
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < channels; c++) mean[c] += pixels[row + x * channels + c];
      }
    }
    for (let c = 0; c < channels; c++) mean[c] /= sample * width;

    for (let i = 0; i < band; i++) {
      const y = pole === 0 ? i : height - 1 - i;
      const weight = 1 - i / band; // fully replaced at the pole row itself
      const row = y * width * channels;
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < channels; c++) {
          const index = row + x * channels + c;
          pixels[index] = Math.round(mix(pixels[index], mean[c], weight));
        }
      }
    }
  }
}

function downsample (source, width, height, factor) {
  const outWidth = width / factor;
  const outHeight = height / factor;
  const out = new Float32Array(outWidth * outHeight);
  const area = factor * factor;

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += source[row + dx];
      }
      out[y * outWidth + x] = sum / area;
    }
  }

  return out;
}

async function buildPlanetMaps () {
  const source = sharp(path.join(SOURCE_DIR, 'tat.png'))
    .resize(COLOR_WIDTH, COLOR_HEIGHT, { kernel: 'lanczos3' })
    .removeAlpha();

  const { data } = await source.raw().toBuffer({ resolveWithObject: true });
  healSeam(data, COLOR_WIDTH, COLOR_HEIGHT, 3);
  flattenPoles(data, COLOR_WIDTH, COLOR_HEIGHT, 3);

  const color = Buffer.alloc(COLOR_WIDTH * COLOR_HEIGHT * 3);
  const height = new Float32Array(COLOR_WIDTH * COLOR_HEIGHT);
  const roughness = new Float32Array(COLOR_WIDTH * COLOR_HEIGHT);
  const occlusion = new Float32Array(COLOR_WIDTH * COLOR_HEIGHT);
  const dir = new Float32Array(3);

  for (let y = 0; y < COLOR_HEIGHT; y++) {
    for (let x = 0; x < COLOR_WIDTH; x++) {
      const i = y * COLOR_WIDTH + x;
      const p = i * 3;

      let r = data[p] / 255;
      let g = data[p + 1] / 255;
      let b = data[p + 2] / 255;

      equirectDirection(x, y, COLOR_WIDTH, COLOR_HEIGHT, dir);

      // Fractal erosion detail. The source map is only 1200px wide, so without
      // this the planet reads as a blurry decal at close range.
      const coarse = fbm3(dir[0] * 14, dir[1] * 14, dir[2] * 14, { octaves: 4, seed: 11 });
      const fine = fbm3(dir[0] * 96, dir[1] * 96, dir[2] * 96, { octaves: 5, seed: 23 });
      const grit = fbm3(dir[0] * 420, dir[1] * 420, dir[2] * 420, { octaves: 3, seed: 37 });

      const base = luminance(data[p], data[p + 1], data[p + 2]);

      // Basins: dark and cool. They take a slicker roughness so the terminator
      // catches a specular glint across them.
      const basin = clamp01(smoothstep(0.34, 0.08, base) * smoothstep(-0.02, 0.06, b - r * 0.85));

      const detail = (fine - 0.5) * 0.22 + (grit - 0.5) * 0.09 + (coarse - 0.5) * 0.1;
      const shade = 1 + detail * mix(1, 0.45, basin);

      r *= shade;
      g *= shade;
      b *= shade;

      // Grade: lift saturation, push the sands warm, keep a touch of contrast.
      const grey = luminance(r * 255, g * 255, b * 255);
      r = grey + (r - grey) * 1.2;
      g = grey + (g - grey) * 1.2;
      b = grey + (b - grey) * 1.2;

      r = (r - 0.5) * 1.09 + 0.5;
      g = (g - 0.5) * 1.09 + 0.5;
      b = (b - 0.5) * 1.09 + 0.5;

      r *= 1.07;
      g *= 1.0;
      b *= 0.93;

      // Polar frost, with a noisy edge and mottled interior so the cap does
      // not read as a decal pasted over the pole.
      const capNoise = fbm3(dir[0] * 9, dir[1] * 9, dir[2] * 9, { octaves: 4, seed: 71 });
      const cap = smoothstep(0.87, 0.985, Math.abs(dir[1]) + (capNoise - 0.5) * 0.15);
      const frost = cap * 0.82;
      const mottle = 1 + (fine - 0.5) * 0.16;
      r = mix(r, (FROST[0] / 255) * mottle, frost);
      g = mix(g, (FROST[1] / 255) * mottle, frost);
      b = mix(b, (FROST[2] / 255) * mottle, frost);

      color[p] = Math.round(clamp01(r) * 255);
      color[p + 1] = Math.round(clamp01(g) * 255);
      color[p + 2] = Math.round(clamp01(b) * 255);

      // Height drives the normal map: mostly the photographic relief, with the
      // fractal detail mixed in so fine structure lights up as well.
      height[i] = clamp01(base * 0.80 + fine * 0.17 + grit * 0.03 + cap * 0.05);

      // Sand is near-fully rough; basins and frost are smoother.
      roughness[i] = clamp01(mix(0.97, 0.52, basin) - cap * 0.18);

      // Cheap cavity term: low ground between ridges collects shadow.
      occlusion[i] = clamp01(0.62 + base * 0.42 + (fine - 0.5) * 0.3);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const colorPath = path.join(OUT_DIR, 'planet_color.webp');
  await sharp(color, { raw: { width: COLOR_WIDTH, height: COLOR_HEIGHT, channels: 3 } })
    .webp({ quality: 82, effort: 6 })
    .toFile(colorPath);

  await writeNormalMap(height);
  await writeSurfaceMap(roughness, occlusion);

  return colorPath;
}

/**
 * Sobel-derived tangent-space normals. Slope along the horizontal axis is
 * scaled by cos(latitude) to undo equirectangular stretching, then the whole
 * map fades to flat at the poles where that correction stops being stable.
 */
async function writeNormalMap (heightFull) {
  const width = COLOR_WIDTH / NORMAL_SCALE;
  const height = COLOR_HEIGHT / NORMAL_SCALE;
  const field = downsample(heightFull, COLOR_WIDTH, COLOR_HEIGHT, NORMAL_SCALE);
  const out = Buffer.alloc(width * height * 3);

  const strength = 1.8;
  const at = (x, y) => field[Math.min(height - 1, Math.max(0, y)) * width + ((x % width) + width) % width];

  for (let y = 0; y < height; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    const cosLat = Math.max(Math.cos(lat), 1e-3);
    const poleFade = smoothstep(0.0, 0.28, cosLat);

    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1); const t = at(x, y - 1); const tr = at(x + 1, y - 1);
      const l = at(x - 1, y); const r = at(x + 1, y);
      const bl = at(x - 1, y + 1); const bt = at(x, y + 1); const br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * bt + br) - (tl + 2 * t + tr);

      const nx = -dx * strength * cosLat * poleFade;
      const ny = -dy * strength * poleFade;
      const nz = 1;

      const length = Math.hypot(nx, ny, nz);
      const p = (y * width + x) * 3;
      out[p] = Math.round((nx / length * 0.5 + 0.5) * 255);
      out[p + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      out[p + 2] = Math.round((nz / length * 0.5 + 0.5) * 255);
    }
  }

  await sharp(out, { raw: { width, height, channels: 3 } })
    .webp({ quality: 95, effort: 6 })
    .toFile(path.join(OUT_DIR, 'planet_normal.webp'));
}

/** Packs roughness into red and ambient occlusion into green. */
async function writeSurfaceMap (roughnessFull, occlusionFull) {
  const width = COLOR_WIDTH / SURFACE_SCALE;
  const height = COLOR_HEIGHT / SURFACE_SCALE;
  const rough = downsample(roughnessFull, COLOR_WIDTH, COLOR_HEIGHT, SURFACE_SCALE);
  const ao = downsample(occlusionFull, COLOR_WIDTH, COLOR_HEIGHT, SURFACE_SCALE);
  const out = Buffer.alloc(width * height * 3);

  for (let i = 0; i < width * height; i++) {
    out[i * 3] = Math.round(clamp01(rough[i]) * 255);
    out[i * 3 + 1] = Math.round(clamp01(ao[i]) * 255);
    out[i * 3 + 2] = 0;
  }

  await sharp(out, { raw: { width, height, channels: 3 } })
    .webp({ quality: 92, effort: 6 })
    .toFile(path.join(OUT_DIR, 'planet_surface.webp'));
}

/**
 * Cloud and dust deck. Coverage is banded by latitude and sheared east-west by
 * a latitude-dependent rotation, which is what gives the deck its planetary
 * "wind belt" look rather than reading as generic noise.
 */
async function buildClouds () {
  const out = Buffer.alloc(CLOUD_WIDTH * CLOUD_HEIGHT);
  const dir = new Float32Array(3);

  for (let y = 0; y < CLOUD_HEIGHT; y++) {
    for (let x = 0; x < CLOUD_WIDTH; x++) {
      equirectDirection(x, y, CLOUD_WIDTH, CLOUD_HEIGHT, dir);

      // Differential rotation: shear longitude by latitude before sampling.
      const shear = dir[1] * 2.4;
      const cs = Math.cos(shear);
      const sn = Math.sin(shear);
      const sx = dir[0] * cs - dir[2] * sn;
      const sz = dir[0] * sn + dir[2] * cs;
      const sy = dir[1];

      // Warp the sample point with a low-frequency field to curl the bands.
      const warp = 0.55;
      const wx = fbm3(sx * 2.1, sy * 2.1, sz * 2.1, { octaves: 3, seed: 5 }) - 0.5;
      const wy = fbm3(sx * 2.1 + 19, sy * 2.1, sz * 2.1, { octaves: 3, seed: 17 }) - 0.5;

      const px = sx + wx * warp;
      const py = sy + wy * warp * 0.4;
      const pz = sz + wx * warp * 0.6;

      // Bands are stretched east-west (low x/z frequency, high y frequency).
      const body = fbm3(px * 3.4, py * 11.0, pz * 3.4, { octaves: 6, seed: 41 });
      const wisps = ridged3(px * 9.0, py * 26.0, pz * 9.0, { octaves: 4, seed: 59 });

      // Wind belts, perturbed so the bands are not a clean sine, plus a
      // large-scale weather field that leaves some longitudes clear.
      const bandJitter = (fbm3(sx * 1.7, sy * 3.1, sz * 1.7, { octaves: 3, seed: 83 }) - 0.5) * 1.6;
      const belts = 0.66 + 0.34 * Math.sin(sy * 6.4 + bandJitter);
      const weather = 0.55 + 0.75 * fbm3(sx * 1.3, sy * 1.3, sz * 1.3, { octaves: 3, seed: 97 });
      const lat = Math.abs(sy);
      const latitudeMask = (1 - smoothstep(0.88, 1.0, lat)) * belts * weather;

      const density = body * 0.7 + wisps * 0.3;
      const coverage = smoothstep(0.44, 0.82, density * mix(0.7, 1.35, clamp01(latitudeMask)));

      out[y * CLOUD_WIDTH + x] = Math.round(clamp01(coverage) * 255);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const cloudPath = path.join(OUT_DIR, 'planet_clouds.webp');
  await sharp(out, { raw: { width: CLOUD_WIDTH, height: CLOUD_HEIGHT, channels: 1 } })
    .webp({ quality: 88, effort: 6 })
    .toFile(cloudPath);

  return cloudPath;
}

/**
 * The backdrop ships as an 8.4 MB PNG of almost entirely dark, low-frequency
 * nebula. WebP stores the same image in a fraction of the bytes; the grade
 * gives the nebula a little more presence behind the starfield.
 */
async function buildSky () {
  const input = path.join(SOURCE_DIR, 'spaceBackground.png');
  const { width, height } = await sharp(input).metadata();
  const { data } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  healSeam(data, width, height, 3);

  for (let i = 0; i < width * height; i++) {
    const p = i * 3;
    let r = data[p] / 255;
    let g = data[p + 1] / 255;
    let b = data[p + 2] / 255;

    // Gentle S-curve, then a cool cast so the nebula sits behind the fleet
    // rather than competing with it.
    r = clamp01((r - 0.5) * 1.22 + 0.5) * 0.86;
    g = clamp01((g - 0.5) * 1.22 + 0.5) * 0.98;
    b = clamp01((b - 0.5) * 1.22 + 0.5) * 1.12;

    data[p] = Math.round(clamp01(r) * 255);
    data[p + 1] = Math.round(clamp01(g) * 255);
    data[p + 2] = Math.round(clamp01(b) * 255);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const skyPath = path.join(OUT_DIR, 'space_sky.webp');
  await sharp(data, { raw: { width, height, channels: 3 } })
    .webp({ quality: 80, effort: 6 })
    .toFile(skyPath);

  return { skyPath, sourceSize: (await fs.stat(input)).size };
}

async function main () {
  const started = Date.now();

  await buildPlanetMaps();
  await buildClouds();
  const { sourceSize } = await buildSky();

  const files = (await fs.readdir(OUT_DIR)).sort();
  let total = 0;
  for (const file of files) {
    const { size } = await fs.stat(path.join(OUT_DIR, file));
    const meta = await sharp(path.join(OUT_DIR, file)).metadata();
    total += size;
    console.log(`${file.padEnd(22)} ${String(meta.width).padStart(5)}x${String(meta.height).padEnd(5)} ${formatBytes(size)}`);
  }

  console.log(`\ntotal generated ${formatBytes(total)}`);
  console.log(`sky source was ${formatBytes(sourceSize)}`);
  console.log(`built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

await main();
