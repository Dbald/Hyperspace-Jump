# Draco decoder

glTF-only Draco decoder, copied verbatim from the `three` package that A-Frame
1.8.0 bundles (`super-three@0.184.0`, `examples/jsm/libs/draco/gltf/`).

`three`'s `DRACOLoader` loads `draco_wasm_wrapper.js` + `draco_decoder.wasm` and
falls back to `draco_decoder.js` where WebAssembly is unavailable.

Vendored so the deployed site has no third-party runtime dependency. Refresh
these files whenever the A-Frame (and therefore `three`) version changes:

```bash
npm run vendor:draco
```

Licensed under the Apache License 2.0 by the Draco authors.
