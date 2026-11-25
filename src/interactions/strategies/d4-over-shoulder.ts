import * as THREE from 'three';
import type { HandState } from '../../input';
import type { Item } from '../../items';
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
  behindMin = BEHIND_MIN,
): boolean {
  _forward.set(0, 0, -1).applyQuaternion(headQuaternion);
  _forward.y = 0;
  const length = _forward.length();
  if (length < MIN_FORWARD_HORIZONTAL) return false;
  _forward.divideScalar(length);
  _offset.copy(position).sub(headPosition);
  const behind = -(_offset.x * _forward.x + _offset.z * _forward.z);
  return behind >= behindMin && _offset.length() <= REACH_MAX && _offset.y >= -SHOULDER_DROP;
}

/**
 * 素手の対策。素手は頭の後ろに回すとヘッドセットのカメラに映らず、認識が切れる (HandState.tracked が false)。
 * 認識が切れている間は物が動かず、つまみの終わりも手が前に戻るまで来ないので、離した位置が領域に届かない。
 * そこで、領域の手前 (耳の横から肩の上あたり) にある物を持ったまま認識が切れ、そのまま一定時間戻らなければ、
 * 後ろへ回して離したとみなして消す。後ろ向きの距離の下限を緩めるのは、認識が切れる直前の位置が手前になるため。
 */
export const NEAR_BEHIND_MIN = -0.1;
/** 認識が切れてから消すまでの時間 (秒)。ちらつきや一瞬の隠れを除く。 */
export const LOST_SEC = 0.35;
/** 認識が切れている間に頭の向き (水平) がこれ以上回ったら、振り向いて見えなくなっただけとみなして消さない (ラジアン、約 35 度)。 */
export const LOST_YAW_MAX = 0.6;

/** 水平な向きの角度の差 (-PI..PI) の絶対値 */
export function yawDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/** 頭の水平な前方向の角度 (ラジアン)。真上・真下を向いて決まらないときは null */
export function headYaw(headQuaternion: THREE.Quaternion): number | null {
  _forward.set(0, 0, -1).applyQuaternion(headQuaternion);
  if (Math.hypot(_forward.x, _forward.z) < MIN_FORWARD_HORIZONTAL) return null;
  return Math.atan2(_forward.x, _forward.z);
}

/** 認識が切れる直前に物が領域の手前にあり、切れたまま十分たち、その間に頭が大きく回っていなければ、消す。 */
export function shouldDeleteOnTrackingLoss(wasNear: boolean, lostSec: number, headYawChange: number): boolean {
  return wasNear && lostSec >= LOST_SEC && headYawChange <= LOST_YAW_MAX;
}

/**
 * 勢いよく後ろへ振って離す削除。待たなくても、後ろへ速く振って離せば消える (後ろへ投げた物も消えてよい)。
 * 手の速さは、頭の水平な後ろ向きの成分で見る。体の前へ投げる動きは後ろ向きの成分が負なので、決して消えない。
 */
/** 後ろ向きの手の速さの下限 (m/s)。ゆっくり手を回すだけ (約 0.5 m/s) では消えず、軽く振れば超える値。 */
export const THROW_BACK_SPEED = 1.0;
/** 素手で、認識が切れる前の「速い後ろ向き」をどれだけ前まで有効とするか (秒)。切れる 1～2 フレーム前が最大速度になるため。 */
export const FAST_RECENT_SEC = 0.2;
/** 速い振りの後で認識が切れたとき、消すまでの待ち (秒)。1～2 フレームのちらつきを除く。 */
export const FAST_LOST_SEC = 0.1;
/** 速い振りで認識が切れる直前の、後ろ向きの距離の下限 (m)。振っている最中は耳の手前で見えなくなることがあるので、かなり緩める。 */
export const FAST_NEAR_BEHIND_MIN = -0.3;
/** 合図の音を鳴らす間隔の下限 (秒)。領域の縁での出入りで連続して鳴らさない。 */
const CUE_COOLDOWN = 0.8;

/** 手の速度の、頭の水平な後ろ向きの成分 (m/s)。向きが決まらなければ 0 */
export function backwardSpeed(headQuaternion: THREE.Quaternion, velocity: THREE.Vector3): number {
  _forward.set(0, 0, -1).applyQuaternion(headQuaternion);
  _forward.y = 0;
  const length = _forward.length();
  if (length < MIN_FORWARD_HORIZONTAL) return 0;
  return -(velocity.x * _forward.x + velocity.z * _forward.z) / length;
}

/** 速く後ろへ動いている手が、頭の耳の横から後ろ・肩の高さ以上・届く範囲で離したか */
export function isBackwardThrow(
  headPosition: THREE.Vector3,
  headQuaternion: THREE.Quaternion,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  behindMin = NEAR_BEHIND_MIN,
): boolean {
  return (
    backwardSpeed(headQuaternion, velocity) >= THROW_BACK_SPEED &&
    isOverShoulder(headPosition, headQuaternion, position, behindMin)
  );
}

/** 速く後ろへ振った直後に認識が切れ、少し戻らず、頭が大きく回っていなければ、消す。 */
export function shouldDeleteOnFastLoss(wasFastNear: boolean, lostSec: number, headYawChange: number): boolean {
  return wasFastNear && lostSec >= FAST_LOST_SEC && headYawChange <= LOST_YAW_MAX;
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
  /** 素手: 認識が切れる直前に、持っている物が領域の手前にあったか */
  const nearBeforeLoss = new Map<HandState, boolean>();
  /** 素手: 認識が切れた時刻と、そのときの頭の向き */
  const lost = new Map<HandState, { since: number; yaw: number | null }>();
  /** 素手: 速く後ろへ振りながら領域の手前にいた最後の時刻 */
  const fastNearAt = new Map<HandState, number>();
  /** 素手: 最後に追跡できたフレームの時刻と、そのときの頭の向き (認識が切れた後に頭が回ったかの基準) */
  const lastTrackedAt = new Map<HandState, number>();
  const yawWhileTracked = new Map<HandState, number | null>();
  const lastCue = new Map<HandState, number>();

  const removeWithFeedback = (hand: HandState, items: readonly Item[]): void => {
    // 視界の外なので、音で知らせる。音の位置は、消える物のある (頭の後ろの) 場所。
    const position = items[0].object.position.clone();
    ctx.audio.trash(position);
    hand.pulse(DELETE_INTENSITY, DELETE_MS);
    for (const item of items) ctx.items.remove(item);
  };

  ctx.onItems('release', ({ hand, items }) => {
    const state = zone.get(hand);
    zone.delete(hand);
    if (!hasHead) return;
    // 持っていた手の速さ。素手とコントローラーのどちらも HandState.velocity に入る。
    // 領域で待ってそっと離す、または速く後ろへ振って離す、のどちらかで消す。
    const deliberate = state !== undefined && isDeliberateRelease(now - state.since, hand.velocity.length());
    // 両手で持っていた物は、もう一方の手に残るので消さない。
    const targets = items.filter(
      (item) =>
        ctx.items.holdersOf(item).length === 0 &&
        (deliberate
          ? isOverShoulder(head, headQuaternion, item.object.position)
          : isBackwardThrow(head, headQuaternion, item.object.position, hand.velocity)),
    );
    if (targets.length === 0) return;

    removeWithFeedback(hand, targets);
  });

  /** 素手の認識切れによる削除。消したら true */
  const handleHandLoss = (hand: HandState, held: Item[]): boolean => {
    const single = held.length > 0 && held.every((item) => ctx.items.holdersOf(item).length === 1);
    if (hand.tracked) {
      lost.delete(hand);
      lastTrackedAt.set(hand, now);
      yawWhileTracked.set(hand, headYaw(headQuaternion));
      nearBeforeLoss.set(hand, single && isOverShoulder(head, headQuaternion, held[0].object.position, NEAR_BEHIND_MIN));
      if (single && isBackwardThrow(head, headQuaternion, held[0].object.position, hand.velocity, FAST_NEAR_BEHIND_MIN)) {
        fastNearAt.set(hand, now);
      }
      return false;
    }
    const wasNear = nearBeforeLoss.get(hand) === true;
    const fastAt = fastNearAt.get(hand);
    const wasFast = fastAt !== undefined && (lastTrackedAt.get(hand) ?? -Infinity) - fastAt <= FAST_RECENT_SEC;
    if (!single || (!wasNear && !wasFast)) {
      lost.delete(hand);
      return false;
    }
    let state = lost.get(hand);
    if (!state) {
      // 頭の向きの基準は、認識が切れる前の最後のフレームのもの (切れてから回った分も数えるため)。
      state = { since: now, yaw: yawWhileTracked.get(hand) ?? null };
      lost.set(hand, state);
    }
    const yaw = headYaw(headQuaternion);
    const change = state.yaw === null || yaw === null ? 0 : yawDelta(state.yaw, yaw);
    const lostSec = now - state.since;
    if (!shouldDeleteOnTrackingLoss(wasNear, lostSec, change) && !shouldDeleteOnFastLoss(wasFast, lostSec, change)) {
      return false;
    }
    lost.delete(hand);
    nearBeforeLoss.delete(hand);
    fastNearAt.delete(hand);
    zone.delete(hand);
    removeWithFeedback(hand, held);
    return true;
  };

  return {
    id: 'D4',
    label: '肩越し',
    category: 'delete',
    disable() {
      zone.clear();
      nearBeforeLoss.clear();
      fastNearAt.clear();
      lastTrackedAt.clear();
      yawWhileTracked.clear();
      lastCue.clear();
      lost.clear();
      hasHead = false;
    },
    update(frame) {
      now = frame.time;
      head.copy(frame.headPosition);
      headQuaternion.copy(frame.headQuaternion);
      hasHead = true;
      for (const hand of ctx.app.input.hands) {
        const held = ctx.items.heldBy(hand);
        if (hand.isHand && handleHandLoss(hand, held)) continue;
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
          // 素手は振動しないので、領域に着いたことを音で知らせる (入るたびに 1 回。縁での出入りは間隔を空ける)。
          if (now - (lastCue.get(hand) ?? -Infinity) >= CUE_COOLDOWN) {
            lastCue.set(hand, now);
            ctx.audio.zoneCue(held[0].object.position.clone());
          }
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
