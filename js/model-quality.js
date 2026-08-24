/* global AFRAME */

/**
 * Runtime tuning applied to the fleet once its glTF has loaded.
 *
 * The animation data is left alone; this only touches sampler state and shadow
 * flags, which the authored model does not specify.
 */
AFRAME.registerComponent('model-quality', {
  schema: {
    anisotropy: { default: 8 }
  },

  init: function () {
    this.el.addEventListener('model-loaded', (event) => {
      const renderer = this.el.sceneEl.renderer;
      const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), this.data.anisotropy);
      const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];

      event.detail.model.traverse((node) => {
        node.frustumCulled = true;
        if (!node.isMesh || !node.material) return;

        // No shadow-casting lights in this scene; skip the shadow passes.
        node.castShadow = false;
        node.receiveShadow = false;

        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          slots.forEach((slot) => {
            if (!material[slot]) return;
            material[slot].anisotropy = anisotropy;
            material[slot].needsUpdate = true;
          });
          material.needsUpdate = true;
        });
      });
    });
  }
});
