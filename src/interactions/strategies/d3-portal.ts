// D3 ポータルに捨てる: 持った物をポータルの穴へ入れる / 投げ込むと、穴の中心へ縮みながら吸い込まれて消える。
import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

/** 穴の形 (Portal.openings と同じ) */
export interface Opening {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
}

/**
 * 写真・線を「穴の手前で離した」とみなす、面からの距離 (m)。
 * 手は物を少し離れた所で持つので、穴の手前 20cm までは受け付ける。奥は差し込んだ分として 30cm まで。
 */
const DROP_FRONT = 0.2;
const DROP_BACK = 0.3;
/** 穴の半径にこの倍率を掛けた範囲を「穴の上」とみなす。縁をかすめても入れてよいくらい甘くする。 */
const RADIUS_MARGIN = 1.15;
/** 吸い込まれる時間 (秒) と、最後に縮む大きさの倍率 */
const SUCK_DURATION = 0.45;
const SUCK_END_SCALE = 0.05;

/** 点の、穴の面からの符号付き距離 (手前が正) と、穴の中心軸からの距離 */
export function locate(point: THREE.Vector3, opening: Opening): { along: number; lateral: number } {
  const offset = point.clone().sub(opening.position);
  const along = offset.dot(opening.normal);
  const lateral = offset.addScaledVector(opening.normal, -along).length();
  return { along, lateral };
}

/** 点が、穴の手前 (または差し込んだ先) にあるか。写真・線を離したときの判定 */
export function isAtOpening(point: THREE.Vector3, opening: Opening): boolean {
  const { along, lateral } = locate(point, opening);
  return lateral <= opening.radius * RADIUS_MARGIN && along <= DROP_FRONT && along >= -DROP_BACK;
}

/** 前のフレームから今のフレームで、穴の面を手前から奥へ、穴の範囲内で通過したか。ボール・ブロックの判定 */
export function passedThrough(previous: THREE.Vector3, current: THREE.Vector3, opening: Opening): boolean {
  const before = locate(previous, opening);
  const after = locate(current, opening);
  if (before.along <= 0 || after.along > 0) return false;
  // 面を横切った点で、穴の範囲内か見る。
  const t = before.along / (before.along - after.along);
  const crossing = previous.clone().lerp(current, t);
  return locate(crossing, opening).lateral <= opening.radius * RADIUS_MARGIN;
}

interface Suction {
  item: Item;
  from: THREE.Vector3;
  startScale: number;
  to: THREE.Vector3;
  quaternion: THREE.Quaternion;
  elapsed: number;
}

const create: InteractionFactory = (ctx) => {
  let suctions: Suction[] = [];
  /** ボール・ブロックの、前のフレームの位置 (面の通過を見る) */
  const previous = new Map<Item, THREE.Vector3>();

  const sucking = (item: Item) => suctions.some((s) => s.item === item);

  const startSuction = (item: Item, opening: Opening) => {
    if (sucking(item)) return;
    suctions.push({
      item,
      from: item.object.position.clone(),
      startScale: item.object.scale.x,
      to: opening.position.clone(),
      quaternion: item.object.quaternion.clone(),
      elapsed: 0,
    });
    ctx.audio.chime(opening.position);
    for (const hand of ctx.items.holdersOf(item)) hand.pulse(0.8, 80);
  };

  // 写真・線: 離したときに穴の手前か穴の中にあれば吸い込む。
  ctx.onItems('release', ({ hand, items }) => {
    for (const item of items) {
      if (item.kind !== 'photo' && item.kind !== 'stroke') continue;
      const opening = ctx.portal.openings.find((o) => isAtOpening(item.object.position, o));
      if (!opening) continue;
      startSuction(item, opening);
      hand.pulse(0.8, 80);
    }
  });

  // 吸い込み中の物は、持ち直せないようにする。
  ctx.addGrabInterceptor((_hand, item) => sucking(item));

  // 消えた物の状態を片付ける。
  ctx.onItems('removing', ({ item }) => {
    previous.delete(item);
    suctions = suctions.filter((s) => s.item !== item);
  });

  return {
    id: 'D3',
    label: 'ポータル',
    category: 'delete',
    disable() {
      // 途中で止めた物は、大きさを戻してその場に残す。
      for (const s of suctions) s.item.object.scale.setScalar(s.startScale);
      suctions = [];
      previous.clear();
    },
    update(frame: FrameContext) {
      const openings = ctx.portal.openings;
      if (openings.length > 0) {
        for (const item of ctx.items.all) {
          if (item.kind !== 'ball' && item.kind !== 'block') continue;
          const position = item.object.position;
          const last = previous.get(item);
          // 持っている間・吸い込み中は判定しない (持ったまま穴に通しても、離すまでは消さない)。
          if (last && ctx.items.holdersOf(item).length === 0 && !sucking(item)) {
            const opening = openings.find((o) => passedThrough(last, position, o));
            if (opening) startSuction(item, opening);
          }
          if (last) last.copy(position);
          else previous.set(item, position.clone());
        }
      } else previous.clear();

      for (const s of [...suctions]) {
        s.elapsed += frame.dt;
        const progress = Math.min(s.elapsed / SUCK_DURATION, 1);
        // 後半ほど速く吸い込まれる。
        const eased = progress * progress;
        s.item.setPose(s.from.clone().lerp(s.to, eased), s.quaternion);
        s.item.object.scale.setScalar(s.startScale * (1 - eased * (1 - SUCK_END_SCALE)));
        if (progress >= 1) {
          suctions = suctions.filter((x) => x !== s);
          ctx.items.remove(s.item);
        }
      }
    },
  };
};

export default create;
