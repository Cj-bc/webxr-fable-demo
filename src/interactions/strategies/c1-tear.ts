// C1 引きちぎる / 株分け: 片手で持っている物を、もう片方の手でつまんですばやく引き離すと、コピーがその手に残る。
import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { GrabButton, Item } from '../../items';
import type { InteractionFactory } from '../types';

/**
 * 2 本目の手が物をつかもうとしてから、両手持ちを始めるまで待つ時間 (秒)。
 * 引きちぎる動きは、つまんでから 0.1 ～ 0.2 秒で 10 cm 以上離れる速さ。これより長く待つと、
 * 拡大縮小のために両手持ちをしたい人の「持った」までの遅れとして目立つ (0.3 秒を超えると、反応が悪いと感じやすい)。
 */
export const HOLD_WINDOW = 0.25;
/**
 * 引きちぎったと見なす、2 本の手の間隔の増え方 (m)。手の追跡の揺れ (数 mm ～ 1 cm) より十分大きく、
 * かつ 0.25 秒以内に届く距離。
 */
export const PULL_DISTANCE = 0.1;
/**
 * 引きちぎったと見なす、2 本の手が離れていく速さ (m/s)。両手持ちで物を拡大するときの
 * 手の広げ方は 0.1 ～ 0.4 m/s 程度なので、その倍近くを要求して取り違えを避ける。
 */
export const PULL_SPEED = 0.7;

export type PullJudgement = 'tear' | 'wait' | 'two-hand';

/**
 * 保留中の 2 本目の手の動きから、次にどうするかを決める。
 * @param elapsed つまんでからの経過秒
 * @param startSeparation つまんだ瞬間の、2 本の手の間隔 (m)
 * @param separation いまの 2 本の手の間隔 (m)
 * @param rate 2 本の手の間隔が増えていく速さ (m/s、近づくなら負)
 */
export function judgePull(elapsed: number, startSeparation: number, separation: number, rate: number): PullJudgement {
  if (separation - startSeparation >= PULL_DISTANCE && rate >= PULL_SPEED) return 'tear';
  return elapsed < HOLD_WINDOW ? 'wait' : 'two-hand';
}

interface Pending {
  hand: HandState;
  other: HandState;
  button: GrabButton;
  /** 持とうとした物 */
  item: Item;
  /** 複製する物 (もう一方の手が持っている物すべて。線は重なった線がまとめて持たれる) */
  sources: Item[];
  startTime: number | null;
  startSeparation: number;
  startPosition: THREE.Vector3;
}

const _axis = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _position = new THREE.Vector3();

const create: InteractionFactory = (ctx) => {
  let pending: Pending | null = null;

  const stillPressed = (p: Pending): boolean =>
    p.hand.tracked && (p.button === 'select' ? p.hand.selecting : p.hand.squeezing);

  const tear = (p: Pending): void => {
    // 手を動かした分だけ、複製を元の位置からずらして、つまんだ位置のまま手に付いてくるようにする。
    const offset = _position.copy(p.hand.grabPosition).sub(p.startPosition);
    const copies: Item[] = [];
    for (const source of p.sources) {
      const copy = ctx.items.duplicate(source);
      if (!copy) continue;
      copy.setPose(copy.object.position.clone().add(offset), copy.object.quaternion.clone());
      copies.push(copy);
    }
    // 重なった線は、1 本を持たせると近くの線がまとめて付いてくる。
    if (copies.length === 0 || !copies[0].grab(p.hand, p.button)) {
      for (const copy of copies) ctx.items.remove(copy);
      return;
    }
    ctx.audio.chime(p.hand.grabPosition);
    p.hand.pulse(0.8, 40);
    p.other.pulse(0.4, 30);
  };

  const cancel = (): void => {
    pending = null;
  };

  // もう一方の手がすでに持っている物を持とうとした入力を、いったん預かる。
  ctx.addGrabInterceptor((hand, item, button) => {
    if (pending) return pending.hand === hand;
    const other = ctx.app.input.other(hand);
    if (!ctx.items.heldBy(other).includes(item) || ctx.items.heldBy(hand).length > 0) return false;
    pending = {
      hand,
      other,
      button,
      item,
      sources: ctx.items.heldBy(other),
      startTime: null,
      startSeparation: hand.grabPosition.distanceTo(other.grabPosition),
      startPosition: hand.grabPosition.clone(),
    };
    return true;
  });

  // 保留中に物が消えたり、もう一方の手が離したりしたら、何もしない。
  ctx.onItems('release', (event) => {
    if (pending && event.hand === pending.other) cancel();
  });
  ctx.onItems('removing', (event) => {
    if (pending?.sources.includes(event.item)) cancel();
  });

  return {
    id: 'C1',
    label: '引きちぎる',
    category: 'duplicate',
    disable: cancel,
    update(frame: FrameContext) {
      const p = pending;
      if (!p) return;
      if (!stillPressed(p)) {
        // 保留中に離した。何もしない。
        cancel();
        return;
      }
      p.startTime ??= frame.time;
      const separation = p.hand.grabPosition.distanceTo(p.other.grabPosition);
      _axis.copy(p.hand.grabPosition).sub(p.other.grabPosition);
      const length = _axis.length();
      const rate = length > 1e-6 ? _relative.copy(p.hand.velocity).sub(p.other.velocity).dot(_axis.divideScalar(length)) : 0;
      const result = judgePull(frame.time - p.startTime, p.startSeparation, separation, rate);
      if (result === 'wait') return;
      cancel();
      if (result === 'tear') tear(p);
      else p.item.grab(p.hand, p.button);
    },
  };
};

export default create;
