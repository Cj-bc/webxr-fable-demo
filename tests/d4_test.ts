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

// --- 素手: 認識が切れたまま戻ってきても消える (実機で見つかった問題の再現) ---

import create from '../src/interactions/strategies/d4-over-shoulder.ts';

type FakeItem = { object: { position: THREE.Vector3 } };

function setup(isHand: boolean) {
  const item: FakeItem = { object: { position: new THREE.Vector3(0.2, 1.5, 0.0) } };
  const hand = {
    isHand,
    tracked: true,
    velocity: new THREE.Vector3(),
    pulses: 0,
    pulse() {
      this.pulses++;
    },
  };
  const removed: FakeItem[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  let held: FakeItem[] = [item];
  const ctx = {
    app: { input: { hands: [hand] } },
    audio: { click() {}, chime() {} },
    items: {
      heldBy: () => held,
      holdersOf: (i: FakeItem) => (held.includes(i) ? [hand] : []),
      remove: (i: FakeItem) => {
        removed.push(i);
        held = held.filter((x) => x !== i);
      },
    },
    onItems: (event: string, l: (e: unknown) => void) => (listeners[event] ??= []).push(l),
  };
  // deno-lint-ignore no-explicit-any
  const interaction = create(ctx as any);
  const frame = (time: number) =>
    // deno-lint-ignore no-explicit-any
    interaction.update!({ time, headPosition: head, headQuaternion: facing } as any);
  return { item, hand, removed, frame, interaction, release: () => {
      // 本物の Items は、離した手の持ち状態を消してから通知する。
      const items = held;
      held = [];
      listeners.release?.forEach((l) => l({ hand, items }));
    },
  };
}

Deno.test('素手: 耳の横で認識が切れて 0.35 秒戻らなければ、戻ったあとにつまみを離す前に消える', () => {
  const s = setup(true);
  for (let t = 0; t <= 0.2; t += 0.05) s.frame(t); // 耳の横 (後ろ 0 m) で追跡中
  s.hand.tracked = false;
  for (let t = 0.25; t <= 0.8; t += 0.05) s.frame(t); // 認識が切れている
  // 手が前に戻って認識が復活し、つまみを離す (物は切れる前の位置のまま)
  s.hand.tracked = true;
  s.item.object.position.set(0, 1.4, -0.4);
  s.frame(0.85);
  s.release();
  assert.equal(s.removed.length, 1);
});

Deno.test('素手: 認識がすぐ戻れば消えない', () => {
  const s = setup(true);
  for (let t = 0; t <= 0.2; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  for (let t = 0.25; t <= 0.45; t += 0.05) s.frame(t);
  s.hand.tracked = true;
  for (let t = 0.5; t <= 0.8; t += 0.05) s.frame(t);
  assert.equal(s.removed.length, 0);
});

Deno.test('素手: 認識が切れている間に頭が大きく回ったら消えない', () => {
  const s = setup(true);
  for (let t = 0; t <= 0.2; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  s.frame(0.25);
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2);
  // deno-lint-ignore no-explicit-any
  for (let t = 0.3; t <= 0.8; t += 0.05) s.interaction.update!({ time: t, headPosition: head, headQuaternion: turned } as any);
  assert.equal(s.removed.length, 0);
});

Deno.test('コントローラー: 認識切れでは消えない (従来どおり離した位置で判定)', () => {
  const s = setup(false);
  for (let t = 0; t <= 0.2; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  for (let t = 0.25; t <= 0.8; t += 0.05) s.frame(t);
  assert.equal(s.removed.length, 0);
});

Deno.test('コントローラー: 領域で 0.35 秒以上とどまってそっと離すと消える', () => {
  const s = setup(false);
  s.item.object.position.set(0.15, 1.5, 0.4);
  for (let t = 0; t <= 0.6; t += 0.05) s.frame(t);
  s.release();
  assert.equal(s.removed.length, 1);
});

import { LOST_SEC, LOST_YAW_MAX, shouldDeleteOnTrackingLoss, yawDelta } from '../src/interactions/strategies/d4-over-shoulder.ts';

Deno.test('認識切れの判定 (純粋関数)', () => {
  assert.equal(shouldDeleteOnTrackingLoss(true, LOST_SEC, 0), true);
  assert.equal(shouldDeleteOnTrackingLoss(false, LOST_SEC + 1, 0), false);
  assert.equal(shouldDeleteOnTrackingLoss(true, LOST_SEC - 0.1, 0), false);
  assert.equal(shouldDeleteOnTrackingLoss(true, LOST_SEC, LOST_YAW_MAX + 0.1), false);
  assert.ok(Math.abs(yawDelta(3.0, -3.0) - (2 * Math.PI - 6)) < 1e-9);
});
