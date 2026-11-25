import assert from 'node:assert/strict';
import * as THREE from 'three';
import { binBase, followAngle, headYaw, isInsideBin, suckScale } from '../src/interactions/strategies/u2-trash-bin.ts';

Deno.test('headYaw: 正面は 0、左を向くと正、真下は null', () => {
  assert.ok(Math.abs(headYaw(new THREE.Quaternion())!) < 1e-9);
  const left = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  assert.ok(Math.abs(headYaw(left)! - Math.PI / 2) < 1e-9);
  const down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  assert.equal(headYaw(down), null);
});

Deno.test('followAngle: 最短の回り方で近づく', () => {
  const next = followAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.1, 5);
  assert.ok(next > Math.PI - 0.1, '角度の境目をまたいで回る');
  assert.ok(Math.abs(followAngle(1, 1, 0.1, 5) - 1) < 1e-9);
});

Deno.test('binBase: 前方・右手側・頭より下に置く', () => {
  const head = new THREE.Vector3(1, 1.6, 2);
  const base = binBase(head, 0, 1);
  assert.ok(base.x > head.x && base.z < head.z, '右前 (-z が前、+x が右)');
  assert.ok(base.y < head.y - 0.5);
  assert.ok(binBase(head, 0, -1).x < head.x);
});

Deno.test('isInsideBin: 口の中・口の上は入り、横や下は入らない', () => {
  const base = new THREE.Vector3(0, 1, 0);
  assert.ok(isInsideBin(new THREE.Vector3(0, 1.2, 0), base));
  assert.ok(isInsideBin(new THREE.Vector3(0.1, 1.4, 0), base), '口のすぐ上');
  assert.ok(!isInsideBin(new THREE.Vector3(0.4, 1.2, 0), base));
  assert.ok(!isInsideBin(new THREE.Vector3(0, 0.9, 0), base));
  assert.ok(!isInsideBin(new THREE.Vector3(0, 1.8, 0), base));
});

Deno.test('suckScale: 1 から 0 へ縮む', () => {
  assert.equal(suckScale(0), 1);
  assert.ok(suckScale(0.2) > 0.9);
  assert.equal(suckScale(1), 0);
});
