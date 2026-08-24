/* global AFRAME, THREE */

/**
 * The planet: a lit PBR surface, an independently drifting cloud deck, and a
 * ray-marched atmosphere shell, all driven by the scene's `sun` system.
 *
 * The three shells are built here rather than as separate <a-sphere> entities
 * because they have to share the sun direction, the planet centre and the
 * relative rotation between surface and clouds (which is what lets the surface
 * shader cast cloud shadows onto the ground).
 */

const TAU = Math.PI * 2;

const SURFACE_VERTEX = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);

    // Analytic tangent along the sphere's longitude direction. A UV sphere has
    // no tangent attribute and generating one would cost an extra vertex
    // buffer for a frame we can derive in two instructions.
    vec3 tangent = vec3(-normal.z, 0.0, normal.x);
    float tangentLength = length(tangent);
    tangent = tangentLength > 1e-4 ? tangent / tangentLength : vec3(1.0, 0.0, 0.0);
    vWorldTangent = normalize(mat3(modelMatrix) * tangent);

    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

const SURFACE_FRAGMENT = `
  uniform sampler2D uColorMap;
  uniform sampler2D uNormalMap;
  uniform sampler2D uSurfaceMap;
  uniform sampler2D uCloudMap;

  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uNightColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uTwilightColor;
  uniform vec2 uNormalScale;
  uniform float uSunIntensity;
  uniform float uSaturation;
  uniform float uCloudOffset;
  uniform float uCloudShadow;
  uniform float uSpecular;
  uniform float uRimStrength;

  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    vec3 geometryNormal = normalize(vWorldNormal);
    vec3 tangent = normalize(vWorldTangent - geometryNormal * dot(geometryNormal, vWorldTangent));
    vec3 bitangent = cross(geometryNormal, tangent);

    vec3 tangentNormal = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
    tangentNormal.xy *= uNormalScale;
    vec3 normal = normalize(mat3(tangent, bitangent, geometryNormal) * tangentNormal);

    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 lightDirection = uSunDirection;

    vec3 albedo = texture2D(uColorMap, vUv).rgb;

    // Filmic tone mapping desaturates bright output; pre-saturating the albedo
    // keeps the ochres and basin greens present in the lit hemisphere.
    float albedoLuma = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    albedo = max(mix(vec3(albedoLuma), albedo, uSaturation), 0.0);

    vec2 surface = texture2D(uSurfaceMap, vUv).rg;
    float roughness = clamp(surface.r, 0.06, 1.0);
    float occlusion = surface.g;

    // The cloud deck turns at its own rate, so its shadow is sampled at the
    // running offset between the two rotations.
    float coverage = texture2D(uCloudMap, vec2(vUv.x + uCloudOffset, vUv.y)).r;
    float shadow = 1.0 - coverage * uCloudShadow;

    float ndl = dot(normal, lightDirection);

    // Wrapped diffuse. A hard Lambert terminator reads as a cut-out edge;
    // wrapping and then sharpening restores a planetary falloff.
    float wrap = 0.20;
    float diffuse = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
    diffuse = pow(diffuse, 1.35);

    // Single-light GGX lobe. Mostly visible across the smoother basins, which
    // is what makes them read as flats rather than dark paint.
    vec3 halfVector = normalize(lightDirection + viewDirection);
    float alpha = roughness * roughness;
    float alphaSq = alpha * alpha;
    float ndh = max(dot(normal, halfVector), 0.0);
    float denominator = ndh * ndh * (alphaSq - 1.0) + 1.0;
    float specular = min(alphaSq / (3.14159265 * denominator * denominator), 6.0);
    specular *= smoothstep(0.0, 0.12, ndl) * uSpecular * (1.0 - roughness);

    vec3 sunlight = uSunColor * uSunIntensity;

    vec3 color = albedo * sunlight * diffuse * occlusion * shadow;
    color += albedo * uNightColor * (1.0 - diffuse) * occlusion;
    color += sunlight * specular * shadow;

    // Air column between viewer and ground: the lit limb washes toward the
    // sky colour instead of staying fully saturated to the silhouette.
    float limb = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.2);
    color += uAtmosphereColor * limb * uRimStrength * smoothstep(-0.15, 0.35, ndl);

    // Reddened scattering in the narrow band either side of the terminator.
    // Kept subtle: the atmosphere shell carries most of this.
    float twilight = exp(-(ndl * ndl) / 0.018);
    color += uTwilightColor * twilight * (0.2 + limb) * 0.22;

    gl_FragColor = vec4(color, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const CLOUD_VERTEX = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

const CLOUD_FRAGMENT = `
  uniform sampler2D uCloudMap;
  uniform vec3 uSunDirection;
  uniform vec3 uLitColor;
  uniform vec3 uShadeColor;
  uniform vec3 uTwilightColor;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    float coverage = texture2D(uCloudMap, vUv).r;
    if (coverage < 0.01) discard;

    vec3 normal = normalize(vWorldNormal);
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);

    float ndl = dot(normal, uSunDirection);
    float daylight = smoothstep(-0.28, 0.30, ndl);

    vec3 color = mix(uShadeColor, uLitColor, daylight);

    // Warm the cloud tops where they straddle the terminator.
    float twilight = exp(-(ndl * ndl) / 0.05);
    color = mix(color, uTwilightColor, twilight * 0.55);

    // The deck sits fractionally above the ground, so without this it would
    // poke past the planet's silhouette as a hard collar.
    float facing = max(dot(normal, viewDirection), 0.0);
    float edgeFade = smoothstep(0.0, 0.16, facing);

    gl_FragColor = vec4(color, coverage * uOpacity * edgeFade);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const ATMOSPHERE_VERTEX = `
  varying vec3 vWorldPosition;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

/**
 * Integrates scattering along the view ray between the atmosphere shell and
 * the ground. Compared with the usual "fresnel rim on a back-faced sphere",
 * this puts the glow brightest where the air column is actually longest — at
 * the planet's own silhouette — and it hazes the disc as well as the ring.
 */
const ATMOSPHERE_FRAGMENT = `
  uniform vec3 uCenter;
  uniform vec3 uSunDirection;
  uniform vec3 uSkyColor;
  uniform vec3 uTwilightColor;
  uniform float uPlanetRadius;
  uniform float uAtmosphereRadius;
  uniform float uDensityFalloff;
  uniform float uIntensity;
  uniform float uMieStrength;

  varying vec3 vWorldPosition;

  const int STEPS = 8;
  const float PI = 3.14159265;

  // Returns near and far intersection distances, or (-1, -1) on a miss.
  vec2 raySphere (vec3 origin, vec3 direction, vec3 center, float radius) {
    vec3 offset = origin - center;
    float b = dot(offset, direction);
    float c = dot(offset, offset) - radius * radius;
    float discriminant = b * b - c;
    if (discriminant < 0.0) return vec2(-1.0);
    float root = sqrt(discriminant);
    return vec2(-b - root, -b + root);
  }

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    vec3 origin = cameraPosition;
    vec3 direction = normalize(vWorldPosition - cameraPosition);

    vec2 shell = raySphere(origin, direction, uCenter, uAtmosphereRadius);
    if (shell.y < 0.0) discard;

    float near = max(shell.x, 0.0);
    float far = shell.y;

    vec2 ground = raySphere(origin, direction, uCenter, uPlanetRadius);
    if (ground.x > 0.0) far = min(far, ground.x);
    if (far <= near) discard;

    float thickness = uAtmosphereRadius - uPlanetRadius;
    float stepSize = (far - near) / float(STEPS);

    float mu = dot(direction, uSunDirection);
    float rayleighPhase = 0.75 * (1.0 + mu * mu);
    float g = 0.76;
    float miePhase = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));

    vec3 accumulated = vec3(0.0);

    for (int i = 0; i < STEPS; i++) {
      vec3 samplePoint = origin + direction * (near + stepSize * (float(i) + 0.5));
      vec3 up = normalize(samplePoint - uCenter);

      float altitude = (length(samplePoint - uCenter) - uPlanetRadius) / thickness;
      float density = exp(-clamp(altitude, 0.0, 1.0) * uDensityFalloff) * stepSize / thickness;

      // How lit this parcel of air is, with a soft planetary terminator.
      float sunAngle = dot(up, uSunDirection);
      float sunlight = smoothstep(-0.30, 0.12, sunAngle);

      // Air near the terminator has travelled through more atmosphere, so it
      // arrives reddened.
      vec3 tint = mix(uTwilightColor, uSkyColor, smoothstep(-0.05, 0.40, sunAngle));

      accumulated += density * sunlight * tint;
    }

    vec3 scattered = accumulated * (rayleighPhase + miePhase * uMieStrength) * uIntensity;

    gl_FragColor = vec4(scattered, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Wraps an <a-assets> <img> in a texture, waiting for decode if needed. */
function textureFromAsset (image, colorSpace, anisotropy, label) {
  if (!image) {
    console.warn(`planet: missing texture asset for ${label}`);
    return null;
  }

  const texture = new THREE.Texture(image);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;

  if (!image.complete) {
    image.addEventListener('load', () => { texture.needsUpdate = true; }, { once: true });
  }

  return texture;
}

AFRAME.registerComponent('planet', {
  schema: {
    radius: { default: 200 },
    segments: { default: 160 },

    colorMap: { type: 'selector' },
    normalMap: { type: 'selector' },
    surfaceMap: { type: 'selector' },
    cloudMap: { type: 'selector' },

    // Seconds per full rotation.
    dayLength: { default: 300 },
    cloudDayLength: { default: 210 },

    normalScale: { default: 0.9 },
    // Ground brightness relative to the atmosphere above it. Raising the two
    // together keeps the balance; this one sets how lit the terrain reads.
    sunIntensity: { default: 2.2 },
    saturation: { default: 1.3 },
    specular: { default: 0.22 },
    rimStrength: { default: 0.25 },
    cloudShadow: { default: 0.42 },
    cloudOpacity: { default: 0.40 },
    cloudAltitude: { default: 0.008 },

    atmosphereHeight: { default: 0.075 },
    atmosphereIntensity: { default: 0.20 },
    atmosphereDensityFalloff: { default: 3.4 },
    mieStrength: { default: 0.40 },

    skyColor: { type: 'color', default: '#8fc0ff' },
    twilightColor: { type: 'color', default: '#ff9a52' },
    nightColor: { type: 'color', default: '#141d31' },
    cloudColor: { type: 'color', default: '#f4f1ea' }
  },

  init: function () {
    this.surfaceAngle = 0;
    this.cloudAngle = 0;
    this.center = new THREE.Vector3();

    const renderer = this.el.sceneEl.renderer;
    this.anisotropy = renderer ? Math.min(renderer.capabilities.getMaxAnisotropy(), 8) : 1;

    this.build();
  },

  build: function () {
    const data = this.data;
    const sun = this.el.sceneEl.systems.sun;
    const group = new THREE.Group();

    const colorMap = textureFromAsset(data.colorMap, THREE.SRGBColorSpace, this.anisotropy, 'colorMap');
    const normalMap = textureFromAsset(data.normalMap, THREE.NoColorSpace, this.anisotropy, 'normalMap');
    const surfaceMap = textureFromAsset(data.surfaceMap, THREE.NoColorSpace, this.anisotropy, 'surfaceMap');
    const cloudMap = textureFromAsset(data.cloudMap, THREE.NoColorSpace, this.anisotropy, 'cloudMap');

    this.textures = [colorMap, normalMap, surfaceMap, cloudMap].filter(Boolean);

    const sunColor = new THREE.Color(sun.data.color);
    const skyColor = new THREE.Color(data.skyColor);
    const twilightColor = new THREE.Color(data.twilightColor);
    const nightColor = new THREE.Color(data.nightColor);

    this.surfaceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorMap: { value: colorMap },
        uNormalMap: { value: normalMap },
        uSurfaceMap: { value: surfaceMap },
        uCloudMap: { value: cloudMap },
        uSunDirection: { value: sun.direction.clone() },
        uSunColor: { value: sunColor.clone() },
        uNightColor: { value: nightColor.clone() },
        uAtmosphereColor: { value: skyColor.clone() },
        uTwilightColor: { value: twilightColor.clone() },
        uNormalScale: { value: new THREE.Vector2(data.normalScale, data.normalScale) },
        uSunIntensity: { value: data.sunIntensity },
        uSaturation: { value: data.saturation },
        uCloudOffset: { value: 0 },
        uCloudShadow: { value: data.cloudShadow },
        uSpecular: { value: data.specular },
        uRimStrength: { value: data.rimStrength }
      },
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT
    });

    this.surface = new THREE.Mesh(
      new THREE.SphereGeometry(data.radius, data.segments, data.segments / 2),
      this.surfaceMaterial
    );
    group.add(this.surface);

    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCloudMap: { value: cloudMap },
        uSunDirection: { value: sun.direction.clone() },
        uLitColor: { value: new THREE.Color(data.cloudColor) },
        uShadeColor: { value: nightColor.clone().multiplyScalar(1.6) },
        uTwilightColor: { value: twilightColor.clone() },
        uOpacity: { value: data.cloudOpacity }
      },
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: false
    });

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(
        data.radius * (1 + data.cloudAltitude),
        Math.round(data.segments * 0.75),
        Math.round(data.segments * 0.375)
      ),
      this.cloudMaterial
    );
    this.clouds.renderOrder = 5;
    group.add(this.clouds);

    const atmosphereRadius = data.radius * (1 + data.atmosphereHeight);

    this.atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uSunDirection: { value: sun.direction.clone() },
        uSkyColor: { value: skyColor.clone() },
        uTwilightColor: { value: twilightColor.clone() },
        uPlanetRadius: { value: data.radius },
        uAtmosphereRadius: { value: atmosphereRadius },
        uDensityFalloff: { value: data.atmosphereDensityFalloff },
        uIntensity: { value: data.atmosphereIntensity },
        uMieStrength: { value: data.mieStrength }
      },
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide
    });

    // Built slightly larger than the volume the shader integrates, so the
    // faceted silhouette of the mesh never clips the outermost glow.
    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(atmosphereRadius * 1.02, 64, 32),
      this.atmosphereMaterial
    );
    this.atmosphere.renderOrder = 10;
    group.add(this.atmosphere);

    this.el.setObject3D('planet', group);
  },

  tick: function (time, timeDelta) {
    if (!this.surface) return;

    const data = this.data;
    const seconds = timeDelta / 1000;

    this.surfaceAngle = (this.surfaceAngle + (TAU / data.dayLength) * seconds) % TAU;
    this.cloudAngle = (this.cloudAngle + (TAU / data.cloudDayLength) * seconds) % TAU;

    this.surface.rotation.y = this.surfaceAngle;
    this.clouds.rotation.y = this.cloudAngle;

    // Where the deck currently sits relative to the ground below it.
    this.surfaceMaterial.uniforms.uCloudOffset.value =
      (this.surfaceAngle - this.cloudAngle) / TAU;

    this.atmosphere.getWorldPosition(this.center);
    this.atmosphereMaterial.uniforms.uCenter.value.copy(this.center);
  },

  remove: function () {
    this.el.removeObject3D('planet');

    for (const material of [this.surfaceMaterial, this.cloudMaterial, this.atmosphereMaterial]) {
      if (material) material.dispose();
    }
    for (const mesh of [this.surface, this.clouds, this.atmosphere]) {
      if (mesh) mesh.geometry.dispose();
    }
    for (const texture of this.textures || []) texture.dispose();
  }
});
