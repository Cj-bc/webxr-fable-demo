import * as THREE from 'three';
import create, { alignedQuaternion, isAlignedToPlane } from '../src/interactions/strategies/c2-stamp.ts';

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

// --- 戦略全体を、小さな偽物の Item / Items / Room で動かすテスト ---

/** z = 0 の壁 (法線は +Z)。点から壁までの距離を返す。 */
const fakeRoom = {
  planeNear(point: THREE.Vector3) {
    const distance = Math.abs(point.z);
    return {
      point: new THREE.Vector3(point.x, point.y, 0),
      normal: new THREE.Vector3(0, 0, point.z < 0 ? -1 : 1),
      distance,
      label: '壁',
    };
  },
};

function setup() {
  type FakeItem = {
    kind: 'photo';
    object: THREE.Group;
    setPose(p: THREE.Vector3, q: THREE.Quaternion): void;
  };
  const all: FakeItem[] = [];
  const held = new Map<object, FakeItem[]>();
  const hands = [{ pulse() {} }, { pulse() {} }];
  const make = (): FakeItem => {
    const object = new THREE.Group();
    const item: FakeItem = {
      kind: 'photo',
      object,
      setPose: (p, q) => {
        object.position.copy(p);
        object.quaternion.copy(q);
      },
    };
    all.push(item);
    return item;
  };
  const items = {
    get all() {
      return all;
    },
    heldBy: (hand: object) => held.get(hand) ?? [],
    holdersOf: (item: FakeItem) => hands.filter((hand) => (held.get(hand) ?? []).includes(item)),
    duplicate: (item: FakeItem) => {
      const copy = make();
      copy.object.position.copy(item.object.position);
      copy.object.quaternion.copy(item.object.quaternion);
      return copy;
    },
  };
  const ctx = {
    items,
    room: fakeRoom,
    audio: { chime() {} },
    app: { input: { hands }, scene: { add() {}, remove() {} } },
  };
  // deno-lint-ignore no-explicit-any
  const interaction = create(ctx as any);
  const update = () => interaction.update?.({} as never);
  const hold = (hand: number, item: FakeItem | null) => held.set(hands[hand], item ? [item] : []);
  return { all, make, hold, update };
}

Deno.test('貼られた写真を持ち上げても、面から離れるまで複製が増えない', () => {
  const { all, make, hold, update } = setup();
  const original = make();
  original.object.position.set(0, 0, 0.3);
  hold(0, original);
  update();
  // 壁に押し当てる: 1 枚貼られる
  original.object.position.set(0, 0, 0.03);
  update();
  assert(all.length === 2, `押し当てで 2 枚になる (${all.length})`);
  const stamped = all[1];
  // 元の写真を手元から離し、もう一方の手で貼られた写真を取る
  original.object.position.set(0, 0, 0.5);
  hold(0, null);
  hold(1, stamped);
  update();
  assert(all.length === 2, `貼られた写真を持った瞬間に増えない (${all.length})`);
  // 面から少し引き剥がす (まだ REARM_DISTANCE 未満)
  stamped.object.position.set(0, 0, 0.08);
  update();
  stamped.object.position.set(0, 0, 0.03);
  update();
  assert(all.length === 2, `面の近くで動かしても増えない (${all.length})`);
});

Deno.test('面から十分離れてから押し当て直すと、また貼れる', () => {
  const { all, make, hold, update } = setup();
  const photo = make();
  photo.object.position.set(0, 0, 0.3);
  hold(0, photo);
  update();
  photo.object.position.set(0, 0, 0.03);
  update();
  assert(all.length === 2, '1 枚目が貼られる');
  photo.object.position.set(0, 0, 0.3);
  update();
  photo.object.position.set(0, 0, 0.03);
  update();
  assert(all.length === 3, `離れてから押し当てると 2 枚目が貼られる (${all.length})`);
});

Deno.test('面に接したまま持ち直した写真は、離れるまで貼らない', () => {
  const { all, make, hold, update } = setup();
  const photo = make();
  photo.object.position.set(0, 0, 0.3);
  hold(0, photo);
  update();
  photo.object.position.set(0, 0, 0.01);
  hold(0, null);
  update();
  hold(1, photo);
  update();
  assert(all.length === 1, `持ち直しで増えない (${all.length})`);
});
