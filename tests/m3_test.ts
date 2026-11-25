import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  HOLD_SECONDS,
  newPalmGestureState,
  PALM_UP_HIDE,
  PALM_UP_SHOW,
  ringPositions,
  ringRadius,
  stepPalmGesture,
} from '../src/interactions/strategies/m3-wrist-ring.ts';

Deno.test('手のひらを保持時間だけ上に向けると輪が出る', () => {
  const state = newPalmGestureState();
  assert.equal(stepPalmGesture(state, 1, true, 0), false);
  assert.equal(stepPalmGesture(state, 1, true, HOLD_SECONDS - 0.01), false);
  assert.equal(stepPalmGesture(state, 1, true, HOLD_SECONDS), true);
});

Deno.test('一瞬返っただけでは出ない', () => {
  const state = newPalmGestureState();
  stepPalmGesture(state, 1, true, 0);
  stepPalmGesture(state, -1, true, 0.25);
  assert.equal(stepPalmGesture(state, 1, true, 0.5), false);
  assert.equal(stepPalmGesture(state, 1, true, 0.5 + HOLD_SECONDS - 0.01), false);
  assert.equal(stepPalmGesture(state, 1, true, 0.5 + HOLD_SECONDS), true);
});

Deno.test('ヒステリシス: 出した後は HIDE を下回るまで出続ける', () => {
  const state = newPalmGestureState();
  stepPalmGesture(state, 1, true, 0);
  stepPalmGesture(state, 1, true, HOLD_SECONDS);
  const between = (PALM_UP_SHOW + PALM_UP_HIDE) / 2;
  assert.equal(stepPalmGesture(state, between, true, 1), true);
  assert.equal(stepPalmGesture(state, PALM_UP_HIDE - 0.01, true, 1.1), false);
  // 隠れた後は、SHOW を超えて保持時間が過ぎるまで出ない
  assert.equal(stepPalmGesture(state, between, true, 1.2), false);
});

Deno.test('物を持っていなければ出ない', () => {
  const state = newPalmGestureState();
  stepPalmGesture(state, 1, true, 0);
  assert.equal(stepPalmGesture(state, 1, false, 1), false);
  assert.equal(state.since, null);
});

Deno.test('実行後 (latched) は、手首を戻すまで再び出ない', () => {
  const state = newPalmGestureState();
  stepPalmGesture(state, 1, true, 0);
  stepPalmGesture(state, 1, true, HOLD_SECONDS);
  state.shown = false;
  state.latched = true;
  assert.equal(stepPalmGesture(state, 1, true, 5), false);
  stepPalmGesture(state, -1, true, 6);
  stepPalmGesture(state, 1, true, 7);
  assert.equal(stepPalmGesture(state, 1, true, 7 + HOLD_SECONDS), true);
});

Deno.test('輪の半径は範囲に収まり、ボタンは等間隔で並ぶ', () => {
  assert.equal(ringRadius(0), 0.14);
  assert.equal(ringRadius(10), 0.45);
  const center = new THREE.Vector3(1, 2, 3);
  const [a, b] = ringPositions(2, 0.2, center, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  assert.ok(Math.abs(a.x - 1.2) < 1e-9 && Math.abs(b.x - 0.8) < 1e-9);
  assert.ok(Math.abs(a.distanceTo(center) - 0.2) < 1e-9);
});
