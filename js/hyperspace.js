/* global AFRAME, THREE */

/**
 * The jump.
 *
 * Runs a five-phase sequence — idle, charging, entering, cruising, exiting —
 * and drives three pieces of geometry from it: a field of star streaks that
 * scroll past the viewer, a glowing throat ahead on the travel axis, and a
 * flash held in front of the camera for the transitions.
 *
 * Put this on an entity parented to the camera rig. Everything it builds sits
 * in that entity's local space, so the tunnel travels with the viewer and
 * looking around inside it works the way it should.
 *
 * Fires `hyperspace-phase` on the scene at every phase change, so audio, the
 * fleet sequence and (later) the cockpit can hook in without this component
 * knowing about any of them.
 */

const PHASES = ['idle', 'charging', 'entering', 'cruising', 'exiting'];

const STREAK_VERTEX = `
  attribute vec3 aStart;
  attribute float aSeed;
  attribute vec2 aCorner;

  uniform float uStretch;
  uniform float uScroll;
  uniform float uSpan;
  uniform float uWidth;
  uniform float uStreakLength;

  varying float vAlong;
  varying float vAcross;
  varying float vFade;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    // Scroll along the travel axis, wrapping within the tunnel volume so a
    // fixed set of streaks reads as an endless stream.
    float z = aStart.z - uScroll * (0.6 + aSeed * 0.8);
    z = mod(z + uSpan * 0.5, uSpan) - uSpan * 0.5;

    // A dot at rest, a long ribbon at full stretch.
    float halfLength = mix(uWidth * 0.5, uStreakLength * (0.18 + aSeed * 1.3), uStretch);

    vec3 tail = vec3(aStart.xy, z - halfLength);
    vec3 head = vec3(aStart.xy, z + halfLength);

    vec4 tailView = modelViewMatrix * vec4(tail, 1.0);
    vec4 headView = modelViewMatrix * vec4(head, 1.0);

    float along = aCorner.y * 0.5 + 0.5;
    vec4 position = mix(tailView, headView, along);

    // Widen the ribbon across the screen rather than in world space, so it
    // keeps a constant apparent thickness whichever way the viewer looks.
    vec3 axis = headView.xyz - tailView.xyz;
    float axisLength = length(axis);
    axis = axisLength > 1e-5 ? axis / axisLength : vec3(0.0, 1.0, 0.0);

    vec3 toCamera = normalize(-position.xyz);
    vec3 side = cross(axis, toCamera);
    float sideLength = length(side);
    side = sideLength > 1e-5 ? side / sideLength : vec3(1.0, 0.0, 0.0);

    position.xyz += side * aCorner.x * uWidth;

    vAlong = along;
    vAcross = aCorner.x;
    // Fade at the far end so streaks never visibly pop into existence.
    vFade = 1.0 - smoothstep(0.55, 1.0, abs(z) / (uSpan * 0.5));

    gl_Position = projectionMatrix * position;
    #include <logdepthbuf_vertex>
  }
`;

const STREAK_FRAGMENT = `
  uniform vec3 uColor;
  uniform vec3 uCoreColor;
  uniform float uOpacity;

  varying float vAlong;
  varying float vAcross;
  varying float vFade;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    // Streaks scroll toward -Z, so vAlong = 0 is the leading tip.
    float lead = 1.0 - vAlong;

    // Comet profile: hot at the tip, tapering to nothing along the tail. The
    // taper is what stops each ribbon reading as a hard-ended white bar.
    float profile = pow(lead, 1.6) * smoothstep(0.0, 0.05, lead);

    // Soft edges across the ribbon, so it reads as a line of light and not a
    // flat quad.
    float across = 1.0 - abs(vAcross);
    across *= across;

    vec3 color = mix(uColor, uCoreColor, pow(lead, 3.0));
    float alpha = uOpacity * vFade * profile * across;
    if (alpha < 0.003) discard;

    // Kept under 1.0: filmic tone mapping desaturates bright output, and
    // pushing harder here turns every streak white.
    gl_FragColor = vec4(color * (0.3 + profile * 0.6), alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const GLOW_VERTEX = `
  varying vec2 vUv;
  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const GLOW_FRAGMENT = `
  uniform vec3 uColor;
  uniform vec3 uCoreColor;
  uniform float uOpacity;

  varying vec2 vUv;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    float distance = length(vUv - vec2(0.5)) * 2.0;
    float halo = 1.0 - smoothstep(0.0, 1.0, distance);
    float core = 1.0 - smoothstep(0.0, 0.28, distance);

    vec3 color = mix(uColor, uCoreColor, core);
    float alpha = (halo * halo * 0.7 + core) * uOpacity;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const FLASH_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying vec2 vUv;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    // Brightest at centre so the flash blooms outward rather than reading as
    // a flat white card.
    float distance = length(vUv - vec2(0.5)) * 2.0;
    float falloff = 1.0 - smoothstep(0.05, 0.8, distance);
    float alpha = uOpacity * falloff;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(uColor, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function easeIn (t) {
  return t * t * t;
}

function easeOut (t) {
  return 1 - Math.pow(1 - t, 3);
}

function makeRandom (seed) {
  let state = seed >>> 0;
  return function random () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

AFRAME.registerComponent('hyperspace', {
  schema: {
    streaks: { default: 650 },
    innerRadius: { default: 0.9 },
    outerRadius: { default: 14 },
    span: { default: 90 },
    width: { default: 0.055 },
    streakLength: { default: 14 },
    speed: { default: 150 },

    // Phase durations, in seconds.
    charge: { default: 3.2 },
    enter: { default: 0.9 },
    cruise: { default: 4.5 },
    exit: { default: 0.8 },

    color: { type: 'color', default: '#3f74d8' },
    coreColor: { type: 'color', default: '#cfe2ff' },
    flashColor: { type: 'color', default: '#dbe9ff' },
    flashStrength: { default: 0.6 },

    // Point-sprite starfield to hand off to. Real stars fade as streaks arrive.
    starfield: { type: 'selector' },

    // Widening the field of view sells speed on a flat screen and causes
    // motion sickness in a headset, so it is only ever applied outside VR.
    fovPunch: { default: 14 },
    // Same reasoning: the charge-up rumble is disabled in VR.
    shake: { default: 0.012 },

    seed: { default: 5150 }
  },

  init: function () {
    this.phase = 'idle';
    this.elapsed = 0;
    this.scroll = 0;
    this.velocity = 0;
    this.stretch = 0;
    this.flashAmount = 0;
    this.basePosition = new THREE.Vector3();
    this.baseFov = null;

    this.build();

    this.onKeyDown = this.onKeyDown.bind(this);
    window.addEventListener('keydown', this.onKeyDown);

    // Any controller trigger fires a jump until the cockpit lever exists.
    this.onTrigger = () => this.jump();
    this.el.sceneEl.addEventListener('triggerdown', this.onTrigger);
  },

  build: function () {
    const data = this.data;
    const random = makeRandom(data.seed);
    const group = new THREE.Group();

    const count = data.streaks;
    const starts = new Float32Array(count * 4 * 3);
    const seeds = new Float32Array(count * 4);
    const corners = new Float32Array(count * 4 * 2);
    const indices = new Uint32Array(count * 6);

    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

    for (let i = 0; i < count; i++) {
      // Even area coverage of the annulus needs a square-root radius; a linear
      // one crowds everything against the inner edge.
      const t = random();
      const radius = Math.sqrt(
        t * (data.outerRadius * data.outerRadius - data.innerRadius * data.innerRadius) +
        data.innerRadius * data.innerRadius
      );
      const angle = random() * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const z = (random() - 0.5) * data.span;
      const seed = random();

      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        starts[v * 3] = x;
        starts[v * 3 + 1] = y;
        starts[v * 3 + 2] = z;
        seeds[v] = seed;
        corners[v * 2] = CORNERS[c][0];
        corners[v * 2 + 1] = CORNERS[c][1];
      }

      const base = i * 4;
      indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i * 6);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('aStart', new THREE.BufferAttribute(starts, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // The shader repositions every vertex, so the generated bounds mean nothing.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), data.span);

    this.streakMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uStretch: { value: 0 },
        uScroll: { value: 0 },
        uSpan: { value: data.span },
        uWidth: { value: data.width },
        uStreakLength: { value: data.streakLength },
        uColor: { value: new THREE.Color(data.color) },
        uCoreColor: { value: new THREE.Color(data.coreColor) },
        uOpacity: { value: 0 }
      },
      vertexShader: STREAK_VERTEX,
      fragmentShader: STREAK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });

    this.streaks = new THREE.Mesh(geometry, this.streakMaterial);
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 20;
    this.streaks.visible = false;
    group.add(this.streaks);

    // The throat: where the tunnel is heading.
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(data.color) },
        uCoreColor: { value: new THREE.Color(data.coreColor) },
        uOpacity: { value: 0 }
      },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });

    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), this.glowMaterial);
    this.glow.position.set(0, 0, -data.span * 0.5);
    this.glow.renderOrder = 19;
    this.glow.visible = false;
    group.add(this.glow);

    this.el.setObject3D('hyperspace', group);

    // The flash rides on the camera so it covers the view however the head is
    // turned, and ignores depth so nothing can occlude it.
    this.flashMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(data.flashColor) },
        uOpacity: { value: 0 }
      },
      vertexShader: GLOW_VERTEX,
      fragmentShader: FLASH_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });

    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.flashMaterial);
    this.flash.position.set(0, 0, -0.6);
    this.flash.renderOrder = 100;
    this.flash.visible = false;
    this.flash.frustumCulled = false;

    const cameraEl = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
    if (cameraEl) cameraEl.object3D.add(this.flash);
    this.flashParent = cameraEl;
  },

  onKeyDown: function (event) {
    if (event.code !== 'KeyJ' || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    this.jump();
  },

  /** Begins a jump. Ignored if one is already under way. */
  jump: function () {
    if (this.phase !== 'idle') return false;
    this.basePosition.copy(this.el.object3D.position);
    this.setPhase('charging');
    return true;
  },

  /** Cuts a jump short and drops straight back to normal space. */
  abort: function () {
    if (this.phase === 'idle') return;
    this.setPhase(this.phase === 'charging' ? 'idle' : 'exiting');
  },

  setPhase: function (phase) {
    this.phase = phase;
    this.elapsed = 0;
    this.el.sceneEl.emit('hyperspace-phase', { phase }, false);
  },

  /** Real stars hand off to streaks rather than both being on at once. */
  setStarfieldOpacity: function (value) {
    const el = this.data.starfield;
    const component = el && el.components && el.components.starfield;
    if (component && component.setOpacity) component.setOpacity(value);
  },

  tick: function (time, timeDelta) {
    if (!this.streaks) return;

    const data = this.data;
    const delta = Math.min(timeDelta, 100) / 1000;
    const inVR = this.el.sceneEl.is('vr-mode');
    this.elapsed += delta;

    let stretch = 0;
    let opacity = 0;
    let glow = 0;
    let flash = 0;
    let velocity = 0;
    let shake = 0;
    let starfield = 1;

    if (this.phase === 'charging') {
      const t = Math.min(this.elapsed / data.charge, 1);
      // Nothing visible yet — this phase is all dread, held in the rumble.
      shake = easeIn(t);
      velocity = 0;
      if (t >= 1) this.setPhase('entering');
    } else if (this.phase === 'entering') {
      const t = Math.min(this.elapsed / data.enter, 1);
      stretch = easeIn(t);
      opacity = Math.min(t * 2.2, 1);
      glow = easeIn(t) * 0.8;
      velocity = data.speed * easeIn(t);
      shake = 1 - t;
      starfield = 1 - Math.min(t * 1.6, 1);
      // Punch on the way in.
      flash = Math.pow(Math.max(0, 1 - Math.abs(t - 0.82) / 0.18), 2);
      if (t >= 1) this.setPhase('cruising');
    } else if (this.phase === 'cruising') {
      const t = Math.min(this.elapsed / data.cruise, 1);
      stretch = 1;
      opacity = 1;
      glow = 1;
      velocity = data.speed;
      starfield = 0;
      if (t >= 1) this.setPhase('exiting');
    } else if (this.phase === 'exiting') {
      const t = Math.min(this.elapsed / data.exit, 1);
      stretch = 1 - easeOut(t);
      opacity = 1 - easeOut(t);
      glow = 1 - Math.min(t * 2.4, 1);
      velocity = data.speed * (1 - easeIn(t));
      starfield = Math.min(t * 1.8, 1);
      // And a harder punch on the way out — arrival should startle.
      flash = Math.pow(Math.max(0, 1 - Math.abs(t - 0.12) / 0.16), 2) * 1.3;
      if (t >= 1) this.setPhase('idle');
    }

    this.scroll += velocity * delta;

    const visible = opacity > 0.001;
    this.streaks.visible = visible;
    this.glow.visible = glow > 0.001;
    this.flash.visible = flash > 0.001;

    this.streakMaterial.uniforms.uStretch.value = stretch;
    this.streakMaterial.uniforms.uScroll.value = this.scroll;
    this.streakMaterial.uniforms.uOpacity.value = opacity;
    this.glowMaterial.uniforms.uOpacity.value = glow;
    this.flashMaterial.uniforms.uOpacity.value = flash * data.flashStrength;

    this.setStarfieldOpacity(starfield);

    // Comfort: no induced motion in a headset.
    if (!inVR && data.shake > 0) {
      const jitter = data.shake * shake;
      this.el.object3D.position.set(
        this.basePosition.x + (Math.random() - 0.5) * jitter,
        this.basePosition.y + (Math.random() - 0.5) * jitter,
        this.basePosition.z + (Math.random() - 0.5) * jitter
      );
    } else if (this.phase === 'idle') {
      this.el.object3D.position.copy(this.basePosition);
    }

    this.applyFov(inVR ? 0 : stretch);
  },

  applyFov: function (amount) {
    const cameraEl = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
    if (!cameraEl || !cameraEl.components || !cameraEl.components.camera) return;

    const camera = this.el.sceneEl.camera;
    if (this.baseFov === null) this.baseFov = camera.fov;

    const target = this.baseFov + this.data.fovPunch * amount;
    if (Math.abs(camera.fov - target) < 0.01) return;

    camera.fov = target;
    camera.updateProjectionMatrix();
  },

  remove: function () {
    window.removeEventListener('keydown', this.onKeyDown);
    this.el.sceneEl.removeEventListener('triggerdown', this.onTrigger);
    this.el.removeObject3D('hyperspace');

    if (this.flash && this.flash.parent) this.flash.parent.remove(this.flash);
    for (const mesh of [this.streaks, this.glow, this.flash]) {
      if (mesh) mesh.geometry.dispose();
    }
    for (const material of [this.streakMaterial, this.glowMaterial, this.flashMaterial]) {
      if (material) material.dispose();
    }
  }
});
