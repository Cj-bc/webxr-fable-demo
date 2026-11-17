import * as THREE from 'three';
import type { App, Feature } from '../app';
import type { HandState } from '../input';

/** 手で持って動かせる物。object はシーンの直下に置かれていること (位置と向きをワールド座標で書き換える)。 */
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

interface Hold {
  button: HoldButton;
  /** 持ち始めたときの、手から見た物の位置と向き */
  parts: { object: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion }[];
}

/** 物の表面からこの距離までなら、持てる (m) */
const HOLD_MARGIN = 0.04;

const _inverse = new THREE.Quaternion();

/**
 * 写真や線のような、物理を持たない物を手で持って動かす。離すと、その場に浮いたまま残る。
 * - 物の近くでつまむ / トリガー / グリップ: 持つ
 * - すでに持たれている物を別の手で持つと、その手に持ち替える
 *
 * 物理で動くおもちゃは、投げる・両手で拡大するなど扱いが違うので、Toys が自前で持つ。
 */
export class Holding implements Feature {
  readonly name = 'holding';
  private readonly holdables: Holdable[] = [];
  private readonly held = new Map<HandState, Hold>();

  constructor(private readonly app: App) {
    const { input, tools } = app;
    tools.addInterceptor((hand) => this.tryHold(hand, 'select'));
    input.on('selectend', (hand) => this.release(hand, 'select'));
    input.on('squeezestart', (hand) => void this.tryHold(hand, 'squeeze'));
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
  }

  update(): void {
    for (const [hand, hold] of this.held) {
      if (!hand.tracked) continue;
      for (const part of hold.parts) {
        part.object.quaternion.copy(hand.grabQuaternion).multiply(part.quaternion);
        part.object.position.copy(part.position).applyQuaternion(hand.grabQuaternion).add(hand.grabPosition);
      }
    }
  }

  private tryHold(hand: HandState, button: HoldButton): boolean {
    if (!hand.tracked || this.held.has(hand)) return false;
    // 線の近くでも描き足せるよう、つまみを道具に譲る。グリップでは持てる。
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

    const objects = nearest.group?.() ?? [nearest.object];
    // もう一方の手が同じ物を持っていたら、そちらからは外す。
    for (const [other, hold] of this.held) {
      hold.parts = hold.parts.filter((part) => !objects.includes(part.object));
      if (hold.parts.length === 0) this.held.delete(other);
    }
    _inverse.copy(hand.grabQuaternion).invert();
    this.held.set(hand, {
      button,
      parts: objects.map((object) => ({
        object,
        position: object.position.clone().sub(hand.grabPosition).applyQuaternion(_inverse),
        quaternion: _inverse.clone().multiply(object.quaternion),
      })),
    });
    hand.pulse(0.5, 25);
    return true;
  }

  private release(hand: HandState, button: HoldButton): void {
    if (this.held.get(hand)?.button !== button) return;
    this.held.delete(hand);
    hand.pulse(0.25, 20);
  }
}
