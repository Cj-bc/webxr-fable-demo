import * as THREE from 'three';

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

/** 法線がこれ以上上下を向いていたら、床・机・天井のような水平面として扱う */
const HORIZONTAL_THRESHOLD = 0.6;

export function isHorizontal(normal: THREE.Vector3): boolean {
  return Math.abs(normal.y) > HORIZONTAL_THRESHOLD;
}

/**
 * 面に物を置くときの向きを決める。
 * - 水平面: ローカル +Y が法線、+Z が見ている人の方
 * - 垂直面: ローカル +Z が法線 (壁から手前)、+Y が鉛直上
 *
 * hit-test の姿勢は法線まわりの回転が決まっていないので、自分で決める必要がある。
 */
export function orientOnSurface(
  position: THREE.Vector3,
  normal: THREE.Vector3,
  viewer: THREE.Vector3,
  target: THREE.Quaternion,
): THREE.Quaternion {
  if (isHorizontal(normal)) {
    _y.copy(normal);
    _z.copy(viewer).sub(position);
    _z.addScaledVector(_y, -_z.dot(_y));
    if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1);
    _z.normalize();
  } else {
    _z.copy(normal);
    _y.set(0, 1, 0).addScaledVector(_z, -_z.y).normalize();
  }
  _x.crossVectors(_y, _z);
  return target.setFromRotationMatrix(_matrix.makeBasis(_x, _y, _z));
}
