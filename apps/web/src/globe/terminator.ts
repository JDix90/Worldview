/**
 * Globe surface material with a live day/night terminator (FOUNDATION §10).
 * Replaces globe.gl's default material via the `globeMaterial` prop: blends
 * NASA day imagery and night city lights by the sun's true position, with a
 * soft twilight band and subtle terrain relief from the topology map.
 */
import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D topoMap;
  uniform vec3 sunDir;

  varying vec2 vUv;
  varying vec3 vWorldNormal;

  // cos-of-sun-angle half-width of the day/night blend (~7° of arc each side,
  // roughly civil twilight; reads right at globe scale)
  const float TWILIGHT = 0.12;
  const float NIGHT_LIGHTS_GAIN = 2.1;
  // grazing-light floor: the day side dims toward the terminator, never to black
  const float DAY_FLOOR = 0.32;
  const float RELIEF = 4.0;

  void main() {
    vec3 n = normalize(vWorldNormal);

    // Terrain-perturbed normal: finite differences of the topology map applied
    // in the sphere's east/north tangent frame (globe is Y-up, never rotated —
    // globe.gl's auto-rotate orbits the camera, not the mesh).
    vec2 texel = vec2(1.0 / 2048.0, 1.0 / 1024.0);
    float hE = texture2D(topoMap, vUv + vec2(texel.x, 0.0)).r;
    float hW = texture2D(topoMap, vUv - vec2(texel.x, 0.0)).r;
    float hN = texture2D(topoMap, vUv + vec2(0.0, texel.y)).r;
    float hS = texture2D(topoMap, vUv - vec2(0.0, texel.y)).r;
    vec3 east = normalize(vec3(-n.z, 0.0, n.x));
    vec3 north = normalize(cross(n, east));
    vec3 litNormal = normalize(n + RELIEF * ((hW - hE) * east + (hS - hN) * north));

    float mu = dot(n, sunDir);
    float dayMix = smoothstep(-TWILIGHT, TWILIGHT, mu);

    vec3 day = texture2D(dayMap, vUv).rgb
      * (DAY_FLOOR + (1.0 - DAY_FLOOR) * clamp(dot(litNormal, sunDir), 0.0, 1.0));
    vec3 night = texture2D(nightMap, vUv).rgb * NIGHT_LIGHTS_GAIN;

    vec3 col = mix(night, day, dayMix);

    // faint warm band along the terminator itself
    float band = (1.0 - smoothstep(0.0, 0.15, abs(mu))) * 0.14;
    col += vec3(0.30, 0.11, 0.03) * band;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export async function createTerminatorMaterial(): Promise<THREE.ShaderMaterial> {
  const loader = new THREE.TextureLoader();
  const [dayMap, nightMap, topoMap] = await Promise.all([
    loader.loadAsync('/textures/earth-blue-marble.jpg'),
    loader.loadAsync('/textures/earth-night.jpg'),
    loader.loadAsync('/textures/earth-topology.png'),
  ]);
  dayMap.colorSpace = THREE.SRGBColorSpace;
  nightMap.colorSpace = THREE.SRGBColorSpace;
  for (const t of [dayMap, nightMap, topoMap]) {
    t.anisotropy = 8;
  }

  return new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      topoMap: { value: topoMap },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader,
    fragmentShader,
  });
}
