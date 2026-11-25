import * as THREE from 'three';
import { alignedQuaternion, isAlignedToPlane } from '../src/interactions/strategies/c2-stamp.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const wallNormal = new THREE.Vector3(0, 0, 1);

Deno.test('正面が法線を向いた写真は面に沿っている', () => {
  assert(isAlignedToPlane(new THREE.Quaternion(), wallNormal), '真っ直ぐは true');
});

Deno.test('少し傾いた写真は許容し、大きく傾いた・裏向きの写真は許容しない', () => {
  const tilt = (degrees: number, axis: THREE.Vector3) =>
    new THREE.Quaternion().setFromAxisAngle(axis, (degrees * Math.PI) / 180);
  assert(isAlignedToPlane(tilt(15, new THREE.Vector3(1, 0, 0)), wallNormal), '15 度は true');
  assert(!isAlignedToPlane(tilt(40, new THREE.Vector3(1, 0, 0)), wallNormal), '40 度は false');
  assert(!isAlignedToPlane(tilt(180, new THREE.Vector3(0, 1, 0)), wallNormal), '裏向きは false');
});

Deno.test('補正すると正面が法線に一致し、面内の回転は保たれる', () => {
  // 面内で 30 度回してから、x 軸まわりに 15 度傾けた写真
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 12);
  const photo = tilt.clone().multiply(roll);
  const out = alignedQuaternion(photo, wallNormal, new THREE.Quaternion());
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(out);
  assert(front.distanceTo(wallNormal) < 1e-6, '正面が法線に一致する');
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(out);
  const angle = Math.atan2(-up.x, up.y);
  assert(Math.abs(angle - Math.PI / 6) < 0.1, `面内の回転がおおよそ保たれる (${angle})`);
});
