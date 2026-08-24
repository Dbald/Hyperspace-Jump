# Hyperspace Jump

[![Netlify Status](https://api.netlify.com/api/v1/badges/1af090d4-9b5a-483b-96e6-34d13534c5c5/deploy-status)](https://app.netlify.com/sites/jolly-babbage-a31b6c/deploys)

Live experience: https://rebeljump.netlify.app/

Double hyperspace jump to evade the Empire.

## 2026 WebXR refresh

This refresh modernizes the original prototype while preserving the animated fleet sequence.

- Upgraded A-Frame from 1.3.0 to 1.8.0.
- Upgraded `aframe-extras` to 7.5.0.
- Moved the space background to the repository-local asset instead of the retired Glitch-hosted URL.
- Rebuilt the camera/controllers as a single tracked rig.
- Replaced the old long-range spotlights with a cheaper ambient + directional lighting setup.
- Improved planet geometry, PBR response, texture anisotropy, atmospheric rim glow, and surface haze.
- Added runtime material tuning for the fleet without disturbing its animation data.
- Added a repeatable glTF optimization pipeline for the fleet model.

## Fleet optimization

The original animated fleet uses a very large external geometry buffer, so the repository now includes an asset-processing step using glTF Transform.

```bash
npm install
npm run inspect:model
npm run optimize:model
```

The optimization pass deduplicates model data, prunes unused resources, resamples animation data, welds compatible vertices, and writes:

```text
assets/Fleet_Model/rebel_fleet_optimized.glb
```

A GitHub Actions workflow runs the same optimization on the upgrade branch and commits the generated GLB when the result changes. The original `.gltf` + `.bin` files are retained as source assets until the optimized build is validated in-browser and on-headset.
