/**
 * Deterministic 3D value noise.
 *
 * Sampling in 3D (rather than across the 2:1 equirectangular plane) is what
 * keeps generated planet textures free of the pinwheel artifacts and vertical
 * seam that 2D noise produces once it is wrapped onto a sphere.
 */

const UINT = 0x100000000;

function hash (ix, iy, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / UINT;
}

// Quintic smoothstep: zero first and second derivatives at the lattice points,
// so fBm octaves do not show grid creases.
function fade (t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function valueNoise3 (x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);

  const c000 = hash(ix, iy, iz, seed);
  const c100 = hash(ix + 1, iy, iz, seed);
  const c010 = hash(ix, iy + 1, iz, seed);
  const c110 = hash(ix + 1, iy + 1, iz, seed);
  const c001 = hash(ix, iy, iz + 1, seed);
  const c101 = hash(ix + 1, iy, iz + 1, seed);
  const c011 = hash(ix, iy + 1, iz + 1, seed);
  const c111 = hash(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;

  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;

  return y0 + (y1 - y0) * fz;
}

export function fbm3 (x, y, z, options = {}) {
  const { octaves = 5, frequency = 1, lacunarity = 2.07, gain = 0.5, seed = 0 } = options;
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let f = frequency;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3(x * f, y * f, z * f, seed + i * 101) * amplitude;
    total += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }

  return sum / total;
}

/** Ridged fBm — sharp crests, useful for wind-shear filaments in a cloud deck. */
export function ridged3 (x, y, z, options = {}) {
  const { octaves = 5, frequency = 1, lacunarity = 2.13, gain = 0.5, seed = 0 } = options;
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let f = frequency;

  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise3(x * f, y * f, z * f, seed + i * 131) * 2 - 1);
    sum += n * n * amplitude;
    total += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }

  return sum / total;
}

/** Maps an equirectangular pixel centre to a unit-sphere direction. */
export function equirectDirection (x, y, width, height, out) {
  const lon = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
  const lat = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
  const cosLat = Math.cos(lat);
  out[0] = cosLat * Math.sin(lon);
  out[1] = Math.sin(lat);
  out[2] = cosLat * Math.cos(lon);
  return out;
}

export function clamp01 (value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function smoothstep (edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function mix (a, b, t) {
  return a + (b - a) * t;
}
