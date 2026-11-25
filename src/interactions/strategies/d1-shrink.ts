import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { Item, ItemKind } from '../../items';
import type { InteractionFactory } from '../types';

// D1 両手で縮めて消す。拡大縮小そのものは Holding / Toys が行い、ここでは
// 「最小の大きさを超えて、さらに潰そうとしている量」だけを見て、十分に潰したら消す。

/** 物の種類ごとの最小の大きさ。holding.ts (写真・線) と toys.ts (ボール・ブロック) の MIN_SCALE に合わせる。 */
const MIN_SCALE: Record<ItemKind, number> = { photo: 0.25, stroke: 0.25, ball: 0.4, block: 0.4 };
/** 最小の大きさに達したとみなすのをやめる余裕 (最小の何倍まで戻ったら、達していない状態に戻すか)。振動が連続しないための余裕 */
const REACH_RELEASE = 1.05;
/** この量 (最小の大きさに対する、さらに潰した割合) を超えて潰すと、すぐ消える */
const CRUSH_DELETE = 0.35;
/** この量を超えて潰した状態を HOLD_SECONDS 保っても消える。手の距離が細かく揺れても消せるようにするため */
const CRUSH_HOLD = 0.1;
const HOLD_SECONDS = 0.8;
/** 潰している間の予告の色 */
const WARN_COLOR = 0xff4040;
/** 予告の振動の間隔 (秒) */
const WARN_PULSE_INTERVAL = 0.12;

/**
 * 両手で持ち始めたときの手の距離と大きさから、いまの手の距離で、
 * 最小の大きさを超えてさらに潰そうとしている量を返す (0 なら潰していない、1 なら大きさ 0 相当)。
 * 拡大縮小は距離の比に比例するので、最小で止められる前の「本来の大きさ」を求めて比べる。
 */
export function crushAmount(startDistance: number, distance: number, startScale: number, minScale: number): number {
  if (startDistance <= 0 || minScale <= 0) return 0;
  const virtualScale = (startScale * distance) / startDistance;
  return Math.max(0, 1 - virtualScale / minScale);
}

/** 最小の大きさに達しているか (本来の大きさが最小以下)。released は、いったん達したあとで戻ったか見るための余裕つき */
export function reachedMin(startDistance: number, distance: number, startScale: number, minScale: number, released = false): boolean {
  const virtualScale = (startScale * distance) / startDistance;
  return virtualScale <= minScale * (released ? REACH_RELEASE : 1);
}

interface Crush {
  a: HandState;
  b: HandState;
  startDistance: number;
  startScale: number;
  reached: boolean;
  /** CRUSH_HOLD を超えて潰している時間 */
  held: number;
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

  const showWarning = (item: Item, crush: Crush, progress: number, time: number): void => {
    if (!crush.warning) {
      const material = new THREE.MeshBasicMaterial({ color: WARN_COLOR, transparent: true, depthWrite: false });
      crush.warning = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), material);
      ctx.app.scene.add(crush.warning);
    }
    _box.setFromObject(item.object).getBoundingSphere(_sphere);
    const shake = 1 + 0.08 * Math.sin(time * 60) * progress;
    crush.warning.position.copy(_sphere.center);
    crush.warning.scale.setScalar(Math.max(_sphere.radius, 0.01) * 1.1 * shake);
    (crush.warning.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.5 * progress;
  };

  const step = (item: Item, frame: FrameContext): void => {
    const holders = ctx.items.holdersOf(item);
    if (holders.length !== 2) return forget(item);
    const [a, b] = holders;
    let crush = crushes.get(item);
    if (crush && (crush.a !== a || crush.b !== b)) {
      forget(item);
      crush = undefined;
    }
    const distance = Math.max(a.grabPosition.distanceTo(b.grabPosition), 0.02);
    // 両手で持った (grab 通知) 時点の距離と大きさを覚える。Holding / Toys も同じ時点を基準にしている。
    if (!crush) {
      crush = {
        a,
        b,
        startDistance: distance,
        startScale: item.object.scale.x,
        reached: false,
        held: 0,
        pulseTimer: 0,
        warning: null,
      };
      crushes.set(item, crush);
    }
    const min = MIN_SCALE[item.kind];
    const amount = crushAmount(crush.startDistance, distance, crush.startScale, min);

    if (!crush.reached && reachedMin(crush.startDistance, distance, crush.startScale, min)) {
      crush.reached = true;
      a.pulse(0.6, 60);
      b.pulse(0.6, 60);
    } else if (crush.reached && !reachedMin(crush.startDistance, distance, crush.startScale, min, true)) {
      crush.reached = false;
    }

    crush.held = amount >= CRUSH_HOLD ? crush.held + frame.dt : 0;
    const progress = Math.min(1, Math.max(amount / CRUSH_DELETE, crush.held / HOLD_SECONDS));

    if (progress >= 1) {
      const position = item.object.position.clone();
      ctx.items.remove(item);
      ctx.audio.chime(position);
      a.pulse(1, 120);
      b.pulse(1, 120);
      return;
    }
    if (amount > 0) {
      showWarning(item, crush, progress, frame.time);
      crush.pulseTimer -= frame.dt;
      if (crush.pulseTimer <= 0) {
        crush.pulseTimer = WARN_PULSE_INTERVAL;
        a.pulse(0.2 + 0.4 * progress, 40);
        b.pulse(0.2 + 0.4 * progress, 40);
      }
    } else {
      // 手を開いて戻したら、予告をやめる。
      clearWarning(crush);
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
