/* global AFRAME, THREE */

/**
 * Straps the viewer into a fighter.
 *
 * Targets an A-wing: its canopy is the only genuinely transparent material in
 * the fleet (`Window`, alpha 0.07), and its hull parts are named by anatomy —
 * front, rear, dorsal, ventral — so the ship's frame can be derived from real
 * landmarks rather than guessed at.
 *
 * Parts are located by the world centre of their bounding box, not by node
 * position: several ships in this fleet keep their layout in the vertex data
 * and share one transform across every part, so node positions coincide.
 *
 * Retargetable to another ship by overriding the part-name fragments, which is
 * why they are schema properties rather than constants.
 */

// An A-wing is about 9.6 m nose to engine.
const SHIP_LENGTH_METRES = 9.6;

/**
 * Matches three's own node-name sanitisation.
 *
 * `GLTFLoader` runs every node name through `PropertyBinding.sanitizeNodeName`,
 * which strips the characters that are illegal in animation paths. A node
 * authored as `A-Wing.001` is called `A-Wing001` by the time it is loaded, and
 * `xwing2:Hull` becomes `xwing2Hull`. Names from the source file therefore have
 * to be put through the same transform before they will match anything.
 */
function sanitizeName (name) {
  return String(name).replace(/\s/g, '_').replace(/[[\]./:]/g, '');
}

/**
 * World-space centre of a node's geometry, including any descendants.
 *
 * A named part may be a group whose meshes hang below it, so this accumulates
 * over the whole subtree rather than reading a single geometry.
 */
function worldCentre (node, out) {
  node.updateWorldMatrix(true, true);

  const box = new THREE.Box3();
  const local = new THREE.Box3();
  let found = false;

  node.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    local.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
    box.union(local);
    found = true;
  });

  if (!found) return null;
  return box.getCenter(out);
}

/**
 * A node's bounding box in its own local frame, and the longest edge of it.
 *
 * Measuring in local space keeps the result stable while the ship flies: a
 * world-space box grows and shrinks as the hull rotates inside it. Deriving
 * length from two part centres — which is what this replaced — understates it
 * badly, because neither centre is anywhere near the nose or the tail.
 */
function localExtents (node) {
  node.updateWorldMatrix(true, true);

  const toLocal = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  const matrix = new THREE.Matrix4();
  let found = false;

  node.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    matrix.multiplyMatrices(toLocal, child.matrixWorld);
    part.copy(child.geometry.boundingBox).applyMatrix4(matrix);
    box.union(part);
    found = true;
  });

  if (!found) return null;

  const size = box.getSize(new THREE.Vector3());
  return { box, size, longest: Math.max(size.x, size.y, size.z) };
}

AFRAME.registerComponent('cockpit', {
  schema: {
    // Which ship to ride. Any node name in the loaded model.
    ship: { default: 'A-Wing.001' },
    model: { type: 'selector' },

    // Landmarks used to build the ship's frame, matched within its subtree.
    nose: { default: 'Hull_Front' },
    tail: { default: 'Hull_Rear_1' },
    dorsal: { default: 'Hull_Dorsal' },
    ventral: { default: 'Hull_Ventral' },
    // Anchor for the eye. The pilot's own head is where a pilot's eyes are.
    pilot: { default: 'Pilot' },

    // Eye offset from the pilot anchor, in metres, in the ship's frame. The
    // anchor is the pilot's body centre, so the eye rises to head height.
    forward: { default: 0 },
    up: { default: 0.3 },
    right: { default: 0 },

    // Sitting in the seat means sitting inside the pilot's head.
    hidePilot: { default: true },
    // Cockpit shells are often modelled for outside viewing, so single-sided
    // walls vanish from within. Render the ridden ship's cockpit both ways.
    doubleSidedCockpit: { default: true },

    lockMovement: { default: true },
    matchScale: { default: true },

    debug: { default: false },
    tune: { default: false },
    tuneStep: { default: 0.05 }
  },

  init: function () {
    this.parts = null;
    this.ready = false;

    this.nose = new THREE.Vector3();
    this.tail = new THREE.Vector3();
    this.dorsal = new THREE.Vector3();
    this.ventral = new THREE.Vector3();
    this.anchor = new THREE.Vector3();

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

    const wanted = sanitizeName(this.data.ship);
    let ship = null;
    const candidates = [];

    root.traverse((node) => {
      if (!node.name) return;
      if (!ship && node.name === wanted) ship = node;
      if (node.name.startsWith(wanted.replace(/\d+$/, ''))) candidates.push(node.name);
    });

    if (!ship) {
      console.warn(
        `cockpit: no node named "${this.data.ship}" (looked for "${wanted}"). ` +
        `Similar: ${candidates.slice(0, 8).join(', ') || 'none'}`
      );
      return;
    }

    // Search within the chosen ship only. Sibling copies carry inconsistent
    // numeric suffixes, so a global name match would pick the wrong hull.
    const findInShip = (fragment) => {
      const target = sanitizeName(fragment);
      let hit = null;
      ship.traverse((node) => {
        if (!hit && node.name && node.name.startsWith(target)) hit = node;
      });
      return hit;
    };

    const parts = {
      nose: findInShip(this.data.nose),
      tail: findInShip(this.data.tail),
      dorsal: findInShip(this.data.dorsal),
      ventral: findInShip(this.data.ventral),
      anchor: findInShip(this.data.pilot)
    };

    const missing = Object.entries(parts).filter(([, n]) => !n).map(([k]) => k);
    if (missing.length) {
      console.warn(`cockpit: ${this.data.ship} is missing ${missing.join(', ')}`);
      return;
    }

    if (this.data.hidePilot) {
      parts.anchor.traverse((node) => { if (node.isMesh) node.visible = false; });
    }

    if (this.data.doubleSidedCockpit) this.openUpCockpit(ship);

    // Uniform scale, so one number converts local extents into world units.
    const worldScale = new THREE.Vector3();
    ship.getWorldScale(worldScale);

    const hull = localExtents(ship);
    this.shipLength = hull ? hull.longest * worldScale.x : 0;
    this.unitsPerMetre = this.shipLength / SHIP_LENGTH_METRES;

    this.ship = ship;
    this.parts = parts;
    this.ready = true;
    this.el.sceneEl.emit('cockpit-ready', { ship: this.data.ship }, false);
  },

  /**
   * Cockpit walls modelled for an exterior view disappear when seen from
   * inside, because their back faces are culled. Only the ridden ship needs
   * this, so the rest of the fleet keeps the cheaper single-sided draw.
   */
  openUpCockpit: function (ship) {
    ship.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      if (!/cockpit|canopy|window|seat/i.test(node.name)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => {
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      });
    });
  },

  tick: function () {
    if (!this.ready) return;

    const parts = this.parts;
    if (!worldCentre(parts.nose, this.nose)) return;
    worldCentre(parts.tail, this.tail);
    worldCentre(parts.dorsal, this.dorsal);
    worldCentre(parts.ventral, this.ventral);
    worldCentre(parts.anchor, this.anchor);

    this.forwardAxis.subVectors(this.nose, this.tail);
    const length = this.forwardAxis.length();
    if (length < 1e-9) return;
    this.forwardAxis.divideScalar(length);

    // Dorsal minus ventral is a real up vector, not a hint.
    this.upAxis.subVectors(this.dorsal, this.ventral);
    this.rightAxis.crossVectors(this.forwardAxis, this.upAxis);
    if (this.rightAxis.lengthSq() < 1e-18) return;
    this.rightAxis.normalize();
    this.upAxis.crossVectors(this.rightAxis, this.forwardAxis).normalize();

    const unitsPerMetre = this.unitsPerMetre;

    this.eye.copy(this.anchor)
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
      const r = (v) => Number(v.toFixed(4));
      console.log('[cockpit]', JSON.stringify({
        ship: this.data.ship,
        shipLengthWorldUnits: r(this.shipLength),
        unitsPerMetre: r(this.unitsPerMetre),
        forwardAxis: this.forwardAxis.toArray().map(r),
        upAxis: this.upAxis.toArray().map(r),
        nose: this.nose.toArray().map(r),
        tail: this.tail.toArray().map(r),
        dorsal: this.dorsal.toArray().map(r),
        ventral: this.ventral.toArray().map(r),
        pilotAnchor: this.anchor.toArray().map(r)
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
