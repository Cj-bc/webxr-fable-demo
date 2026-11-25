import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { FrameContext } from '../src/app.ts';
import type { HandState } from '../src/input.ts';
import type { Item } from '../src/items.ts';
import type { InteractionContext } from '../src/interactions/types.ts';
import create, { isTearingMotion } from '../src/interactions/strategies/d2-tear.ts';

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

Deno.test('素手で出せる程度 (相対 0.9 m/s) の破る動きでも破れる', () => {
  assert.equal(isTearingMotion(leftPos, rightPos, v(0, 0, 0.45), v(0, 0, -0.45)), true);
});

/** 破る操作を通しで試すための、最小の偽の環境 */
function setup() {
  const scene = new THREE.Scene();
  const photo = new THREE.Group();
  const mount = new THREE.Mesh(new THREE.PlaneGeometry(0.212, 0.162), new THREE.MeshBasicMaterial());
  const picture = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.15), new THREE.MeshBasicMaterial());
  photo.add(mount, picture);
  scene.add(photo);
  const hand = (handedness: 'left' | 'right', x: number) =>
    ({
      handedness,
      tracked: true,
      grabPosition: v(x, 1.2, -0.4),
      velocity: v(0, 0, 0),
      pulse: () => {},
    }) as unknown as HandState;
  const left = hand('left', -0.15);
  const right = hand('right', 0.15);
  let holders: HandState[] = [left, right];
  const removed: unknown[] = [];
  const item = { kind: 'photo', object: photo } as unknown as Item;
  const ctx = {
    app: { scene },
    audio: { click: () => {} },
    items: {
      all: [item],
      holdersOf: () => holders,
      remove: (target: unknown) => removed.push(target),
    },
  } as unknown as InteractionContext;
  const interaction = create(ctx);
  const frame = (dt: number) => interaction.update?.({ dt } as FrameContext);
  return { left, right, item, removed, frame, release: (hand: HandState) => (holders = holders.filter((h) => h !== hand)) };
}

Deno.test('素手の速さ (相対 0.9 m/s) を数フレーム続けると、写真が破れて消える', () => {
  const t = setup();
  t.left.velocity.set(0, 0, 0.45);
  t.right.velocity.set(0, 0, -0.45);
  for (let i = 0; i < 6; i++) t.frame(1 / 72);
  assert.deepEqual(t.removed, [t.item]);
});

Deno.test('破る動きの途中で片手のつまみが外れても、直後の短い間は破れる', () => {
  const t = setup();
  t.left.velocity.set(0, 0, 1);
  t.right.velocity.set(0, 0, -1);
  t.frame(1 / 72);
  // 速く動かした拍子に右手が外れた。判定は、直前まで両手で持っていた写真に対して続く。
  t.release(t.right);
  for (let i = 0; i < 6; i++) t.frame(1 / 72);
  assert.deepEqual(t.removed, [t.item]);
});

Deno.test('猶予を過ぎて、片手だけになった写真は破れない', () => {
  const t = setup();
  t.release(t.right);
  t.left.velocity.set(0, 0, 1);
  t.right.velocity.set(0, 0, -1);
  for (let i = 0; i < 30; i++) t.frame(1 / 72);
  assert.deepEqual(t.removed, []);
});
