import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { type HandState, copyPosition } from '../input';
import { GROUP_ALL, GROUP_HAND, RAPIER, interactionGroups } from '../physics';

/** 素手の関節の数 (WebXR Hand Input で決まっている) */
const JOINT_COUNT = 25;
/** コントローラーの当たり判定の球の半径 (m) */
const CONTROLLER_RADIUS = 0.04;
/** 関節の半径がこれ以上変わったら、当たり判定の球を作り直す (m) */
const RADIUS_TOLERANCE = 0.001;
const HAND_FRICTION = 0.8;
const HAND_RESTITUTION = 0.3;

/** 当たり判定の球 1 つ。素手なら関節 1 つ、コントローラーなら握りの位置に 1 つ。 */
interface Slot {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  radius: number;
}

const _position = new THREE.Vector3();

/**
 * 自分の手を物理の当たり判定にする。素手では関節ごと、コントローラーでは握りの位置に球を置き、
 * ボールやブロックを押したり叩いたりできるようにする。
 *
 * 球は kinematic な剛体で、毎フレーム手の位置へ「動かす」。瞬間移動させずに次の位置を指定すると、
 * Rapier がその移動から速度を求めるので、振った手の勢いがそのまま物に伝わる。
 * kinematic どうしはぶつからないので、手に持っている物 (これも kinematic) は押し出さない。
 */
export class HandColliders implements Feature {
  readonly name = 'handColliders';
  enabled = true;

  private readonly slots = new Map<HandState, Slot[]>();

  constructor(private readonly app: App) {
    app.menu.addToggle(
      '手で押す',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
  }

  start(): void {
    const world = this.app.physics.world;
    for (const hand of this.app.input.hands) {
      const slots: Slot[] = [];
      for (let i = 0; i < JOINT_COUNT; i++) {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
        const collider = world.createCollider(colliderDesc(CONTROLLER_RADIUS).setEnabled(false), body);
        slots.push({ body, collider, radius: CONTROLLER_RADIUS });
      }
      this.slots.set(hand, slots);
    }
  }

  end(): void {
    const world = this.app.physics.world;
    for (const slots of this.slots.values()) {
      // 剛体を消すと、付いているコライダーも一緒に消える。
      for (const slot of slots) world.removeRigidBody(slot.body);
    }
    this.slots.clear();
  }

  update(ctx: FrameContext): void {
    for (const [hand, slots] of this.slots) {
      let used = 0;
      if (this.enabled && hand.tracked) {
        const joints = hand.source?.hand;
        if (joints) {
          // XRHand は関節名 → XRJointSpace の Map。関節ごとに位置と半径 (指の太さ) が取れる。
          for (const space of joints.values()) {
            if (used >= slots.length) break;
            const pose = ctx.frame.getJointPose?.(space, ctx.refSpace);
            if (!pose) continue;
            this.place(slots[used++], copyPosition(_position, pose.transform.position), pose.radius ?? 0.01);
          }
        } else {
          this.place(slots[used++], hand.grabPosition, CONTROLLER_RADIUS);
        }
      }
      for (let i = used; i < slots.length; i++) slots[i].collider.setEnabled(false);
    }
  }

  private place(slot: Slot, position: RAPIER.Vector, radius: number): void {
    if (Math.abs(slot.radius - radius) > RADIUS_TOLERANCE) {
      slot.collider.setRadius(radius);
      slot.radius = radius;
    }
    if (slot.collider.isEnabled()) {
      slot.body.setNextKinematicTranslation(position);
    } else {
      // 見失っていた手が離れた所に現れたとき、その間を一瞬で動いたことにすると、
      // 途中にある物を猛烈な速さで弾き飛ばしてしまう。止まったまま置き直す。
      slot.body.setTranslation(position, true);
      slot.collider.setEnabled(true);
    }
  }
}

function colliderDesc(radius: number): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.ball(radius)
    .setFriction(HAND_FRICTION)
    .setRestitution(HAND_RESTITUTION)
    .setCollisionGroups(interactionGroups(GROUP_HAND, GROUP_ALL & ~GROUP_HAND));
}
