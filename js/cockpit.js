/* global AFRAME, THREE */

/**
 * Straps the viewer into an X-wing.
 *
 * The fleet's node hierarchy is flat — there is no per-ship group node to
 * parent to, every part is a sibling carrying its own baked transform and its
 * own animation track, under a container with non-uniform scale. Two
 * consequences shape this component:
 *
 *   1. Reparenting the rig under a ship node would inherit that scale and
 *      shrink the viewer, so the rig is driven each frame instead.
 *   2. Decomposing a world matrix beneath non-uniform scale yields a sheared
 *      quaternion, so orientation is rebuilt from the world positions of three
 *      known parts rather than read off the matrix.
 *
 * The ship's own dimensions calibrate the offsets, so the eye position is
 * expressed in metres and survives any rescaling of the source model.
 */

// An X-wing is about 12.5 m nose to engine.
const XWING_LENGTH_METRES = 12.5;

/**
 * World-space centre of a node's geometry.
 *
 * Every part of a ship shares one transform — the layout between them lives in
 * the vertex data, not in node translations — so `getWorldPosition` returns the
 * same point for the nose as for the tail. The bounding box is what actually
 * distinguishes them.
 */
function worldCentre (node, out) {
  node.updateWorldMatrix(true, false);
  if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
  node.geometry.boundingBox.getCenter(out);
  return out.applyMatrix4(node.matrixWorld);
}

AFRAME.registerComponent('cockpit', {
  schema: {
    // Which of the seven X-wings to ride. '' is the first; '.001' … '.006'
    // select the others.
    ship: { default: '' },

    model: { type: 'selector' },

    // Eye position relative to the canopy, in metres, in the ship's own frame.
    forward: { default: -0.30 },
    up: { default: -0.50 },
    right: { default: 0 },

    // Strip free flight — the viewer is strapped in.
    lockMovement: { default: true },

    // Scale the rig so a real metre of head movement maps to a metre of ship.
    // Without this the viewer is a giant beside a 47 cm toy and the whole
    // cockpit falls inside the near plane.
    matchScale: { default: true },

    debug: { default: false },

    // Live eye-position tuning. Arrow keys move fore/aft and left/right,
    // PageUp/PageDown move up/down, and every nudge logs the values to paste
    // back into the schema. Placing an eye point is a judgement call that
    // needs a real headset, not a number derived from a bounding box.
    tune: { default: false },
    tuneStep: { default: 0.05 }
  },

  init: function () {
    this.parts = null;
    this.ready = false;

    this.nose = new THREE.Vector3();
    this.aft = new THREE.Vector3();
    this.canopy = new THREE.Vector3();
    this.dome = new THREE.Vector3();

    this.forwardAxis = new THREE.Vector3();
    this.upAxis = new THREE.Vector3();
    this.rightAxis = new THREE.Vector3();
    this.basis = new THREE.Matrix4();
    this.orientation = new THREE.Quaternion();
    this.eye = new THREE.Vector3();

    this.onModelLoaded = this.onModelLoaded.bind(this);
    this.onTuneKey = this.onTuneKey.bind(this);
    if (this.data.tune) window.addEventListener('keydown', this.onTuneKey);

    const model = this.data.model;
    if (model) {
      if (model.getObject3D && model.getObject3D('mesh')) this.onModelLoaded();
      else model.addEventListener('model-loaded', this.onModelLoaded);
    }

    if (this.data.lockMovement) this.lockMovement();
  },

  /** The viewer is belted into a seat; only head look should move the view. */
  lockMovement: function () {
    const cameraEl = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
    if (cameraEl && cameraEl.hasAttribute('wasd-controls')) {
      cameraEl.removeAttribute('wasd-controls');
    }
  },

  onModelLoaded: function () {
    const root = this.data.model.getObject3D('mesh');
    if (!root) return;

    const suffix = this.data.ship;
    const named = new Map();
    root.traverse((node) => {
      if (node.name) named.set(node.name, node);
    });

    // Node names carry a per-copy suffix; '' selects the unsuffixed original.
    const find = (fragment) => {
      for (const [name, node] of named) {
        if (!name.includes(fragment)) continue;
        const tail = name.slice(name.indexOf(fragment) + fragment.length);
        if (tail === suffix) return node;
      }
      return null;
    };

    const parts = {
      nose: find('Fuselage_Nose_Fuselage_Nose_0'),
      aft: find('Fuselage_Rear_Material__19941_0'),
      canopy: find('Cockpit_Glass_Glass_0'),
      dome: find('R2_Head_R2_Dome_0')
    };

    const missing = Object.entries(parts).filter(([, node]) => !node).map(([key]) => key);
    if (missing.length) {
      console.warn(`cockpit: could not find ${missing.join(', ')} for ship "${suffix || '(first)'}"`);
      return;
    }

    this.parts = parts;
    this.ready = true;
    this.el.sceneEl.emit('cockpit-ready', { ship: suffix || '(first)' }, false);
  },

  tick: function () {
    if (!this.ready) return;

    const parts = this.parts;
    worldCentre(parts.nose, this.nose);
    worldCentre(parts.aft, this.aft);
    worldCentre(parts.canopy, this.canopy);
    worldCentre(parts.dome, this.dome);

    // Forward runs nose to tail; the dome sitting proud of the hull behind the
    // pilot gives a stable hint for which way is up.
    this.forwardAxis.subVectors(this.nose, this.aft);
    const length = this.forwardAxis.length();
    if (length < 1e-6) return;
    this.forwardAxis.divideScalar(length);

    this.upAxis.subVectors(this.dome, this.aft);
    this.rightAxis.crossVectors(this.forwardAxis, this.upAxis);
    if (this.rightAxis.lengthSq() < 1e-12) return;
    this.rightAxis.normalize();
    // Re-derive up so the basis is orthonormal even though the hint was not.
    this.upAxis.crossVectors(this.rightAxis, this.forwardAxis).normalize();

    // The model's own length fixes the world-units-per-metre scale, so the
    // offsets below stay meaningful if the source model is ever rescaled.
    const unitsPerMetre = length / XWING_LENGTH_METRES;

    this.eye.copy(this.canopy)
      .addScaledVector(this.forwardAxis, this.data.forward * unitsPerMetre)
      .addScaledVector(this.rightAxis, this.data.right * unitsPerMetre)
      .addScaledVector(this.upAxis, this.data.up * unitsPerMetre);

    // A-Frame cameras look down -Z, so the ship's forward is the rig's -Z.
    this.basis.makeBasis(
      this.rightAxis,
      this.upAxis,
      this.forwardAxis.clone().negate()
    );
    this.orientation.setFromRotationMatrix(this.basis);

    const rig = this.el.object3D;
    rig.position.copy(this.eye);
    rig.quaternion.copy(this.orientation);
    if (this.data.matchScale) rig.scale.setScalar(unitsPerMetre);

    if (this.data.debug && !this.logged) {
      this.logged = true;
      console.log('[cockpit]', JSON.stringify({
        shipLengthWorldUnits: Number(length.toFixed(3)),
        unitsPerMetre: Number(unitsPerMetre.toFixed(4)),
        eye: this.eye.toArray().map((v) => Number(v.toFixed(3))),
        nose: this.nose.toArray().map((v) => Number(v.toFixed(3))),
        canopy: this.canopy.toArray().map((v) => Number(v.toFixed(3))),
        dome: this.dome.toArray().map((v) => Number(v.toFixed(3)))
      }));
    }
  },

  onTuneKey: function (event) {
    const step = this.data.tuneStep;
    const moves = {
      ArrowUp: ['forward', step],
      ArrowDown: ['forward', -step],
      ArrowLeft: ['right', -step],
      ArrowRight: ['right', step],
      PageUp: ['up', step],
      PageDown: ['up', -step]
    };

    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();

    const [axis, delta] = move;
    this.el.setAttribute('cockpit', axis, Number((this.data[axis] + delta).toFixed(3)));
    console.log(
      `[cockpit] forward: ${this.data.forward}; up: ${this.data.up}; right: ${this.data.right}`
    );
  },

  remove: function () {
    if (this.data.model) this.data.model.removeEventListener('model-loaded', this.onModelLoaded);
    window.removeEventListener('keydown', this.onTuneKey);
  }
});
