import * as THREE from 'three';
import type { HandState } from '../../input';
import type { InteractionFactory } from '../types';

/**
 * D4 肩越しに後ろへ放る。持っている物を肩越しに頭の後ろへ持っていって離すと、見えないゴミ箱に入って消える。
 */

/** 頭の中心から見て、これ以上後ろ (頭の水平な前方向と逆) にあること (m)。頭の半径が約 0.1 m なので、耳の後ろまで回したら後ろとみなす。 */
export const BEHIND_MIN = 0.12;
/** 頭からの距離の上限 (m)。肩越しに後ろへ回した手が届く範囲 (腕の長さ約 0.6～0.7 m) より少し広めに取る。遠くへ投げた物は対象にしない。 */
export const REACH_MAX = 0.75;
/** 高さの下限 (頭より何 m 低いまで許すか)。目から肩までが約 0.25～0.3 m なので、肩の高さ以上を「肩越し」とする。腰の後ろでの誤爆を避ける。 */
export const SHOULDER_DROP = 0.3;
/** 前方向の水平成分がこれより小さい (真上・真下を向いている) ときは、後ろの向きが決められないので対象にしない。 */
const MIN_FORWARD_HORIZONTAL = 0.1;

/**
 * 「普通に後ろへ投げたいボール」を消さないための条件。
 * 投げるときの手は、後ろの領域を一瞬で通り抜ける。消したいときは、その領域で手を止めて、
 * 振動で知らせを受けてから離す。そこで、領域に入ってから離すまでに DWELL_SEC 以上かかり、
 * 離す瞬間の手の速さが RELEASE_SPEED_MAX 以下であることを求める。
 * 後ろへ向けた緩い投げ (下手) は、手が領域を通る時間が短く速いので、この 2 つで消えない。
 */
/** 領域に入ってから離すまでの最短時間 (秒)。振動の知らせ 1 回分より長く、待ち続けても苦にならない長さ。 */
export const DWELL_SEC = 0.35;
/** 離す瞬間の手の速さの上限 (m/s)。人が物をそっと置くときはおよそ 0.5 m/s 以下、投げは 2 m/s 以上になる。 */
export const RELEASE_SPEED_MAX = 1.2;

/** 領域の中にいる間、知らせの振動を繰り返す間隔 (秒) と、その強さ・長さ */
const HINT_INTERVAL = 0.25;
const HINT_INTENSITY = 0.12;
const HINT_MS = 40;
/** 領域に入った瞬間と、消える瞬間の振動 */
const ENTER_INTENSITY = 0.3;
const ENTER_MS = 60;
const DELETE_INTENSITY = 1;
const DELETE_MS = 120;

const _forward = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * 位置が、頭から見て「肩越しの後ろ」の領域にあるか。
 * 頭の水平な前方向に対する後ろ向きの距離・頭からの距離・高さで判定する。
 */
export function isOverShoulder(
  headPosition: THREE.Vector3,
  headQuaternion: THREE.Quaternion,
  position: THREE.Vector3,
): boolean {
  _forward.set(0, 0, -1).applyQuaternion(headQuaternion);
  _forward.y = 0;
  const length = _forward.length();
  if (length < MIN_FORWARD_HORIZONTAL) return false;
  _forward.divideScalar(length);
  _offset.copy(position).sub(headPosition);
  const behind = -(_offset.x * _forward.x + _offset.z * _forward.z);
  return behind >= BEHIND_MIN && _offset.length() <= REACH_MAX && _offset.y >= -SHOULDER_DROP;
}

/** 領域に入ってから離すまでの時間と手の速さが、「わざと離した」といえるか */
export function isDeliberateRelease(dwellSec: number, speed: number): boolean {
  return dwellSec >= DWELL_SEC && speed <= RELEASE_SPEED_MAX;
}

const create: InteractionFactory = (ctx) => {
  const head = new THREE.Vector3();
  const headQuaternion = new THREE.Quaternion();
  let hasHead = false;
  /** 手ごとの、領域に入った時刻と、最後に知らせの振動を出した時刻 */
  const zone = new Map<HandState, { since: number; lastHint: number }>();
  let now = 0;

  ctx.onItems('release', ({ hand, items }) => {
    const state = zone.get(hand);
    zone.delete(hand);
    if (!state || !hasHead) return;
    // 持っていた手の速さ。素手とコントローラーのどちらも HandState.velocity に入る。
    if (!isDeliberateRelease(now - state.since, hand.velocity.length())) return;
    // 両手で持っていた物は、もう一方の手に残るので消さない。
    const targets = items.filter(
      (item) => ctx.items.holdersOf(item).length === 0 && isOverShoulder(head, headQuaternion, item.object.position),
    );
    if (targets.length === 0) return;

    // 視界の外なので、音で知らせる。音の位置は、消える物のある (頭の後ろの) 場所。
    const position = targets[0].object.position.clone();
    ctx.audio.click(position);
    ctx.audio.chime(position);
    hand.pulse(DELETE_INTENSITY, DELETE_MS);
    for (const item of targets) ctx.items.remove(item);
  });

  return {
    id: 'D4',
    label: '肩越し',
    category: 'delete',
    disable() {
      zone.clear();
      hasHead = false;
    },
    update(frame) {
      now = frame.time;
      head.copy(frame.headPosition);
      headQuaternion.copy(frame.headQuaternion);
      hasHead = true;
      for (const hand of ctx.app.input.hands) {
        const held = ctx.items.heldBy(hand);
        // 1 本の手だけで持っている物が領域にあるときだけ、知らせる。
        const inZone =
          held.length > 0 &&
          held.every((item) => ctx.items.holdersOf(item).length === 1) &&
          isOverShoulder(head, headQuaternion, held[0].object.position);
        const state = zone.get(hand);
        if (!inZone) {
          zone.delete(hand);
          continue;
        }
        if (!state) {
          zone.set(hand, { since: now, lastHint: now });
          hand.pulse(ENTER_INTENSITY, ENTER_MS);
        } else if (now - state.since >= DWELL_SEC && now - state.lastHint >= HINT_INTERVAL) {
          // 「ここで離すと消える」状態になってから、弱い振動を繰り返す。
          state.lastHint = now;
          hand.pulse(HINT_INTENSITY, HINT_MS);
        }
      }
    },
  };
};

export default create;
