// C4 振って増やす: ボール・ブロックを片手で持って小刻みに振ると、2 つに分裂する。
import * as THREE from 'three';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

/** 「振っている」とみなす手の速さ (m/s)。これ未満の動きは、向きが反転しても数えない。 */
export const MIN_SHAKE_SPEED = 0.8;
/** 分裂に必要な、向きの反転の回数。投げる前の振りかぶり (1 回の往復 = 反転 1 ～ 2 回) では届かない値にする。 */
export const REQUIRED_REVERSALS = 4;
/** この時間 (秒) の間に REQUIRED_REVERSALS 回反転したら分裂する。小刻みに振り続けた場合だけ満たす。 */
export const SHAKE_WINDOW = 1;
/** 速い動きがこの時間 (秒) 途切れたら、前の向きを忘れる (止めてから動かし直したら、別の振りとして数える)。 */
export const SHAKE_GAP = 0.35;
/** 向きが反転したとみなす内積の上限 (単位ベクトルどうし)。斜めに曲がっただけでは数えない。 */
const REVERSAL_DOT = -0.3;

/** 手の速度から、小刻みな振りを見つける。時刻は秒、速度は m/s。純粋な計算なのでテストできる。 */
export class ShakeDetector {
  private readonly reversals: number[] = [];
  private lastDir: [number, number, number] | null = null;
  private lastFastTime = -Infinity;

  /** 速度を 1 サンプル入れる。分裂する振りになったら true */
  push(time: number, vx: number, vy: number, vz: number): boolean {
    this.prune(time);
    const speed = Math.hypot(vx, vy, vz);
    if (speed >= MIN_SHAKE_SPEED) {
      const dir: [number, number, number] = [vx / speed, vy / speed, vz / speed];
      if (time - this.lastFastTime > SHAKE_GAP) this.lastDir = null;
      const last = this.lastDir;
      if (last && dir[0] * last[0] + dir[1] * last[1] + dir[2] * last[2] < REVERSAL_DOT) {
        this.reversals.push(time);
      }
      this.lastDir = dir;
      this.lastFastTime = time;
    }
    return this.reversals.length >= REQUIRED_REVERSALS;
  }

  /** 分裂まで何割来ているか (0 ～ 1)。予告の見た目に使う。 */
  get progress(): number {
    return Math.min(1, this.reversals.length / REQUIRED_REVERSALS);
  }

  reset(): void {
    this.reversals.length = 0;
    this.lastDir = null;
    this.lastFastTime = -Infinity;
  }

  private prune(time: number): void {
    while (this.reversals.length > 0 && time - this.reversals[0] > SHAKE_WINDOW) this.reversals.shift();
  }
}

/** 分裂のあと、次の分裂まで待つ時間の上限 (秒) */
const COOLDOWN_MAX = 1.5;
/** 手をこの速さ (m/s) より遅くして CALM_TIME (秒) 続ければ、上限を待たずに次の分裂ができる */
const CALM_SPEED = 0.3;
const CALM_TIME = 0.25;
/** 予告で、分裂直前に膨らませる割合 */
const SWELL = 0.2;
/** 元と複製の間に空ける、直径に対する余白の割合と、最低限の隙間 (m) */
const GAP_RATIO = 0.15;
const GAP_MIN = 0.03;

interface HandShake {
  detector: ShakeDetector;
  /** この時刻まで分裂しない */
  cooldownUntil: number;
  calmSince: number | null;
  /** 予告で膨らませている物と、元の大きさ、最後に自分が設定した大きさ */
  swelling: { item: Item; base: number; set: number } | null;
}

const create: InteractionFactory = (ctx) => {
  const states = new Map<HandState, HandShake>();
  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();
  const tmpOffset = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const headRight = new THREE.Vector3();

  const stateOf = (hand: HandState): HandShake => {
    let state = states.get(hand);
    if (!state) {
      state = { detector: new ShakeDetector(), cooldownUntil: 0, calmSince: null, swelling: null };
      states.set(hand, state);
    }
    return state;
  };

  /** 予告で膨らませた見た目を戻す。両手の拡大縮小などで大きさが変わっていたら、触らない。 */
  const unswell = (state: HandShake): void => {
    const swelling = state.swelling;
    state.swelling = null;
    if (swelling && Math.abs(swelling.item.object.scale.x - swelling.set) < 1e-6) {
      swelling.item.object.scale.setScalar(swelling.base);
    }
  };

  const heldShakable = (hand: HandState): Item | null => {
    const held = ctx.items.heldBy(hand);
    if (held.length !== 1) return null;
    const item = held[0];
    return item.kind === 'ball' || item.kind === 'block' ? item : null;
  };

  const split = (hand: HandState, item: Item): void => {
    const copy = ctx.items.duplicate(item);
    if (!copy) return;
    // 大きさは膨らませた後の見た目を戻してから測る (呼び出し前に unswell 済み)。
    tmpBox.setFromObject(copy.object).getSize(tmpSize);
    const diameter = Math.max(tmpSize.x, tmpSize.y, tmpSize.z);
    const distance = diameter * (1 + GAP_RATIO) + GAP_MIN;
    // 頭から見て手の外側 (右手なら右、左手なら左) の横方向へずらす。
    tmpOffset.copy(headRight).setY(0);
    if (tmpOffset.lengthSq() < 1e-6) tmpOffset.set(1, 0, 0);
    tmpOffset.normalize().multiplyScalar(hand.handedness === 'left' ? -distance : distance);
    tmpPos.copy(item.object.position).add(tmpOffset);
    tmpQuat.copy(item.object.quaternion);
    copy.setPose(tmpPos, tmpQuat);
    ctx.audio.chime(tmpPos);
    hand.pulse(0.8, 60);
  };

  const dropState = (hand: HandState): void => {
    const state = states.get(hand);
    if (!state) return;
    unswell(state);
    states.delete(hand);
  };

  // 離した・消したときは、振りの記録と予告を捨てる。
  ctx.onItems('release', ({ hand }) => dropState(hand));
  ctx.onItems('removing', ({ item }) => {
    for (const [hand, state] of states) if (state.swelling?.item === item) dropState(hand);
  });

  return {
    id: 'C4',
    label: '振って増殖',
    category: 'duplicate',
    disable() {
      for (const state of states.values()) unswell(state);
      states.clear();
    },
    update(frame) {
      headRight.set(1, 0, 0).applyQuaternion(frame.headQuaternion);
      for (const hand of ctx.app.input.hands) {
        const item = hand.tracked ? heldShakable(hand) : null;
        if (!item) {
          dropState(hand);
          continue;
        }
        const state = stateOf(hand);
        const { x, y, z } = hand.velocity;
        const speed = Math.hypot(x, y, z);

        // 分裂のあとは、手を止めるか COOLDOWN_MAX 経つまで待つ。
        if (frame.time < state.cooldownUntil) {
          if (speed < CALM_SPEED) {
            state.calmSince ??= frame.time;
            if (frame.time - state.calmSince >= CALM_TIME) state.cooldownUntil = 0;
          } else {
            state.calmSince = null;
          }
          if (frame.time < state.cooldownUntil) continue;
        }

        const fired = state.detector.push(frame.time, x, y, z);

        // 予告: 振りが進むほど少し膨らむ。
        if (state.detector.progress > 0) {
          if (!state.swelling) {
            const base = item.object.scale.x;
            state.swelling = { item, base, set: base };
          }
          item.object.scale.setScalar(state.swelling.base * (1 + SWELL * state.detector.progress));
          state.swelling.set = item.object.scale.x;
        } else {
          unswell(state);
        }

        if (fired) {
          unswell(state);
          state.detector.reset();
          state.cooldownUntil = frame.time + COOLDOWN_MAX;
          state.calmSince = null;
          split(hand, item);
        }
      }
    },
  };
};

export default create;
