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
  uniform vec2 topoTexel;
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
    float hE = texture2D(topoMap, vUv + vec2(topoTexel.x, 0.0)).r;
    float hW = texture2D(topoMap, vUv - vec2(topoTexel.x, 0.0)).r;
    float hN = texture2D(topoMap, vUv + vec2(0.0, topoTexel.y)).r;
    float hS = texture2D(topoMap, vUv - vec2(0.0, topoTexel.y)).r;
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

/**
 * The material is created before react-globe.gl's renderer exists, so GL
 * capabilities are probed on a throwaway context. Over-max anisotropy is a
 * GL error on some stacks — clamp to what the hardware reports.
 */
function probeGlCaps(): { maxAnisotropy: number; maxTextureSize: number } {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { maxAnisotropy: 4, maxTextureSize: 4096 };
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    const maxAnisotropy = ext ? (gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return { maxAnisotropy, maxTextureSize };
  } catch {
    return { maxAnisotropy: 4, maxTextureSize: 4096 };
  }
}

export async function createTerminatorMaterial(): Promise<THREE.ShaderMaterial> {
  const caps = probeGlCaps();
  if (caps.maxTextureSize < 8192) {
    console.warn(`[terminator] MAX_TEXTURE_SIZE ${caps.maxTextureSize} < 8192 — globe textures will downscale`);
  }
  const loader = new THREE.TextureLoader();
  const [dayMap, nightMap, topoMap] = await Promise.all([
    loader.loadAsync('/textures/earth-day-8k.jpg'),
    loader.loadAsync('/textures/earth-night-8k.jpg'),
    loader.loadAsync('/textures/earth-topo-4k.png'),
  ]);
  dayMap.colorSpace = THREE.SRGBColorSpace;
  nightMap.colorSpace = THREE.SRGBColorSpace;
  for (const t of [dayMap, nightMap, topoMap]) {
    t.anisotropy = Math.min(16, caps.maxAnisotropy);
  }
  const topoImg = topoMap.image as { width: number; height: number };

  return new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      topoMap: { value: topoMap },
      topoTexel: { value: new THREE.Vector2(1 / topoImg.width, 1 / topoImg.height) },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader,
    fragmentShader,
  });
}
