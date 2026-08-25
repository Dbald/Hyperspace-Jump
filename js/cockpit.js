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

    // An authored viewpoint — a camera or empty placed in the modelling tool
    // at the seat. When the model provides one it wins outright: someone
    // framed that shot deliberately, and no amount of measuring beats it.
    // Blank matches the first camera in the ship. Set to "none" to ignore.
    viewpoint: { default: 'CockpitCam' },

    // Landmarks used to build the ship's frame, matched within its subtree.
    nose: { default: 'Hull_Front' },
    tail: { default: 'Hull_Rear_1' },
    dorsal: { default: 'Hull_Dorsal' },
    ventral: { default: 'Hull_Ventral' },
    // Anchor for the eye. The pilot's own head is where a pilot's eyes are.
    pilot: { default: 'Pilot' },

    // How far below the crown to sit, in metres. 0.10 is the literal forehead;
    // the measured canopy on this ship puts its glass centre about 0.31 below
    // the crown, so this sits between the two — inside the canopy rather than
    // riding on top of it.
    foreheadDrop: { default: 0.22 },
    // How far ahead of the face to place the eye, in metres. Enough to clear
    // the head geometry without floating out of the cockpit.
    faceClearance: { default: 0.06 },
    // Depth of the band below the crown treated as "the head" when finding
    // the front of the face.
    headBand: { default: 0.28 },

    // Manual trim on top of the measured position, in metres.
    forward: { default: 0 },
    up: { default: 0 },
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
    this.viewScale = new THREE.Vector3(1, 1, 1);
    this.viewpoint = null;
    this.fovApplied = false;

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

    if (this.data.doubleSidedCockpit) this.openUpCockpit(ship);

    // An authored viewpoint settles everything the seat needs, so it is
    // checked before the landmark machinery — a purpose-built ship has no hull
    // landmarks to find, and must not be blocked waiting for them.
    this.viewpoint = this.findViewpoint(ship);

    const pilot = findInShip(this.data.pilot);
    if (pilot && this.data.hidePilot) {
      pilot.traverse((node) => { if (node.isMesh) node.visible = false; });
    }

    if (this.viewpoint) {
      this.ship = ship;
      this.parts = { anchor: pilot };
      this.ready = true;
      this.el.sceneEl.emit('cockpit-ready', {
        ship: this.data.ship,
        viewpoint: this.viewpoint.name
      }, false);
      return;
    }

    // No viewpoint: fall back to locating the seat from hull landmarks.
    const parts = {
      nose: findInShip(this.data.nose),
      tail: findInShip(this.data.tail),
      dorsal: findInShip(this.data.dorsal),
      ventral: findInShip(this.data.ventral),
      anchor: pilot
    };

    const missing = Object.entries(parts).filter(([, n]) => !n).map(([k]) => k);
    if (missing.length) {
      console.warn(
        `cockpit: ${this.data.ship} has no "${this.data.viewpoint}" viewpoint, ` +
        `and is missing ${missing.join(', ')} for the fallback`
      );
      return;
    }

    // Uniform scale, so one number converts local extents into world units.
    const worldScale = new THREE.Vector3();
    ship.getWorldScale(worldScale);

    const hull = localExtents(ship);
    this.shipLength = hull ? hull.longest * worldScale.x : 0;
    this.unitsPerMetre = this.shipLength / SHIP_LENGTH_METRES;

    this.ship = ship;
    this.parts = parts;

    this.crown = 0;
    this.face = 0;
    if (this.updateFrame()) this.measurePilot();

    this.ready = true;
    this.el.sceneEl.emit('cockpit-ready', { ship: this.data.ship }, false);
  },

  /**
   * Finds an authored viewpoint inside the ship.
   *
   * A camera exported from the modelling tool carries position, orientation
   * and field of view together, which is everything the seat needs. Cameras
   * and A-Frame agree on convention — both look down -Z with +Y up — so the
   * transform transfers with no correction.
   */
  findViewpoint: function (ship) {
    const wanted = this.data.viewpoint;
    if (!wanted || wanted === 'none') return null;

    const target = sanitizeName(wanted);
    let named = null;
    let firstCamera = null;

    ship.traverse((node) => {
      if (!firstCamera && node.isCamera) firstCamera = node;
      if (!named && node.name && node.name.startsWith(target)) named = node;
    });

    return named || firstCamera;
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

  /**
   * Rebuilds the ship's frame and the pilot anchor from current world state.
   * Runs once at load to measure the pilot, then every frame to fly the rig.
   */
  updateFrame: function () {
    const parts = this.parts;
    if (!worldCentre(parts.nose, this.nose)) return false;
    worldCentre(parts.tail, this.tail);
    worldCentre(parts.dorsal, this.dorsal);
    worldCentre(parts.ventral, this.ventral);
    worldCentre(parts.anchor, this.anchor);

    this.forwardAxis.subVectors(this.nose, this.tail);
    if (this.forwardAxis.length() < 1e-9) return false;
    this.forwardAxis.normalize();

    // Dorsal minus ventral is a real up vector, not a hint.
    this.upAxis.subVectors(this.dorsal, this.ventral);
    this.rightAxis.crossVectors(this.forwardAxis, this.upAxis);
    if (this.rightAxis.lengthSq() < 1e-18) return false;
    this.rightAxis.normalize();
    this.upAxis.crossVectors(this.rightAxis, this.forwardAxis).normalize();

    return true;
  },

  /**
   * Finds the pilot's crown and the front of their face, as distances from
   * their centre along the ship's up and forward axes.
   *
   * Measured from the mesh itself rather than assumed, and the face is taken
   * only from vertices near the crown: a seated pilot's knees reach further
   * forward than their nose, so measuring the whole body would put the camera
   * out past the kneecaps.
   */
  measurePilot: function () {
    const vertex = new THREE.Vector3();
    const delta = new THREE.Vector3();
    const samples = [];
    let crown = -Infinity;

    this.parts.anchor.updateWorldMatrix(true, true);
    this.parts.anchor.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      const position = node.geometry.getAttribute('position');
      if (!position) return;

      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
        delta.subVectors(vertex, this.anchor);
        const along = delta.dot(this.upAxis);
        const ahead = delta.dot(this.forwardAxis);
        if (along > crown) crown = along;
        samples.push(along, ahead);
      }
    });

    if (!samples.length) return false;

    // Head band: the top of the body, where the face is.
    const band = crown - this.data.headBand * this.unitsPerMetre;
    let face = -Infinity;
    for (let i = 0; i < samples.length; i += 2) {
      if (samples[i] >= band && samples[i + 1] > face) face = samples[i + 1];
    }

    this.crown = crown;
    this.face = Number.isFinite(face) ? face : 0;
    return true;
  },

  tick: function () {
    if (!this.ready) return;

    if (this.viewpoint) {
      this.followViewpoint();
      return;
    }

    if (!this.updateFrame()) return;

    const unitsPerMetre = this.unitsPerMetre;

    // Eye height: just below the crown, where a forehead is. Eye depth: just
    // ahead of the face, so the view is inside the cockpit without being
    // inside the pilot's head.
    const rise = this.crown - this.data.foreheadDrop * unitsPerMetre;
    const reach = this.face + this.data.faceClearance * unitsPerMetre;

    this.eye.copy(this.anchor)
      .addScaledVector(this.upAxis, rise + this.data.up * unitsPerMetre)
      .addScaledVector(this.forwardAxis, reach + this.data.forward * unitsPerMetre)
      .addScaledVector(this.rightAxis, this.data.right * unitsPerMetre);

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
        crownAbovePilotCentreMetres: r(this.crown / this.unitsPerMetre),
        faceAheadOfPilotCentreMetres: r(this.face / this.unitsPerMetre),
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

  /**
   * Rides an authored viewpoint node.
   *
   * The node's transform becomes the rig's, so head tracking composes on top
   * of the authored framing rather than fighting it — a fixed camera cannot be
   * used directly in VR, where the headset owns the pose.
   *
   * Its world scale is also the right rig scale: if the ship is authored in
   * metres and then scaled into the scene, that same factor is what converts a
   * real metre of head movement into world units.
   */
  followViewpoint: function () {
    const rig = this.el.object3D;

    this.viewpoint.updateWorldMatrix(true, false);
    this.viewpoint.matrixWorld.decompose(this.eye, this.orientation, this.viewScale);

    rig.position.copy(this.eye);
    rig.quaternion.copy(this.orientation);
    if (this.data.matchScale && this.viewScale.x > 0) rig.scale.setScalar(this.viewScale.x);

    // Adopt the authored field of view on flat screens. In VR the headset
    // dictates it, and overriding would distort the view.
    if (this.viewpoint.isCamera && !this.el.sceneEl.is('vr-mode') && !this.fovApplied) {
      const cameraEl = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
      if (cameraEl) {
        cameraEl.setAttribute('camera', 'fov', this.viewpoint.fov);
        this.fovApplied = true;
      }
    }

    if (this.data.debug && !this.logged) {
      this.logged = true;
      console.log('[cockpit]', JSON.stringify({
        viewpoint: this.viewpoint.name,
        isCamera: !!this.viewpoint.isCamera,
        fov: this.viewpoint.isCamera ? this.viewpoint.fov : null,
        rigScale: Number(this.viewScale.x.toFixed(5)),
        position: this.eye.toArray().map((v) => Number(v.toFixed(3)))
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
