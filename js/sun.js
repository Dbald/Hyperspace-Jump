/* global AFRAME, THREE */

/**
 * Single source of truth for where the star is.
 *
 * The key light, the planet's terminator, its cloud shading and its atmosphere
 * all have to agree on one direction or the planet reads as lit from two
 * places at once. Everything reads this system rather than carrying its own
 * copy of the vector.
 */
AFRAME.registerSystem('sun', {
  schema: {
    // Direction *towards* the star. A directional light applies the same
    // direction everywhere, so this is all the planet shaders need too.
    direction: { type: 'vec3', default: { x: -0.36, y: 0.30, z: -0.88 } },
    color: { type: 'color', default: '#fff4e0' },
    intensity: { default: 2.6 },
    ambientColor: { type: 'color', default: '#5c7091' },
    ambientIntensity: { default: 0.32 }
  },

  init: function () {
    this.direction = new THREE.Vector3();
    this.updateDirection();
  },

  update: function () {
    this.updateDirection();
    this.el.emit('sun-changed', { direction: this.direction });
  },

  updateDirection: function () {
    const { x, y, z } = this.data.direction;
    this.direction.set(x, y, z);
    if (this.direction.lengthSq() === 0) this.direction.set(0, 0, -1);
    this.direction.normalize();
  }
});

/**
 * Places a light entity along (or opposite) the sun system's direction.
 *
 * Pairs with A-Frame's own `light` component so the scene's default lights
 * still get removed; this only decides where the light sits.
 */
AFRAME.registerComponent('sun-light', {
  schema: {
    distance: { default: 40 },
    // Fill lights sit opposite the key, standing in for nebula bounce.
    opposite: { default: false }
  },

  init: function () {
    this.place = this.place.bind(this);
    this.el.sceneEl.addEventListener('sun-changed', this.place);
    this.place();
  },

  update: function () {
    this.place();
  },

  place: function () {
    const sun = this.el.sceneEl.systems.sun;
    if (!sun) return;

    const distance = this.data.opposite ? -this.data.distance : this.data.distance;
    this.el.object3D.position.copy(sun.direction).multiplyScalar(distance);
  },

  remove: function () {
    this.el.sceneEl.removeEventListener('sun-changed', this.place);
  }
});
