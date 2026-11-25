import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

// 物を持っている間だけ腰のあたりに現れるゴミ箱。中で離す・投げ入れると、縮みながら吸い込まれて消える。

/** ゴミ箱の寸法 (m)。口の半径・底の半径・高さ */
const BIN_RADIUS_TOP = 0.17;
const BIN_RADIUS_BOTTOM = 0.12;
const BIN_HEIGHT = 0.28;
/** 頭の真下から見た、ゴミ箱の底の高さ (頭より下に何 m か)。手を下ろせば届く腰の高さ。 */
const BIN_DROP = 0.72;
/** 底が床より下に潜らないようにする下限 (m) */
const BIN_MIN_BASE_HEIGHT = 0.25;
/** 頭の向き (水平成分) の前方・横方向へのずれ (m)。横は物を持っている手の側へ寄せる。 */
const BIN_FORWARD = 0.3;
const BIN_SIDE = 0.28;
/** 頭の向きに追従する速さ (1 / 秒)。小さいほどゆっくり。歩いても見失わず、首振りには付いてこない程度。 */
const YAW_FOLLOW_RATE = 1.6;
/** 位置 (頭の動き) に追従する速さ (1 / 秒) */
const POSITION_FOLLOW_RATE = 6;
/** 頭の向きの水平成分がこれより短いとき (真下・真上を向いている) は、向きを更新しない */
const MIN_HORIZONTAL_FORWARD = 0.2;
/** 出入りのアニメーションの速さ (1 / 秒)。1 / この値 秒ほどで出入りが終わる。 */
const APPEAR_RATE = 7;
/** 口の判定を、見た目より広げる余裕 (m)。手や物の位置の誤差を吸収する。 */
const CATCH_MARGIN = 0.04;
/** 口の上で物を受け止める高さ (m)。投げ入れた物や、手を口の上で離した写真も入れる。 */
const CATCH_ABOVE = 0.18;
/** 離したボール・ブロックの位置を見続ける時間 (秒)。それまでに中へ入らなければ、ただ投げた物として扱う。 */
const WATCH_SECONDS = 3;
/** 吸い込まれて消えるアニメーションの長さ (秒) */
const SUCK_SECONDS = 0.32;
/** 手を口の中に入れたときの、ゴミ箱の発光の強さ */
const HOVER_EMISSIVE = 0.55;

const UP = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _box = new THREE.Box3();

/** 頭の向きの水平成分の角度 (rad。-z 方向を向いて 0)。真下・真上でほぼ水平成分が無ければ null。 */
export function headYaw(quaternion: THREE.Quaternion): number | null {
  _forward.set(0, 0, -1).applyQuaternion(quaternion);
  if (Math.hypot(_forward.x, _forward.z) < MIN_HORIZONTAL_FORWARD) return null;
  return Math.atan2(-_forward.x, -_forward.z);
}

/** 角度 current を target へ、最短の回り方で追わせる。rate は 1 / 秒。 */
export function followAngle(current: number, target: number, dt: number, rate: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.exp(-rate * dt));
}

/**
 * ゴミ箱の底の中心。頭の位置から、向き yaw の前方に BIN_FORWARD、横 (side: 右 +1 / 左 -1) に BIN_SIDE、
 * BIN_DROP だけ下。
 */
export function binBase(head: THREE.Vector3, yaw: number, side: number, target = new THREE.Vector3()): THREE.Vector3 {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // 前方 f の右手側は (-fz, fx)
  target.set(head.x + fx * BIN_FORWARD + -fz * side * BIN_SIDE, 0, head.z + fz * BIN_FORWARD + fx * side * BIN_SIDE);
  target.y = Math.max(head.y - BIN_DROP, BIN_MIN_BASE_HEIGHT);
  return target;
}

/** 点 point が、底の中心 base のゴミ箱の口の中 (または口のすぐ上) にあるか */
export function isInsideBin(point: THREE.Vector3, base: THREE.Vector3): boolean {
  if (point.y < base.y || point.y > base.y + BIN_HEIGHT + CATCH_ABOVE) return false;
  // 高さに応じて半径が変わる (底が細い)。口より上は口の半径で受ける。
  const t = THREE.MathUtils.clamp((point.y - base.y) / BIN_HEIGHT, 0, 1);
  const radius = THREE.MathUtils.lerp(BIN_RADIUS_BOTTOM, BIN_RADIUS_TOP, t) + CATCH_MARGIN;
  return Math.hypot(point.x - base.x, point.z - base.z) <= radius;
}

/** 吸い込みアニメーションの進み具合 (0 ～ 1) から、大きさの倍率 (1 → 0)。最初は少し膨らんでから縮む。 */
export function suckScale(progress: number): number {
  const p = THREE.MathUtils.clamp(progress, 0, 1);
  return (1 - p * p) * (1 + 0.15 * Math.sin(p * Math.PI));
}

/** 物の中心 (外接ボックスの中心)。線は object の原点が中心とは限らないので、これで見る。 */
function centerOf(item: Item, target: THREE.Vector3): THREE.Vector3 {
  _box.setFromObject(item.object);
  if (_box.isEmpty()) return target.copy(item.object.position);
  return _box.getCenter(target);
}

interface Watch {
  item: Item;
  hand: HandState;
  remaining: number;
}

interface Suck {
  ghost: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  startScale: number;
  elapsed: number;
}

const create: InteractionFactory = (ctx) => {
  const scene = ctx.app.scene;

  // --- 見た目 ---
  const material = new THREE.MeshStandardMaterial({
    color: 0x4a5560,
    roughness: 0.6,
    metalness: 0.2,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.78,
    emissive: 0x2fd0ff,
    emissiveIntensity: 0,
  });
  const body = new THREE.CylinderGeometry(BIN_RADIUS_TOP, BIN_RADIUS_BOTTOM, BIN_HEIGHT, 24, 1, true);
  const bottom = new THREE.CircleGeometry(BIN_RADIUS_BOTTOM, 24);
  const rim = new THREE.TorusGeometry(BIN_RADIUS_TOP, 0.012, 8, 32);
  // root の原点が底の中心
  const root = new THREE.Group();
  root.visible = false;
  const bodyMesh = new THREE.Mesh(body, material);
  bodyMesh.position.y = BIN_HEIGHT / 2;
  const bottomMesh = new THREE.Mesh(bottom, material);
  bottomMesh.rotation.x = -Math.PI / 2;
  bottomMesh.position.y = 0.002;
  const rimMesh = new THREE.Mesh(rim, material);
  rimMesh.rotation.x = Math.PI / 2;
  rimMesh.position.y = BIN_HEIGHT;
  root.add(bodyMesh, bottomMesh, rimMesh);

  // --- 状態 ---
  let enabled = false;
  let shown = 0; // 出入りの進み具合 (0: 隠れている、1: 出きっている)
  let yaw = 0;
  let side = 1;
  let placed = false; // 出現位置を決めたか
  const base = new THREE.Vector3();
  const targetBase = new THREE.Vector3();
  let watches: Watch[] = [];
  let sucks: Suck[] = [];
  let hovering = false;

  const heldHands = (): HandState[] => ctx.app.input.hands.filter((hand) => ctx.items.heldBy(hand).length > 0);

  /** 物を消す。消える物のコピーを縮めながら吸い込ませ、本物はすぐ Items から外す。 */
  const swallow = (item: Item, hand: HandState): void => {
    const ghost = item.object.clone(true);
    const from = item.object.position.clone();
    const startScale = ghost.scale.x;
    const to = base.clone();
    to.y += BIN_HEIGHT * 0.45;
    ctx.items.remove(item);
    scene.add(ghost);
    sucks.push({ ghost, from, to, startScale, elapsed: 0 });
    ctx.audio.chime(to);
    hand.pulse(0.6, 45);
  };

  const unwatch = (item: Item): void => {
    watches = watches.filter((w) => w.item !== item);
  };

  const center = new THREE.Vector3();

  ctx.onItems('release', ({ hand, items }) => {
    if (!enabled || shown < 0.5) return;
    for (const item of items) {
      if (item.kind === 'ball' || item.kind === 'block') {
        // 物理のある物は、離した後の動きを見る。口の中で離した場合も次のフレームで拾う。
        watches.push({ item, hand, remaining: WATCH_SECONDS });
      } else if (isInsideBin(centerOf(item, center), base) || isInsideBin(hand.grabPosition, base)) {
        swallow(item, hand);
      }
    }
  });
  ctx.onItems('grab', ({ items }) => {
    for (const item of items) unwatch(item);
  });
  ctx.onItems('removing', ({ item }) => unwatch(item));

  const update = (frame: FrameContext): void => {
    const dt = frame.dt;
    const holders = heldHands();
    const wantShown = holders.length > 0 || watches.length > 0;

    // 出入り。物を持っていないときは、離した物を見ている間だけ残す。
    shown = THREE.MathUtils.clamp(shown + (wantShown ? 1 : -1) * dt * APPEAR_RATE, 0, 1);

    const targetYaw = headYaw(frame.headQuaternion);
    if (wantShown && !placed) {
      // 現れる瞬間は、頭の向きと持っている手の側へ即座に置く。
      if (targetYaw !== null) yaw = targetYaw;
      const first = holders[0];
      side = first ? (first.handedness === 'right' ? 1 : -1) : side;
      binBase(frame.headPosition, yaw, side, base);
      placed = true;
    } else if (placed) {
      if (targetYaw !== null) yaw = followAngle(yaw, targetYaw, dt, YAW_FOLLOW_RATE);
      binBase(frame.headPosition, yaw, side, targetBase);
      base.lerp(targetBase, 1 - Math.exp(-POSITION_FOLLOW_RATE * dt));
    }
    if (shown <= 0 && !wantShown) placed = false;

    root.visible = shown > 0;
    if (root.visible) {
      root.position.copy(base);
      // 出入りは、下から立ち上がるように縮尺をかける (ぷるんと少し行き過ぎる)
      const eased = 1 - (1 - shown) ** 3;
      const overshoot = shown < 1 ? 1 + 0.12 * Math.sin(shown * Math.PI) : 1;
      root.scale.setScalar(Math.max(eased * overshoot, 0.0001));
    }

    // 持っている手が口の中に入ったら光らせ、入った瞬間に軽く振動を返す。
    const hovered = holders.find((hand) => isInsideBin(hand.grabPosition, base));
    if (hovered && !hovering && shown >= 1) hovered.pulse(0.2, 15);
    hovering = !!hovered;
    material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, hovering ? HOVER_EMISSIVE : 0, 1 - Math.exp(-15 * dt));

    // 離したボール・ブロックが口の中へ入ったら消す。
    for (const watch of [...watches]) {
      watch.remaining -= dt;
      if (!ctx.items.all.includes(watch.item) || watch.remaining <= 0) {
        unwatch(watch.item);
      } else if (shown >= 0.5 && isInsideBin(centerOf(watch.item, center), base)) {
        unwatch(watch.item);
        swallow(watch.item, watch.hand);
      }
    }

    // 吸い込みアニメーション: 底の方へ寄りながら縮み、回る。
    for (const suck of [...sucks]) {
      suck.elapsed += dt;
      const progress = suck.elapsed / SUCK_SECONDS;
      if (progress >= 1) {
        scene.remove(suck.ghost);
        sucks.splice(sucks.indexOf(suck), 1);
        continue;
      }
      suck.ghost.position.lerpVectors(suck.from, suck.to, progress * progress);
      suck.ghost.scale.setScalar(Math.max(suck.startScale * suckScale(progress), 0.0001));
      suck.ghost.rotateOnWorldAxis(UP, dt * 12);
    }
  };

  return {
    id: 'U2',
    label: '腰のゴミ箱',
    category: 'delete',
    enable() {
      enabled = true;
      scene.add(root);
    },
    disable() {
      enabled = false;
      scene.remove(root);
      root.visible = false;
      for (const suck of sucks) scene.remove(suck.ghost);
      sucks = [];
      watches = [];
      shown = 0;
      placed = false;
      hovering = false;
      material.emissiveIntensity = 0;
    },
    update,
  };
};

export default create;
