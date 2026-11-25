import assert from 'node:assert/strict';
import * as THREE from 'three';
import { isAtOpening, passedThrough } from '../src/interactions/strategies/d3-portal.ts';

// 壁に開いた穴: 中心は原点、手前は +Z、半径 0.35
const opening = { position: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), radius: 0.35 };
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

Deno.test('穴の手前や差し込んだ先で離すと、穴の上と判定する', () => {
  assert.ok(isAtOpening(v(0, 0, 0.1), opening));
  assert.ok(isAtOpening(v(0.2, 0.1, -0.2), opening));
});

Deno.test('穴から遠い・横にずれた・奥すぎる点は穴の上でない', () => {
  assert.ok(!isAtOpening(v(0, 0, 0.6), opening));
  assert.ok(!isAtOpening(v(0.8, 0, 0.1), opening));
  assert.ok(!isAtOpening(v(0, 0, -0.8), opening));
});

Deno.test('手前から奥へ穴の範囲内を通過すると true', () => {
  assert.ok(passedThrough(v(0, 0, 0.1), v(0, 0, -0.1), opening));
});

Deno.test('穴の外を通る・逆向き・面をまたがない動きは false', () => {
  assert.ok(!passedThrough(v(1, 0, 0.1), v(1, 0, -0.1), opening));
  assert.ok(!passedThrough(v(0, 0, -0.1), v(0, 0, 0.1), opening));
  assert.ok(!passedThrough(v(0, 0, 0.3), v(0, 0, 0.1), opening));
});
