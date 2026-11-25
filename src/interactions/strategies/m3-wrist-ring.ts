// M3: 物を持っている手を、手のひらが上を向くまで返すと、物の周りに操作 (消す・複製) の輪が浮かぶ。
// もう一方の手の指先で触れると実行され、手首を戻すと輪は消える。
import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import { type ItemAction, ITEM_ACTIONS } from '../actions';
import type { InteractionFactory } from '../types';

/**
 * 手のひらの向きの上向き成分が SHOW を超えたら出し始め、HIDE を下回ったら隠す。
 * 境目で点滅しないよう、出す条件と隠す条件に差をつける (src/features/menu.ts の PALM_UP_SHOW / HIDE と同じ値)。
 */
export const PALM_UP_SHOW = Math.cos(THREE.MathUtils.degToRad(50));
export const PALM_UP_HIDE = Math.cos(THREE.MathUtils.degToRad(65));
/** 手のひらが上を向いてから輪を出すまでの保持時間 (秒)。持ち替えの途中で一瞬返っただけでは出さない。 */
export const HOLD_SECONDS = 0.375;
/** 輪の半径 = 物の半径 + この余白 (m)。物に隠れないようにする。 */
const RING_MARGIN = 0.1;
/** 輪の半径の下限と上限 (m)。小さい物でも指が入る幅を残し、大きい物でも腕が届く範囲に収める。 */
const RING_MIN_RADIUS = 0.14;
const RING_MAX_RADIUS = 0.45;
/** ボタンの直径 (m) */
const BUTTON_SIZE = 0.09;
/** 指先がボタンの中心からこの距離より近づいたら触れたとみなす (m) */
const TOUCH_RADIUS = 0.05;
/** 指先がボタンからこの距離より離れたら、次に触れたときの実行を受け付ける (m)。TOUCH_RADIUS より大きくして境目の揺れを避ける。 */
const TOUCH_RELEASE_RADIUS = 0.08;
/** 触れかけているボタンを大きく見せる倍率 */
const NEAR_SCALE = 1.2;
const CANVAS_SIZE = 128;

/** 輪を出す・隠す判定のための、手ごとの状態 */
export interface PalmGestureState {
  /** 手のひらが上を向きはじめた時刻。向いていなければ null */
  since: number | null;
  /** 輪を出している */
  shown: boolean;
  /** 実行した後、手首を戻すまで再び出さない */
  latched: boolean;
}

export function newPalmGestureState(): PalmGestureState {
  return { since: null, shown: false, latched: false };
}

/**
 * 手首を返す動きの判定を 1 フレーム進める。輪を出すべきなら true を返す。
 * @param palmUp 手のひらの向きの上向き成分 (palmNormal.y)
 * @param holding 物を持っている (持っていなければ、状態もすべて戻す)
 */
export function stepPalmGesture(state: PalmGestureState, palmUp: number, holding: boolean, time: number): boolean {
  if (!holding) {
    state.since = null;
    state.shown = false;
    state.latched = false;
    return false;
  }
  const up = palmUp > (state.shown || state.latched ? PALM_UP_HIDE : PALM_UP_SHOW);
  if (!up) {
    state.since = null;
    state.shown = false;
    state.latched = false;
  } else if (!state.shown && !state.latched) {
    state.since ??= time;
    if (time - state.since >= HOLD_SECONDS) state.shown = true;
  }
  return state.shown;
}

/** 輪の半径 (m)。物の半径に余白を足し、範囲に収める。 */
export function ringRadius(itemRadius: number): number {
  return Math.min(RING_MAX_RADIUS, Math.max(RING_MIN_RADIUS, itemRadius + RING_MARGIN));
}

/**
 * 輪のボタンの位置。right / up は輪の面 (頭の方を向く面) の軸。
 * 1 つ目は右、以降は反時計回りに等間隔 (2 つなら右と左)。
 */
export function ringPositions(
  count: number,
  radius: number,
  center: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
): THREE.Vector3[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return center
      .clone()
      .addScaledVector(right, Math.cos(angle) * radius)
      .addScaledVector(up, Math.sin(angle) * radius);
  });
}

interface RingButton {
  action: ItemAction;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  near: boolean;
}

/** 1 つの手に対して出している輪 */
interface Ring {
  item: Item;
  group: THREE.Group;
  buttons: RingButton[];
  /** 指先が一度ボタンから離れた。輪が出た瞬間に指がボタンの中にあっても、すぐには実行しない。 */
  armed: boolean;
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

function makeLabelTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CANVAS_SIZE;
  const context = canvas.getContext('2d')!;
  const center = CANVAS_SIZE / 2;
  context.fillStyle = 'rgba(20, 24, 40, 0.88)';
  context.beginPath();
  context.arc(center, center, center - 4, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 6;
  context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  context.stroke();
  context.fillStyle = '#fff';
  context.font = 'bold 40px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, center, center);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const create: InteractionFactory = (ctx) => {
  const rings = new Map<HandState, Ring>();
  const states = new Map<HandState, PalmGestureState>();

  const stateOf = (hand: HandState): PalmGestureState => {
    let state = states.get(hand);
    if (!state) states.set(hand, (state = newPalmGestureState()));
    return state;
  };

  const closeRing = (hand: HandState): void => {
    const ring = rings.get(hand);
    if (!ring) return;
    rings.delete(hand);
    ctx.app.scene.remove(ring.group);
    for (const button of ring.buttons) {
      button.mesh.geometry.dispose();
      button.mesh.material.map?.dispose();
      button.mesh.material.dispose();
    }
  };

  const openRing = (item: Item): Ring => {
    const group = new THREE.Group();
    const buttons = ITEM_ACTIONS.map((action): RingButton => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(BUTTON_SIZE, BUTTON_SIZE),
        new THREE.MeshBasicMaterial({
          map: makeLabelTexture(action.label),
          transparent: true,
          toneMapped: false,
          depthTest: false,
        }),
      );
      mesh.renderOrder = 10;
      group.add(mesh);
      return { action, mesh, near: false };
    });
    ctx.app.scene.add(group);
    return { item, group, buttons, armed: false };
  };

  const run = (hand: HandState, ring: Ring, action: ItemAction): void => {
    const position = ring.item.object.position.clone();
    action.run(ctx.items, [ring.item]);
    ctx.audio.chime(position);
    hand.pulse(0.6, 60);
    ctx.app.input.other(hand).pulse(0.8, 80);
    // 輪は閉じる。持ったままの手首を戻すまで、続けて出さない。
    closeRing(hand);
    const state = stateOf(hand);
    state.shown = false;
    state.latched = true;
  };

  const updateHand = (hand: HandState, frame: FrameContext): void => {
    const state = stateOf(hand);
    const held = hand.tracked ? ctx.items.heldBy(hand) : [];
    // 両手で持っている物 (拡大縮小・回転の最中) には出さない。
    const item = held.find((candidate) => ctx.items.holdersOf(candidate).length === 1) ?? null;
    const show = stepPalmGesture(state, hand.palmNormal.y, item !== null, frame.time);

    let ring = rings.get(hand);
    if (ring && (!show || ring.item !== item)) {
      closeRing(hand);
      ring = undefined;
    }
    if (!show || !item) return;
    if (!ring) {
      ring = openRing(item);
      rings.set(hand, ring);
    }

    item.object.updateWorldMatrix(true, true);
    _box.setFromObject(item.object).getBoundingSphere(_sphere);
    const center = _sphere.center.clone();
    const radius = ringRadius(_sphere.radius);
    _right.set(1, 0, 0).applyQuaternion(frame.headQuaternion);
    _up.set(0, 1, 0).applyQuaternion(frame.headQuaternion);
    const positions = ringPositions(ring.buttons.length, radius, center, _right, _up);

    const other = ctx.app.input.other(hand);
    // 触れる側の手が何かをつまんでいる・握っているときは、触れたことにしない (誤って持つ操作と混ざらないように)。
    const canTouch = other.tracked && !other.selecting && !other.squeezing;
    let nearest = Infinity;
    let touched: RingButton | null = null;
    ring.buttons.forEach((button, i) => {
      button.mesh.position.copy(positions[i]);
      button.mesh.quaternion.copy(frame.headQuaternion);
      const distance = canTouch ? other.tipPosition.distanceTo(positions[i]) : Infinity;
      nearest = Math.min(nearest, distance);
      button.near = distance < TOUCH_RADIUS;
      button.mesh.scale.setScalar(button.near ? NEAR_SCALE : 1);
      if (button.near) touched = button;
    });
    if (nearest > TOUCH_RELEASE_RADIUS) ring.armed = true;
    if (touched && ring.armed) run(hand, ring, (touched as RingButton).action);
  };

  return {
    id: 'M3',
    label: '手首の輪',
    category: 'menu',
    disable() {
      for (const hand of [...rings.keys()]) closeRing(hand);
      states.clear();
    },
    update(frame) {
      for (const hand of ctx.app.input.hands) updateHand(hand, frame);
    },
  };
};

export default create;
