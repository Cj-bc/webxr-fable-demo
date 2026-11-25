import assert from 'node:assert/strict';
import * as THREE from 'three';
import { isTearingMotion } from '../src/interactions/strategies/d2-tear.ts';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// 左手は x=-0.15、右手は x=+0.15。両手を結ぶ線は x 軸
const leftPos = v(-0.15, 1.2, -0.4);
const rightPos = v(0.15, 1.2, -0.4);

Deno.test('片手は手前・もう片手は奥へ素早く動かすと破れる', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(0, 0, 1), v(0, 0, -1)), true);
});

Deno.test('両手を離す (拡大) 動きでは破れない', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(-1.5, 0, 0), v(1.5, 0, 0)), false);
});

Deno.test('片手だけを素早く動かしても破れない', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(0, 0, 0), v(0, 0, -2)), false);
});

Deno.test('同じ向きに動かす (持ち運ぶ) だけでは破れない', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(0, 0, -2), v(0, 0, -2)), false);
});

Deno.test('ゆっくりした回転では破れない', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(0, 0, 0.3), v(0, 0, -0.3)), false);
});

Deno.test('逆向きの動きでも、線に沿った動きの方が大きければ破れない', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(-1.5, 0, 0.7), v(1.5, 0, -0.7)), false);
});
