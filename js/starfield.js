/* global AFRAME, THREE */

/**
 * Point-sprite starfield.
 *
 * Baking stars into the sky texture would need roughly a 16k equirect map to
 * survive mipmapping, so they are drawn as points instead: a few thousand
 * vertices stay pin-sharp at any resolution and cost almost nothing.
 */

const STAR_VERTEX = `
  attribute float aSize;
  attribute float aPhase;

  uniform float uTime;
  uniform float uPixelRatio;

  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vColor = color;
    // Scintillation, at a different rate per star.
    vTwinkle = 0.72 + 0.28 * sin(uTime * 1.6 + aPhase * 6.2831853);

    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const STAR_FRAGMENT = `
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    // Soft round profile with a brighter core, so bright stars read as points
    // with a little bloom rather than as squares.
    float distance = length(gl_PointCoord - vec2(0.5));
    float disc = smoothstep(0.5, 0.0, distance);
    float core = smoothstep(0.22, 0.0, distance);
    float alpha = (disc * 0.55 + core * 0.45) * vTwinkle;
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(vColor * vTwinkle, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Rough main-sequence colours from hot blue-white through to cool orange.
const STAR_COLORS = [
  [0.62, 0.74, 1.00],
  [0.78, 0.85, 1.00],
  [0.94, 0.96, 1.00],
  [1.00, 1.00, 0.96],
  [1.00, 0.94, 0.80],
  [1.00, 0.83, 0.64]
];

// Weighted so most stars are faint and white; the vivid ones stay rare.
const STAR_COLOR_WEIGHTS = [0.05, 0.14, 0.30, 0.26, 0.17, 0.08];

function pickColor (random) {
  let roll = random();
  for (let i = 0; i < STAR_COLORS.length; i++) {
    roll -= STAR_COLOR_WEIGHTS[i];
    if (roll <= 0) return STAR_COLORS[i];
  }
  return STAR_COLORS[2];
}

/** Small deterministic PRNG so the sky is identical on every load. */
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

AFRAME.registerComponent('starfield', {
  schema: {
    count: { default: 5000 },
    radius: { default: 2400 },
    minSize: { default: 1.1 },
    maxSize: { default: 4.4 },
    brightness: { default: 1.0 },
    seed: { default: 20260824 }
  },

  init: function () {
    const data = this.data;
    const random = makeRandom(data.seed);

    const positions = new Float32Array(data.count * 3);
    const colors = new Float32Array(data.count * 3);
    const sizes = new Float32Array(data.count);
    const phases = new Float32Array(data.count);

    for (let i = 0; i < data.count; i++) {
      // Uniform on the sphere: cosine-distributed latitude, not linear.
      const cosLat = random() * 2 - 1;
      const sinLat = Math.sqrt(Math.max(0, 1 - cosLat * cosLat));
      const lon = random() * Math.PI * 2;

      positions[i * 3] = data.radius * sinLat * Math.cos(lon);
      positions[i * 3 + 1] = data.radius * cosLat;
      positions[i * 3 + 2] = data.radius * sinLat * Math.sin(lon);

      // Cubed roll: plenty of faint stars, a handful of bright ones.
      const magnitude = Math.pow(random(), 3);
      sizes[i] = data.minSize + magnitude * (data.maxSize - data.minSize);

      const color = pickColor(random);
      const luminosity = (0.45 + magnitude * 0.55) * data.brightness;
      colors[i * 3] = color[0] * luminosity;
      colors[i * 3 + 1] = color[1] * luminosity;
      colors[i * 3 + 2] = color[2] * luminosity;

      phases[i] = random();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const renderer = this.el.sceneEl.renderer;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: renderer ? renderer.getPixelRatio() : 1 }
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.el.setObject3D('starfield', this.points);
  },

  tick: function (time) {
    if (this.material) this.material.uniforms.uTime.value = time / 1000;
  },

  remove: function () {
    this.el.removeObject3D('starfield');
    if (this.points) this.points.geometry.dispose();
    if (this.material) this.material.dispose();
  }
});
