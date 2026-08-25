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
| `js/cockpit.js` | `cockpit` component: straps the viewer into an A-wing and locks out free flight |
| `js/hyperspace.js` | `hyperspace` component: the five-phase jump sequence — streaks, throat, flash |
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

### Cockpit textures

`npm run build:cockpit` generates the interior set, procedurally, in the same
style as the planet maps:

| generated file | size | what it is |
| --- | --- | --- |
| `cockpit_panel_color.webp` | 1024² | tiling hull plating — irregular panels, seams, fasteners, edge wear |
| `cockpit_panel_roughness.webp` | 1024² | worn edges polish up, grimy centres stay matte |
| `cockpit_panel_normal.webp` | 1024² | panel relief and recessed seams |
| `cockpit_console_color.webp` | 2048×1024 | instrument fascia — screens and switchgear |
| `cockpit_console_emissive.webp` | 2048×1024 | the lit parts only: screens and indicator LEDs |

The panels tile: opposite edges are cross-faded, and the panel grid wraps.

The console ships an emissive map because a cockpit lit by its own instruments
reads far better than a flatly lit one, and it disguises how little geometry
the interior actually has. Wire it to `emissiveMap` with `emissive` white and
`emissiveIntensity` around 1, and light the cabin dimly.

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

## The cockpit

`js/cockpit.js` puts the viewer in an A-wing's seat. The A-wing was chosen over
the X-wing for one concrete reason: its canopy is the only genuinely
transparent material in the fleet (`Window`, `alphaMode: BLEND`, alpha 0.07),
so you can see out of it. Its hull parts are also named by anatomy — front,
rear, dorsal, ventral — which lets the ship's frame be derived from real
landmarks instead of guessed at, and it carries a `Pilot` and a `Seat`.

The component is retargetable: the ship name and the five landmark names are
schema properties, not constants.

### Working around the model

**Node names are rewritten on load.** `GLTFLoader` runs every name through
`PropertyBinding.sanitizeNodeName`, which strips characters that are illegal in
animation paths. `A-Wing.001` becomes `A-Wing001`; `xwing2:Hull` becomes
`xwing2Hull`. Names taken from the source file must go through the same
transform before they will match anything.

**Parts are located by bounding-box centre, not node position.** Some ships in
this fleet keep their layout in the vertex data and share a single transform
across every part, so `getWorldPosition` returns the same point for the nose as
for the tail.

**Ship length is measured, not inferred.** Deriving it from the distance
between two hull-part centres understated it by more than half, because neither
centre is anywhere near the nose or the tail. The whole subtree is measured in
the ship's own local frame, which stays stable as the hull rotates.

**The pilot is hidden.** Sitting in the seat means sitting inside their head.

**The cockpit is forced double-sided.** Shells modelled for an exterior view
have their back faces culled and vanish from within. Only the ridden ship gets
this; the rest of the fleet keeps the cheaper single-sided draw.

### Scale

The A-wing is **0.269 world units** nose to tail. Taken as 9.6 m real, one
world unit is about 36 m, and the rig is scaled by the resulting
`unitsPerMetre` (≈0.028) so a real metre of head movement maps to a metre of
ship. Without it the viewer is a giant beside a toy and the whole cockpit falls
inside the near plane.

Scaling the rig means the far plane has to cover the sky measured in player
metres, which pushes `near:far` past a million to one. That is what the
`logarithmicDepthBuffer` renderer flag is for, and why every custom shader in
`js/` carries the `logdepthbuf` chunks: materials that do not opt in render at
the wrong depth.

### Authored viewpoints

If the ship carries a node named by `viewpoint` — a camera or an empty placed
at the seat in the modelling tool — it wins outright, and everything below is
skipped. Someone framed that shot deliberately; no amount of measuring beats
it.

A camera is the best form, carrying position, orientation and field of view in
one node. glTF cameras and A-Frame agree on convention — both look down −Z with
+Y up — so the transform transfers with no correction.

Three details matter:

- **The transform is copied to the rig, not used as the camera.** In VR the
  headset owns the pose, so a fixed camera would fight head tracking. Copying
  it to the rig makes the authored framing the seated origin, with head look
  composing on top.
- **Its world scale becomes the rig scale.** A ship authored in metres and then
  scaled into the scene carries exactly the factor needed to convert a real
  metre of head movement into world units.
- **The field of view is adopted on flat screens only.** In VR the headset
  dictates it and overriding would distort the view.

Blender's glTF exporter has a **Cameras** option that is easy to leave off. The
fleet model in this repository was exported that way: it has a node named
`Camera` and a `CameraAction` animation, but zero camera definitions. A
childless camera exported with that box unchecked disappears entirely.

Cameras survive `npm run optimize:model` intact — transform and field of view
both — so an authored viewpoint can ship through the build.

### Where the eye sits

Used only when the model provides no authored viewpoint.


Just ahead of the pilot's forehead: inside the cockpit, but not inside their
head. Both reference points are measured from the pilot mesh rather than
assumed, in the ship's own frame:

| measurement | A-wing |
| --- | --- |
| crown, above the pilot's centre | 0.685 m |
| face, ahead of the pilot's centre | −0.17 m |

The face reads as *behind* the body centre because a seated pilot's torso and
knees sit forward of their head. For the same reason the front of the face is
taken only from vertices within `headBand` of the crown — measuring the whole
body would put the camera out past the kneecaps.

From there the eye drops `foreheadDrop` below the crown and stands
`faceClearance` ahead of the face. The resulting position, relative to the eye:

| part | ahead | above |
| --- | --- | --- |
| canopy glass | 0.41 m | −0.09 m |
| console | 0.40 m | −0.52 m |
| seat | −0.41 m | −0.50 m |

`foreheadDrop` is the one knob worth touching. At 0.10 the eye is at the
literal forehead and rides above the canopy glass; at about 0.31 it is level
with the glass centre. The default sits between them.

With `cockpit="tune: true"`, arrow keys move fore/aft and left/right,
PageUp/PageDown move up/down, and each nudge logs values to paste back into the
schema defaults.

## The jump

`js/hyperspace.js` runs the sequence the title has always promised. Five phases —
idle, charging, entering, cruising, exiting — drive three pieces of geometry:

- **Streaks** — 650 ribbons in a cylindrical volume around the viewer, scrolling
  and wrapping so a fixed set reads as an endless stream. Each is widened across
  the screen rather than in world space, so it keeps a constant apparent
  thickness whichever way the viewer looks, and is tapered to a comet profile so
  it reads as light rather than a hard-ended quad.
- **Throat** — the glow ahead on the travel axis.
- **Flash** — held in front of the camera, ignoring depth, punched at entry and
  again harder at arrival.

The point-sprite starfield fades as the streaks arrive, so real stars and
streaks are never both drawn at once.

The component lives on an entity parented to the camera rig, so the tunnel
travels with the viewer and looking around inside it behaves correctly. It
fires `hyperspace-phase` on the scene at every transition, which is where
audio, the fleet sequence and the cockpit lever will hook in.

Two effects are deliberately disabled in VR, because both induce motion the
viewer's body does not feel: the field-of-view widening that sells speed on a
flat screen, and the charge-up rumble.

To trigger it: press `J`, squeeze a controller trigger, or call
`document.querySelector('#jump').components.hyperspace.jump()`.

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
