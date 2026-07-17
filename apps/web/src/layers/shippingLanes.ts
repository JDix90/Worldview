/**
 * Shipping lanes — the world's AIS traffic density (World Bank/IMF "Global
 * Shipping Traffic Density", 2015–2021 cumulative positions) baked once from
 * the source GeoTIFF into a vendored 8192×4096 log-scaled grayscale PNG
 * (bake provenance: DECISIONS #73). Zero runtime API — this is static
 * cartography, like borders. Drape shader is the aerosol uv-from-normal
 * pattern at a lower shell.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';

const OVERLAY_RADIUS = 100.25; // above borders (100.15), below aerosol (100.35)

const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// uv-from-normal exactly as aerosol.ts/aurora.ts — the proven derivation.
const fragmentShader = /* glsl */ `
  uniform sampler2D densityMap;
  uniform float uOpacity;
  varying vec3 vWorldNormal;

  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vWorldNormal);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lng = PI * 0.5 - atan(n.z, n.x);
    lng = mod(lng + PI, 2.0 * PI) - PI;
    vec2 uv = vec2((lng + PI) / (2.0 * PI), (lat + PI * 0.5) / PI);
    float d = texture2D(densityMap, uv).r; // already log-scaled 0..1

    // floor at 0.28: the log scale lifts even single transits; corridors,
    // not speckle, are the story at globe scale
    float a = smoothstep(0.28, 0.8, d) * uOpacity;
    if (a < 0.012) discard;
    // quiet water routes read deep cyan; the great corridors burn pale gold
    vec3 quiet = vec3(0.15, 0.55, 0.70);
    vec3 busy = vec3(1.0, 0.88, 0.55);
    vec3 col = mix(quiet, busy, smoothstep(0.35, 0.9, d));
    gl_FragColor = vec4(col, a);
  }
`;

export const shippingLanesLayer: LayerDef = {
  id: 'lanes',
  label: 'SHIPPING LANES',
  defaultOn: true,
  attribution: 'World Bank/IMF AIS density',
  init(ctx: LayerCtx): LayerInstance {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        densityMap: { value: new THREE.Texture() },
        uOpacity: { value: 0.85 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(OVERLAY_RADIUS, 96, 48), material);
    mesh.renderOrder = 1;
    mesh.visible = false;
    ctx.scene.add(mesh);

    void new THREE.TextureLoader().loadAsync('/textures/ship-density-8k.png').then((tex) => {
      tex.anisotropy = 8;
      material.uniforms.densityMap!.value = tex;
      mesh.visible = true;
    });

    return {
      dispose() {
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
        (material.uniforms.densityMap!.value as THREE.Texture).dispose();
        material.dispose();
      },
    };
  },
};
