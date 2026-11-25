import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DWELL_SEC, isDeliberateRelease, isOverShoulder, RELEASE_SPEED_MAX } from '../src/interactions/strategies/d4-over-shoulder.ts';

const head = new THREE.Vector3(0, 1.6, 0);
// 正面は -Z
const facing = new THREE.Quaternion();
const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

Deno.test('頭の後ろで肩より上なら領域に入る', () => {
  assert.equal(isOverShoulder(head, facing, at(0.15, 1.5, 0.4)), true);
});

Deno.test('前や真横は領域に入らない', () => {
  assert.equal(isOverShoulder(head, facing, at(0, 1.5, -0.4)), false);
  assert.equal(isOverShoulder(head, facing, at(0.4, 1.5, 0)), false);
});

Deno.test('肩より低い (腰の後ろ) と遠すぎる所は入らない', () => {
  assert.equal(isOverShoulder(head, facing, at(0, 1.0, 0.3)), false);
  assert.equal(isOverShoulder(head, facing, at(0, 1.6, 1.2)), false);
});

Deno.test('向きを変えると後ろも変わる', () => {
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  assert.equal(isOverShoulder(head, turned, at(0, 1.5, 0.4)), false);
  assert.equal(isOverShoulder(head, turned, at(0, 1.5, -0.4)), true);
});

Deno.test('頭を傾けても水平な前方向で判定する', () => {
  const lookDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.8);
  assert.equal(isOverShoulder(head, lookDown, at(0, 1.5, 0.4)), true);
  assert.equal(isOverShoulder(head, lookDown, at(0, 1.5, -0.4)), false);
});

Deno.test('真下を向いていて後ろが決められないときは入らない', () => {
  const straightDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  assert.equal(isOverShoulder(head, straightDown, at(0, 1.5, 0.4)), false);
});

Deno.test('素早く通り抜けた投げと、速い離しは消さない', () => {
  assert.equal(isDeliberateRelease(DWELL_SEC + 0.1, 0.3), true);
  assert.equal(isDeliberateRelease(0.1, 0.3), false);
  assert.equal(isDeliberateRelease(DWELL_SEC + 0.1, RELEASE_SPEED_MAX + 1), false);
});
