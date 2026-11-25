import * as THREE from 'three';
import type { Item } from '../../items';
import type { HandState } from '../../input';
import type { InteractionFactory } from '../types';

/** 物の底が床からこの高さ (m) 以内なら「床に押し付けている」とみなす。手の誤差と床検出の誤差を見込む。 */
const FLOOR_CONTACT_HEIGHT = 0.06;
/** 床に押し付けたままこの時間 (秒) 待つと沈み始める。通りすがりに床へ触れただけでは消えないようにする。 */
const DWELL_SECONDS = 1.5;
/** 待っている間、進み具合を振動で返す間隔 (秒) */
const PULSE_INTERVAL = 0.25;
/** 進み具合の振動の強さ。待つほど 0.1 から 0.35 へ強くなる。 */
const PULSE_MIN = 0.1;
const PULSE_MAX = 0.35;
/** 沈むアニメーションの長さ (秒) */
const SINK_SECONDS = 0.9;
/** 沈み終わったときの大きさ (沈む前の倍率)。床より下を隠せないので、縮めて目立たなくする。 */
const SINK_END_SCALE = 0.2;
/** 物の高さに足して沈める深さ (m)。底が床より十分下に行くようにする。 */
const SINK_EXTRA_DEPTH = 0.05;
/** 床に出す輪の半径 (m) と色 */
const RING_RADIUS = 0.18;
const RING_COLOR = 0x6fb8ff;
/** 床との重なりによるちらつきを避けるため、輪を床から浮かせる高さ (m) */
const RING_LIFT = 0.004;

/** 待ち時間の進み具合 (0 ～ 1)。条件を満たしている間は進み、外れたらやり直す。 */
export function stepDwell(progress: number, touching: boolean, dt: number): number {
  return touching ? Math.min(1, progress + dt / DWELL_SECONDS) : 0;
}

/** 沈むアニメーションの進み具合 t (0 ～ 1) から、沈んだ割合と大きさの倍率を返す。後半ほど速く沈む。 */
export function sinkPose(t: number): { depth: number; scale: number } {
  const e = t * t;
  return { depth: e, scale: 1 + (SINK_END_SCALE - 1) * e };
}

interface Dwelling {
  progress: number;
  pulseTimer: number;
  ring: THREE.Mesh;
}

interface Sinking {
  item: Item;
  elapsed: number;
  startPosition: THREE.Vector3;
  quaternion: THREE.Quaternion;
  startScale: number;
  depth: number;
}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _position = new THREE.Vector3();

const create: InteractionFactory = (ctx) => {
  const dwelling = new Map<Item, Dwelling>();
  const sinking: Sinking[] = [];
  const ringGeometry = new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2);

  const makeRing = (): THREE.Mesh => {
    const ring = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({
        color: RING_COLOR,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ctx.app.scene.add(ring);
    return ring;
  };

  const dropRing = (state: Dwelling): void => {
    ctx.app.scene.remove(state.ring);
    (state.ring.material as THREE.Material).dispose();
  };

  /** 持っている手と、物の底の高さ・床の高さ・中心の x, z を調べる */
  const measure = (item: Item) => {
    _box.setFromObject(item.object);
    const bottom = _box.min.y;
    const floor = ctx.room.floorHeightNear(bottom) ?? 0;
    return { bottom, floor, x: (_box.min.x + _box.max.x) / 2, z: (_box.min.z + _box.max.z) / 2 };
  };

  const startSink = (item: Item, hands: HandState[]): void => {
    const { floor } = measure(item);
    _box.setFromObject(item.object).getSize(_size);
    const startPosition = item.object.position.clone();
    const quaternion = item.object.quaternion.clone();
    const startScale = item.object.scale.x;
    // 持っている手から外すため、同じ物の複製を作って元を消す (Item に手から外す手段が無い)。
    const copy = ctx.items.duplicate(item);
    ctx.audio.chime(startPosition);
    for (const hand of hands) hand.pulse(0.6, 80);
    if (!copy) {
      // 複製できない物は、沈めずにそのまま消す。
      ctx.items.remove(item);
      return;
    }
    ctx.items.remove(item);
    sinking.push({
      item: copy,
      elapsed: 0,
      startPosition,
      quaternion,
      startScale,
      depth: _size.y + SINK_EXTRA_DEPTH + Math.max(0, startPosition.y - floor),
    });
  };

  return {
    id: 'D5',
    label: '床に沈める',
    category: 'delete',

    disable() {
      for (const state of dwelling.values()) dropRing(state);
      dwelling.clear();
      // 沈み始めた物は、消すと決めた後なので、途中で止めずに消してしまう。
      for (const s of sinking) ctx.items.remove(s.item);
      sinking.length = 0;
    },

    update({ dt }) {
      const held = new Set<Item>();
      for (const hand of [ctx.app.input.left, ctx.app.input.right]) {
        for (const item of ctx.items.heldBy(hand)) held.add(item);
      }

      // 手を離した・消えた物の途中状態を捨てる
      for (const [item, state] of dwelling) {
        if (held.has(item) && ctx.items.all.includes(item)) continue;
        dropRing(state);
        dwelling.delete(item);
      }

      for (const item of held) {
        const { bottom, floor, x, z } = measure(item);
        const touching = bottom - floor <= FLOOR_CONTACT_HEIGHT;
        let state = dwelling.get(item);
        if (!state) {
          if (!touching) continue;
          state = { progress: 0, pulseTimer: 0, ring: makeRing() };
          dwelling.set(item, state);
        }
        state.progress = stepDwell(state.progress, touching, dt);
        if (state.progress === 0) {
          dropRing(state);
          dwelling.delete(item);
          continue;
        }
        // 輪は床に広がり、待つほど大きくなる。
        state.ring.position.set(x, floor + RING_LIFT, z);
        state.ring.scale.setScalar(RING_RADIUS * Math.max(state.progress, 0.05));

        const hands = ctx.items.holdersOf(item);
        state.pulseTimer -= dt;
        if (state.pulseTimer <= 0 && state.progress < 1) {
          state.pulseTimer = PULSE_INTERVAL;
          const intensity = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * state.progress;
          for (const hand of hands) hand.pulse(intensity, 40);
        }
        if (state.progress >= 1) {
          dropRing(state);
          dwelling.delete(item);
          startSink(item, hands);
        }
      }

      for (let i = sinking.length - 1; i >= 0; i--) {
        const s = sinking[i];
        // 沈んでいる最中に別の手が持った・別の操作で消えた場合は、アニメーションをやめる。
        if (!ctx.items.all.includes(s.item)) {
          sinking.splice(i, 1);
          continue;
        }
        if (ctx.items.holdersOf(s.item).length > 0) {
          s.item.object.scale.setScalar(s.startScale);
          sinking.splice(i, 1);
          continue;
        }
        s.elapsed += dt;
        const t = Math.min(1, s.elapsed / SINK_SECONDS);
        const pose = sinkPose(t);
        _position.copy(s.startPosition).y -= s.depth * pose.depth;
        s.item.setPose(_position, s.quaternion);
        s.item.object.scale.setScalar(s.startScale * pose.scale);
        if (t >= 1) {
          ctx.audio.click(s.startPosition);
          ctx.items.remove(s.item);
          sinking.splice(i, 1);
        }
      }
    },
  };
};

export default create;