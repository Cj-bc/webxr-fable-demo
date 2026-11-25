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
    // ボールのように、つかんだ位置と物の原点が同じ物として扱う。原点が離れた物は個別のテストで変える。
    grabPosition: item.object.position,
    velocity: new THREE.Vector3(),
    pulses: 0,
    pulse() {
      this.pulses++;
    },
  };
  const removed: FakeItem[] = [];
  const trash: number[] = [];
  const cues: number[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  let held: FakeItem[] = [item];
  const ctx = {
    app: { input: { hands: [hand] } },
    audio: {
      trash: () => trash.push(1),
      zoneCue: () => cues.push(1),
      click() {},
      chime() {},
    },
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
  return { item, hand, removed, trash, cues, frame, interaction, release: () => {
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
  assert.equal(s.trash.length, 1);
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

Deno.test('領域で待ってそっと離す削除でも、捨てる音が鳴る', () => {
  const s = setup(false);
  s.item.object.position.set(0.15, 1.5, 0.4);
  for (let t = 0; t <= 0.6; t += 0.05) s.frame(t);
  s.release();
  assert.equal(s.removed.length, 1);
  assert.equal(s.trash.length, 1);
});

// --- 勢いよく後ろへ振って離すと消える ---

import * as d4 from '../src/interactions/strategies/d4-over-shoulder.ts';

/** 後ろ (+Z) へ speed m/s で動いている手 */
const backward = (s: ReturnType<typeof setup>, speed: number) => s.hand.velocity.set(0, 0, speed);

Deno.test('コントローラー: 速く後ろへ振って耳の横で離すと、待たなくても消えて音が鳴る', () => {
  const s = setup(false);
  s.item.object.position.set(0.2, 1.5, 0.05);
  backward(s, 2);
  s.frame(0);
  s.frame(0.05);
  s.release();
  assert.equal(s.removed.length, 1);
  assert.equal(s.trash.length, 1);
});

Deno.test('コントローラー: 前へ速く投げても消えない', () => {
  const s = setup(false);
  s.item.object.position.set(0, 1.5, -0.4);
  s.hand.velocity.set(0, 0, -3);
  s.frame(0);
  s.release();
  assert.equal(s.removed.length, 0);
});

Deno.test('コントローラー: 速く後ろへ動いていても、体の前で離したら消えない', () => {
  const s = setup(false);
  s.item.object.position.set(0, 1.3, -0.3);
  backward(s, 2);
  s.frame(0);
  s.release();
  assert.equal(s.removed.length, 0);
});

Deno.test('コントローラー: 後ろへ遅く動いて待たずに離しても消えない', () => {
  const s = setup(false);
  s.item.object.position.set(0.2, 1.5, 0.05);
  backward(s, 0.3);
  s.frame(0);
  s.release();
  assert.equal(s.removed.length, 0);
});

Deno.test('素手: 速く後ろへ振った直後に認識が切れると、すぐに消えて音が鳴る', () => {
  const s = setup(true);
  s.item.object.position.set(0.2, 1.5, -0.15);
  backward(s, 2);
  for (let t = 0; t <= 0.1; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  for (let t = 0.15; t <= 0.4; t += 0.05) s.frame(t);
  assert.equal(s.removed.length, 1);
  assert.equal(s.trash.length, 1);
});

Deno.test('素手: 遅い動きで認識が切れたときは、すぐには消えない', () => {
  const s = setup(true);
  s.item.object.position.set(0.2, 1.5, 0.0);
  backward(s, 0.2);
  for (let t = 0; t <= 0.1; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  for (let t = 0.15; t <= 0.3; t += 0.05) s.frame(t);
  assert.equal(s.removed.length, 0);
});

Deno.test('素手: 速く後ろへ振って認識が切れても、頭が大きく回っていれば消えない', () => {
  const s = setup(true);
  s.item.object.position.set(0.2, 1.5, 0.0);
  backward(s, 2);
  for (let t = 0; t <= 0.1; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2);
  // deno-lint-ignore no-explicit-any
  for (let t = 0.15; t <= 0.5; t += 0.05) s.interaction.update!({ time: t, headPosition: head, headQuaternion: turned } as any);
  assert.equal(s.removed.length, 0);
});

Deno.test('素手: 速く後ろへ振って認識が切れても、体の前 (領域の外) なら消えない', () => {
  const s = setup(true);
  s.item.object.position.set(0, 1.4, -0.5);
  backward(s, 2);
  for (let t = 0; t <= 0.1; t += 0.05) s.frame(t);
  s.hand.tracked = false;
  for (let t = 0.15; t <= 0.5; t += 0.05) s.frame(t);
  assert.equal(s.removed.length, 0);
});

Deno.test('領域に入った合図の音は、入るたびに 1 回だけ鳴る', () => {
  const s = setup(false);
  s.item.object.position.set(0, 1.4, -0.5); // 前
  s.frame(0);
  assert.equal(s.cues.length, 0);
  s.item.object.position.set(0.15, 1.5, 0.4); // 領域
  for (let t = 0.1; t <= 0.6; t += 0.05) s.frame(t);
  assert.equal(s.cues.length, 1);
  s.item.object.position.set(0, 1.4, -0.5);
  s.frame(0.7);
  s.item.object.position.set(0.15, 1.5, 0.4);
  for (let t = 2; t <= 2.3; t += 0.05) s.frame(t);
  assert.equal(s.cues.length, 2);
});

// --- 原点が手から離れた物 (線・大きな写真) も、手の位置で判定する ---

Deno.test('原点がワールド原点の線でも、手を頭の後ろで止めて離すと消える', () => {
  const s = setup(false);
  s.hand.grabPosition = new THREE.Vector3(0.15, 1.5, 0.4);
  s.item.object.position.set(0, 0, 0);
  for (let t = 0; t <= 0.6; t += 0.05) s.frame(t);
  s.release();
  assert.equal(s.removed.length, 1);
});

Deno.test('原点が頭の後ろにあっても、手が体の前なら消えない', () => {
  const s = setup(false);
  s.hand.grabPosition = new THREE.Vector3(0, 1.4, -0.4);
  s.item.object.position.set(0.15, 1.5, 0.4);
  for (let t = 0; t <= 0.6; t += 0.05) s.frame(t);
  s.release();
  assert.equal(s.removed.length, 0);
});

Deno.test('勢いよく後ろへ離す判定 (純粋関数)', () => {
  const near = at(0.2, 1.5, 0.05);
  assert.equal(d4.isBackwardThrow(head, facing, near, new THREE.Vector3(0, 0, 2)), true);
  assert.equal(d4.isBackwardThrow(head, facing, near, new THREE.Vector3(0, 0, 0.3)), false);
  assert.equal(d4.isBackwardThrow(head, facing, at(0, 1.3, -0.3), new THREE.Vector3(0, 0, 2)), false);
  assert.equal(d4.isBackwardThrow(head, facing, at(0, 1.5, -0.4), new THREE.Vector3(0, 0, -3)), false);
  assert.equal(d4.shouldDeleteOnFastLoss(true, 0.2, 0), true);
  assert.equal(d4.shouldDeleteOnFastLoss(false, 0.2, 0), false);
  assert.equal(d4.shouldDeleteOnFastLoss(true, 0.01, 0), false);
  assert.equal(d4.shouldDeleteOnFastLoss(true, 0.2, 1), false);
});
