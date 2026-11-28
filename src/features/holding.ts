import * as THREE from 'three';
import type { App, Feature } from '../app';
import type { HandState } from '../input';

/** 手で持って動かせる物。object はシーンの直下に置かれていること (位置・向き・大きさをワールド座標で書き換える)。 */
export interface Holdable {
  object: THREE.Object3D;
  /** 手の位置 (ワールド座標) から、物の表面までの距離 (m) */
  distanceTo(point: THREE.Vector3): number;
  /** いま持てるか。省くと、いつでも持てる。 */
  canHold?(): boolean;
  /** 一緒に動かす物。省くと object だけを動かす。 */
  group?(): THREE.Object3D[];
}

type HoldButton = 'select' | 'squeeze';

interface Part {
  object: THREE.Object3D;
  /** 片手: 手から見た位置と向き / 両手: 両手の中点から見た位置と、ワールド座標での向き */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}

interface Hold {
  /** 持っている手。1 つか 2 つ */
  hands: { hand: HandState; button: HoldButton }[];
  parts: Part[];
  /** 両手で持ち始めた瞬間の、両手を結ぶ線の向きと長さ */
  twoHand: { direction: THREE.Vector3; distance: number } | null;
}

/** 物の表面からこの距離までなら、持てる (m) */
const HOLD_MARGIN = 0.04;
/** 両手で変えられる拡大率の範囲 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 6;

const _direction = new THREE.Vector3();
const _middle = new THREE.Vector3();
const _delta = new THREE.Quaternion();

/**
 * 写真や線のような、物理を持たない物を手で持って動かす。離すと、その場に浮いたまま残る。
 * - 物の近くでつまむ・握る / トリガー / グリップ: 持つ
 * - 持っている物をもう一方の手でも持つ: 手の間隔で拡大縮小、手の向きで回転
 *
 * 物理で動くおもちゃは、投げたり当たり判定を作り直したりと扱いが違うので、Toys が自前で持つ。
 */
export class Holding implements Feature {
  readonly name = 'holding';
  private readonly holdables: Holdable[] = [];
  /** 両手で同じ物を持っているときは、両方の手が同じ Hold を指す。 */
  private readonly held = new Map<HandState, Hold>();

  constructor(private readonly app: App) {
    const { input } = app;
    app.grabs.register((hand, button) => this.tryHold(hand, button));
    input.on('selectend', (hand) => this.release(hand, 'select'));
    input.on('squeezeend', (hand) => this.release(hand, 'squeeze'));
  }

  add(holdable: Holdable): void {
    this.holdables.push(holdable);
  }

  /** 物を消すときに呼ぶ。持っている最中なら、手から外す。 */
  remove(object: THREE.Object3D): void {
    const index = this.holdables.findIndex((holdable) => holdable.object === object);
    if (index >= 0) this.holdables.splice(index, 1);
    for (const [hand, hold] of this.held) {
      hold.parts = hold.parts.filter((part) => part.object !== object);
      if (hold.parts.length === 0) this.held.delete(hand);
    }
  }

  end(): void {
    this.held.clear();
    this.app.items.clearHeld();
  }

  update(): void {
    for (const hold of new Set(this.held.values())) {
      const [first, second] = hold.hands;
      if (second && hold.twoHand) {
        if (!first.hand.tracked || !second.hand.tracked) continue;
        const start = hold.twoHand;
        const direction = _direction.copy(second.hand.grabPosition).sub(first.hand.grabPosition);
        const distance = Math.max(direction.length(), 0.02);
        direction.normalize();
        // 一緒に持っている物の大きさが違っても形が崩れないよう、倍率は全体で 1 つにする。
        const base = hold.parts[0].scale;
        const ratio = THREE.MathUtils.clamp(distance / start.distance, MIN_SCALE / base, MAX_SCALE / base);
        // 両手を結ぶ線の向きの変化を、そのまま物の回転にする。
        _delta.setFromUnitVectors(start.direction, direction);
        _middle.addVectors(first.hand.grabPosition, second.hand.grabPosition).multiplyScalar(0.5);
        for (const part of hold.parts) {
          part.object.quaternion.copy(_delta).multiply(part.quaternion);
          part.object.position.copy(part.position).applyQuaternion(_delta).multiplyScalar(ratio).add(_middle);
          part.object.scale.setScalar(part.scale * ratio);
        }
      } else {
        const hand = first.hand;
        if (!hand.tracked) continue;
        for (const part of hold.parts) {
          part.object.quaternion.copy(hand.grabQuaternion).multiply(part.quaternion);
          part.object.position.copy(part.position).applyQuaternion(hand.grabQuaternion).add(hand.grabPosition);
        }
      }
    }
  }

  private tryHold(hand: HandState, button: HoldButton): boolean {
    if (!hand.tracked || this.held.has(hand)) return false;
    // 線の近くでも描き足せるよう、つまみを道具に譲る。握る / グリップでは持てる。
    if (button === 'select' && this.app.tools.active?.overridesHold) return false;
    let nearest: Holdable | null = null;
    let nearestDistance = HOLD_MARGIN;
    for (const holdable of this.holdables) {
      if (holdable.canHold && !holdable.canHold()) continue;
      const distance = holdable.distanceTo(hand.grabPosition);
      if (distance < nearestDistance) {
        nearest = holdable;
        nearestDistance = distance;
      }
    }
    if (!nearest) return false;
    const item = this.app.items.of(nearest.object);
    if (item && this.app.items.interceptGrab(hand, item, button)) return true;
    this.holdWith(hand, nearest, button);
    return true;
  }

  /** 指定した物を、この手で持たせる。近くにあるかどうかは問わない (複製した物を手に渡すときなど)。 */
  hold(hand: HandState, object: THREE.Object3D, button: HoldButton): boolean {
    if (!hand.tracked || this.held.has(hand)) return false;
    const holdable = this.holdables.find((candidate) => candidate.object === object);
    if (!holdable || (holdable.canHold && !holdable.canHold())) return false;
    this.holdWith(hand, holdable, button);
    return true;
  }

  private holdWith(hand: HandState, nearest: Holdable, button: HoldButton): void {
    const other = this.held.get(this.app.input.other(hand));
    let hold: Hold;
    if (other?.parts.some((part) => part.object === nearest.object)) {
      // もう一方の手が持っている物なら、両手持ちにする。
      hold = other;
      hold.hands.push({ hand, button });
    } else {
      // もう一方の手が持っている物は、そちらに任せる。
      const objects = (nearest.group?.() ?? [nearest.object]).filter(
        (object) => !other?.parts.some((part) => part.object === object),
      );
      hold = {
        hands: [{ hand, button }],
        parts: objects.map((object) => ({
          object,
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
          scale: 1,
        })),
        twoHand: null,
      };
    }
    this.held.set(hand, hold);
    this.beginHold(hold);
    hand.pulse(0.5, 25);
    const items = hold.parts.flatMap((part) => this.app.items.of(part.object) ?? []);
    this.app.items.notifyGrab(hand, items, button);
  }

  private release(hand: HandState, button: HoldButton): void {
    const hold = this.held.get(hand);
    const index = hold?.hands.findIndex((holder) => holder.hand === hand && holder.button === button) ?? -1;
    if (!hold || index < 0) return;
    this.held.delete(hand);
    hold.hands.splice(index, 1);
    if (hold.hands.length > 0) this.beginHold(hold);
    hand.pulse(0.25, 20);
    this.app.items.notifyRelease(hand, button);
  }

  /** 持ち手の数が変わったときに、その時点の位置関係を基準として覚え直す。 */
  private beginHold(hold: Hold): void {
    const [first, second] = hold.hands;
    if (second) {
      const direction = _direction.copy(second.hand.grabPosition).sub(first.hand.grabPosition);
      const distance = Math.max(direction.length(), 0.02);
      hold.twoHand = { direction: direction.clone().normalize(), distance };
      _middle.addVectors(first.hand.grabPosition, second.hand.grabPosition).multiplyScalar(0.5);
      for (const part of hold.parts) {
        part.position.copy(part.object.position).sub(_middle);
        part.quaternion.copy(part.object.quaternion);
        part.scale = part.object.scale.x;
      }
    } else {
      hold.twoHand = null;
      const hand = first.hand;
      _delta.copy(hand.grabQuaternion).invert();
      for (const part of hold.parts) {
        part.position.copy(part.object.position).sub(hand.grabPosition).applyQuaternion(_delta);
        part.quaternion.copy(_delta).multiply(part.object.quaternion);
        part.scale = part.object.scale.x;
      }
    }
  }
}
