/**
 * Chunk 1 performance harness (PHASES.md: 60fps with 12k markers) and the
 * rendering prototype for chunk 3's aircraft: heading-oriented instanced
 * markers. Enabled with ?perf (12,000) or ?perf=<count>. Not a data layer.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;

type GlobeApi = {
  getCoords(lat: number, lng: number, altitude?: number): { x: number; y: number; z: number };
};

export function perfMarkerCountFromQuery(search: string): number {
  const params = new URLSearchParams(search);
  if (!params.has('perf')) return 0;
  const n = Number(params.get('perf'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 12000;
}

export function buildPerfMarkers(globe: GlobeApi, count: number): THREE.InstancedMesh {
  const geometry = new THREE.ConeGeometry(0.35, 1.6, 5);
  geometry.rotateX(Math.PI / 2); // cone points +Z so lookAt() sets its heading
  const material = new THREE.MeshBasicMaterial({ color: 0xffc257 });
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const obj = new THREE.Object3D();
  const normal = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const heading = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    // uniform over the sphere, poles excluded (tangent frame degenerates there)
    const lat = Math.asin(Math.random() * 1.9 - 0.95) / DEG;
    const lng = Math.random() * 360 - 180;
    const track = Math.random() * 360 * DEG;

    const p = globe.getCoords(lat, lng, 0.02);
    normal.set(p.x, p.y, p.z).normalize();
    east.set(-normal.z, 0, normal.x).normalize();
    north.crossVectors(normal, east);
    heading
      .copy(east)
      .multiplyScalar(Math.sin(track))
      .addScaledVector(north, Math.cos(track));

    obj.position.set(p.x, p.y, p.z);
    obj.up.copy(normal);
    obj.lookAt(p.x + heading.x, p.y + heading.y, p.z + heading.z);
    obj.updateMatrix();
    mesh.setMatrixAt(i, obj.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
