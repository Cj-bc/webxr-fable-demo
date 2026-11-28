import * as THREE from 'three';

const light = new THREE.Vector3(-0.4, 0.7, 0.6).normalize();
const normal = new THREE.Vector3();
const color = new THREE.Color();
const material = new THREE.MeshBasicMaterial({
  vertexColors: true,
  toneMapped: false,
  transparent: true,
});

const noDepthWriteMaterial = material.clone();
noDepthWriteMaterial.depthWrite = false;

function part(
  model: THREE.Group,
  geometry: THREE.BufferGeometry,
  tint: number,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  // 環境光の推定結果に左右されないよう、法線から頂点色に陰影を付ける。
  const normals = geometry.getAttribute('normal');
  const colors = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) {
    normal.fromBufferAttribute(normals, i);
    const brightness = 0.44 + 0.56 * Math.max(0, normal.dot(light));
    color.setHex(tint).multiplyScalar(brightness).toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  model.add(mesh);
  return mesh;
}

function ball(): THREE.Group {
  const model = new THREE.Group();
  part(model, new THREE.SphereGeometry(0.39, 24, 16), 0xff854e);
  part(model, new THREE.TorusGeometry(0.388, 0.015, 8, 32), 0xffe3ab).rotation.x = 1.12;
  part(model, new THREE.TorusGeometry(0.388, 0.015, 8, 32), 0xffe3ab).rotation.y = 1.2;
  model.rotation.y = -0.3;
  return model;
}

function block(): THREE.Group {
  const model = new THREE.Group();
  part(model, new THREE.BoxGeometry(0.62, 0.48, 0.62), 0x53d9f7, 0, -0.06);
  for (const x of [-0.15, 0.15]) {
    for (const z of [-0.15, 0.15]) {
      part(model, new THREE.CylinderGeometry(0.09, 0.09, 0.09, 12), 0x95eeff, x, 0.22, z);
    }
  }
  model.rotation.set(0.36, -0.55, 0);
  return model;
}

function placement(): THREE.Group {
  const model = new THREE.Group();
  part(model, new THREE.CylinderGeometry(0.36, 0.36, 0.07, 24), 0x95e6bd, 0, -0.32);
  part(model, new THREE.TorusGeometry(0.23, 0.028, 8, 24), 0x17694e, 0, -0.28).rotation.x = Math.PI / 2;
  part(model, new THREE.CylinderGeometry(0.08, 0.08, 0.26, 12), 0xf9df71, 0, 0.16);
  part(model, new THREE.ConeGeometry(0.18, 0.23, 16), 0xffb641, 0, -0.085).rotation.z = Math.PI;
  model.rotation.x = 0.3;
  return model;
}

function pencil(): THREE.Group {
  const model = new THREE.Group();
  part(model, new THREE.CylinderGeometry(0.115, 0.115, 0.51, 6), 0xffd24e, 0, 0.06);
  part(model, new THREE.CylinderGeometry(0.12, 0.12, 0.045, 12), 0xe3ecff, 0, 0.32);
  part(model, new THREE.CylinderGeometry(0.105, 0.105, 0.09, 12), 0xff7eaa, 0, 0.385);
  part(model, new THREE.CylinderGeometry(0.115, 0.036, 0.15, 6), 0xffe5ba, 0, -0.26);
  part(model, new THREE.ConeGeometry(0.038, 0.08, 8), 0x455069, 0, -0.374).rotation.z = Math.PI;
  model.rotation.z = -0.62;
  return model;
}

function portal(): THREE.Group {
  const model = new THREE.Group();
  part(model, new THREE.TorusGeometry(0.30, 0.06, 12, 32), 0xaa80ff).scale.y = 1.16;
  part(model, new THREE.SphereGeometry(0.285, 24, 12), 0x382775, 0, 0, -0.025).scale.set(1, 1.16, 0.18);
  part(model, new THREE.OctahedronGeometry(0.11), 0x91fff7, -0.06, 0.03, 0.05);
  part(model, new THREE.OctahedronGeometry(0.05), 0xf6defe, 0.12, -0.13, 0.04);
  model.rotation.y = -0.25;
  return model;
}

const factories = new Map<string, () => THREE.Group>([
  ['ball', ball],
  ['block', block],
  ['place', placement],
  ['draw', pencil],
  ['portal', portal],
]);
const templates = new Map<string, THREE.Group>();

/** 道具を表すミニチュア。複数の選択 UI でジオメトリとマテリアルを共有する。 */
export function createToolModel(
  id: string,
  { renderOrder = 102, depthWrite = true } = {},
): THREE.Group | undefined {
  const factory = factories.get(id);
  if (!factory) return;
  let template = templates.get(id);
  if (!template) {
    template = factory();
    templates.set(id, template);
  }
  const model = template.clone();
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.renderOrder = renderOrder;
      if (!depthWrite) object.material = noDepthWriteMaterial;
    }
  });
  return model;
}
