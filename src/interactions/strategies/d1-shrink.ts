import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

// D1 両手で縮めて消す。拡大縮小そのものは Holding / Toys が行い、ここでは
// 両手のつまむ点 (grabPosition) の間隔だけを見て、狭い間隔を保ったら消す。
// 物の大きさでは判定しない: 素手では指がぶつかり、持ち始めの 1/4 まで寄せるのは現実的でないため。

/** この間隔 (m) を下回ったら予告を出し始める。素手で両手を合わせたとき、つまむ点は 5 ～ 8 cm 程度まで寄る */
const WARN_DISTANCE = 0.1;
/** この間隔 (m) 以下を HOLD_SECONDS 保つと消える。素手で無理なく届く、ほぼ両手が触れ合う間隔 */
const DELETE_DISTANCE = 0.07;
/** 消す間隔の判定に持たせる余裕 (m)。認識の揺れで 1 フレーム広がっても、保つ時間をやり直さない */
const DELETE_RELEASE_DISTANCE = 0.085;
/** DELETE_DISTANCE 以下を保つ時間 (秒)。ふつうに縮めて通り過ぎるだけでは消えない長さ */
const HOLD_SECONDS = 0.8;
/**
 * 一度この間隔 (m) 以上に広がった両手持ちでないと、発動しない。
 * 両手がすでに近い状態で持ったとき (小さい写真を両手で持つ、など) に、持った途端に消えるのを防ぐ。
 */
const ARM_DISTANCE = 0.14;
/** 潰している間の予告の色 */
const WARN_COLOR = 0xff4040;
/** 予告の振動の間隔 (秒) */
const WARN_PULSE_INTERVAL = 0.12;

/** 両手持ち 1 回ぶんの判定の状態 */
export interface PinchState {
  /** ARM_DISTANCE 以上に広がったことがあるか */
  armed: boolean;
  /** DELETE_DISTANCE 以下を保っている時間 (秒) */
  held: number;
}

export interface PinchResult {
  /** 予告の強さ 0 ～ 1 (0 なら出さない)。WARN_DISTANCE を下回ると出始め、保つ時間に応じて 1 に近づく */
  warn: number;
  /** 消すべきか */
  done: boolean;
}

export function newPinchState(): PinchState {
  return { armed: false, held: 0 };
}

/**
 * 両手の間隔 (m) と経過時間 (秒) から、予告の強さと削除の可否を求める。state は更新される。
 * 間隔を WARN_DISTANCE より広げれば、必ず取りやめになる (held が 0 に戻り、予告も消える)。
 */
export function stepPinch(state: PinchState, distance: number, dt: number): PinchResult {
  if (distance >= ARM_DISTANCE) state.armed = true;
  if (!state.armed || distance >= WARN_DISTANCE) {
    state.held = 0;
    return { warn: 0, done: false };
  }
  if (distance <= DELETE_DISTANCE) state.held += dt;
  else if (distance > DELETE_RELEASE_DISTANCE) state.held = 0;
  if (state.held >= HOLD_SECONDS) return { warn: 1, done: true };
  // 狭くなるほど濃く出し、予告が出た瞬間からも見えるよう、最低限の強さを持たせる。
  const proximity = (WARN_DISTANCE - distance) / (WARN_DISTANCE - DELETE_DISTANCE);
  const warn = Math.max(Math.min(1, proximity) * 0.5, state.held / HOLD_SECONDS);
  return { warn: Math.max(warn, 0.15), done: false };
}

interface Crush {
  a: HandState;
  b: HandState;
  state: PinchState;
  pulseTimer: number;
  warning: THREE.Mesh | null;
}

const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

const create: InteractionFactory = (ctx) => {
  const crushes = new Map<Item, Crush>();

  const clearWarning = (crush: Crush): void => {
    if (!crush.warning) return;
    crush.warning.removeFromParent();
    (crush.warning.material as THREE.Material).dispose();
    crush.warning.geometry.dispose();
    crush.warning = null;
  };

  const forget = (item: Item): void => {
    const crush = crushes.get(item);
    if (!crush) return;
    clearWarning(crush);
    crushes.delete(item);
  };

  // 物が消えた・持ち方が変わったときに、途中の状態を捨てる。
  ctx.onItems('removing', ({ item }) => forget(item));
  ctx.onItems('release', ({ items }) => items.forEach(forget));

  const showWarning = (item: Item, crush: Crush, warn: number, time: number): void => {
    if (!crush.warning) {
      const material = new THREE.MeshBasicMaterial({ color: WARN_COLOR, transparent: true, depthWrite: false });
      crush.warning = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), material);
      ctx.app.scene.add(crush.warning);
    }
    _box.setFromObject(item.object).getBoundingSphere(_sphere);
    const shake = 1 + 0.08 * Math.sin(time * 60) * warn;
    crush.warning.position.copy(_sphere.center);
    crush.warning.scale.setScalar(Math.max(_sphere.radius, 0.01) * 1.1 * shake);
    (crush.warning.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.5 * warn;
  };

  const step = (item: Item, frame: FrameContext): void => {
    const holders = ctx.items.holdersOf(item);
    if (holders.length !== 2) return forget(item);
    const [a, b] = holders;
    if (!a.tracked || !b.tracked) return;
    let crush = crushes.get(item);
    if (crush && (crush.a !== a || crush.b !== b)) {
      forget(item);
      crush = undefined;
    }
    if (!crush) {
      crush = { a, b, state: newPinchState(), pulseTimer: 0, warning: null };
      crushes.set(item, crush);
    }
    const distance = a.grabPosition.distanceTo(b.grabPosition);
    const { warn, done } = stepPinch(crush.state, distance, frame.dt);

    if (done) {
      const position = item.object.position.clone();
      ctx.items.remove(item);
      ctx.audio.chime(position);
      a.pulse(1, 120);
      b.pulse(1, 120);
      return;
    }
    if (warn > 0) {
      // 素手は振動しないので、見た目の予告 (赤い球) が頼り。コントローラーには振動も返す。
      showWarning(item, crush, warn, frame.time);
      crush.pulseTimer -= frame.dt;
      if (crush.pulseTimer <= 0) {
        crush.pulseTimer = WARN_PULSE_INTERVAL;
        a.pulse(0.2 + 0.4 * warn, 40);
        b.pulse(0.2 + 0.4 * warn, 40);
      }
    } else {
      // 間隔を広げたら取りやめ。予告をやめる。
      clearWarning(crush);
      crush.pulseTimer = 0;
    }
  };

  return {
    id: 'D1',
    label: '縮めて消す',
    category: 'delete',
    disable() {
      for (const crush of crushes.values()) clearWarning(crush);
      crushes.clear();
    },
    update(frame) {
      for (const item of [...ctx.items.all]) step(item, frame);
      for (const item of [...crushes.keys()]) if (!ctx.items.all.includes(item)) forget(item);
    },
  };
};

export default create;
