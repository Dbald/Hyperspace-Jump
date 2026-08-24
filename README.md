# Hyperspace Jump

[![Netlify Status](https://api.netlify.com/api/v1/badges/1af090d4-9b5a-483b-96e6-34d13534c5c5/deploy-status)](https://app.netlify.com/sites/jolly-babbage-a31b6c/deploys)

Live experience: https://rebeljump.netlify.app/

Double hyperspace jump to evade the Empire.

## What ships

The site is static — open `index.html`, or serve the repository root:

```bash
npm run serve
```

Scene code lives in `js/`:

| file | what it does |
| --- | --- |
| `js/sun.js` | `sun` system: one shared star direction, plus `sun-light` to place the key and fill lights along it |
| `js/planet.js` | `planet` component: PBR surface, drifting cloud deck, ray-marched atmosphere |
| `js/starfield.js` | `starfield` component: point-sprite stars with per-star colour and scintillation |
| `js/model-quality.js` | sampler and shadow-flag tuning applied to the fleet after it loads |

## Asset pipeline

Everything the browser downloads is generated from the sources in `assets/`.
Both generators are deterministic, so re-running them on an unchanged source
reproduces the same output.

```bash
npm install
npm run build          # textures + model
```

### Fleet model

`npm run optimize:model` reads the authored `.gltf` + `.bin` and writes a single
compressed GLB. The pass deduplicates meshes and materials, prunes unreferenced
data and unused vertex attributes, resamples animation keyframes, welds
equivalent vertices, reorders indices for GPU cache locality, stores zero-filled
accessors sparsely, re-encodes textures as WebP, and finally compresses geometry
with Draco.

| | source | previous build | current build |
| --- | --- | --- | --- |
| bytes | 69.71 MB | 37.09 MB | **3.96 MB** |
| meshes | 1094 | 186 | 186 |
| triangles | 1,460,229 | 608,693 | 608,693 |

Geometry, not textures, was the weight: 31.5 MB of the previous 37 MB build was
uncompressed position, normal, UV and index data. Draco brings that down without
touching the animation tracks, all 206 of which survive intact.

The pass also pulls the authored camera clip off a negative start time. It
opened on a keyframe at -0.0333s, which violates the glTF spec and fails
validation; the whole clip is shifted forward by that one frame so its samplers
stay in sync and its keyframe times stay strictly increasing.

Decoding needs the Draco decoder, vendored in `assets/vendor/draco/` so the
deployed site has no third-party runtime dependency. Refresh it whenever the
A-Frame version changes:

```bash
npm run vendor:draco
```

### Planet and sky textures

`npm run build:textures` derives the map set the scene samples from the two
authored images:

| generated file | size | bytes | derived from |
| --- | --- | --- | --- |
| `planet_color.webp` | 4096×2048 | 0.66 MB | graded albedo, seam- and pole-healed, with fractal erosion detail and polar frost |
| `planet_normal.webp` | 2048×1024 | 1.04 MB | Sobel normals from a height field, latitude-corrected and faded flat at the poles |
| `planet_surface.webp` | 1024×512 | 0.15 MB | R = roughness (basins smoother than sand), G = ambient occlusion |
| `planet_clouds.webp` | 2048×1024 | 0.28 MB | procedural wind-belt cloud deck, sheared by latitude |
| `space_sky.webp` | 4000×2000 | 0.09 MB | recompressed and graded nebula backdrop |

Procedural detail is sampled with 3D noise on the unit sphere rather than across
the flat equirectangular plane, which is what keeps it free of pole pinwheels
and a wrap seam.

The backdrop alone went from an 8.37 MB PNG to a 91 KB WebP.

## Rendering

- **Surface** — custom shader with wrapped diffuse for a soft terminator, a
  single-light GGX lobe across the smoother basins, a limb wash toward the sky
  colour, and a reddened band either side of the terminator.
- **Clouds** — a separate shell turning at its own rate. The surface shader
  samples the same map at the running rotation offset, so the deck casts moving
  shadows on the ground below it.
- **Atmosphere** — the view ray is integrated between the shell and the ground
  with a Rayleigh phase term plus forward Mie scattering. Unlike a fresnel rim
  on a back-faced sphere, this puts the glow brightest where the air column is
  actually longest and hazes the disc as well as the limb.
- **Stars** — 5,000 point sprites with weighted main-sequence colours. Baking
  them into the sky texture would need roughly a 16k equirect map to survive
  mipmapping.

## Total download

| | before | after |
| --- | --- | --- |
| fleet model | 37.09 MB | 3.96 MB |
| sky | 8.37 MB | 0.09 MB |
| planet maps | 1.81 MB | 2.14 MB |
| Draco decoder | — | 0.24 MB |
| **total** | **47.27 MB** | **6.43 MB** |

The decoder figure counts the WebAssembly build and its wrapper. The 0.49 MB
JavaScript fallback beside them is only fetched where WebAssembly is missing.

## History

### 2026 refresh

- Rebuilt the fleet pipeline around Draco and WebP; 37.09 MB → 3.96 MB.
- Vendored the Draco decoder instead of relying on a third-party CDN.
- Added a generated planet map set: albedo, normals, roughness, occlusion, clouds.
- Replaced the stacked glow spheres with a ray-marched atmosphere.
- Added cloud shadows, a point-sprite starfield, and a single shared sun direction.
- Recompressed the space backdrop, cutting it by 99%.
- Switched to ACES filmic tone mapping and rebalanced the lighting around it.
- Replaced the branch-pinned auto-commit workflow with a build check that runs
  on pull requests and pushes to `main`.

### 2026 WebXR refresh

- Upgraded A-Frame from 1.3.0 to 1.8.0 and `aframe-extras` to 7.7.0.
- Updated controller entities to A-Frame's current `meta-touch-controls` component.
- Moved the space background to the repository-local asset instead of the retired Glitch-hosted URL.
- Rebuilt the camera/controllers as a single tracked rig.
- Replaced the old long-range spotlights with a cheaper ambient + directional lighting setup.
