import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import type { HandState } from '../input';
import { RAPIER } from '../physics';
import type { SavedPose } from './persistence';

export type ToyKind = 'ball' | 'block';
type GrabButton = 'select' | 'squeeze';

interface Toy {
  kind: ToyKind;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** 拡大率。両手でつかんで変える。 */
  scale: number;
  holders: HandState[];
  /** 片手で持っているときの、手から見た物の位置と向き */
  offsetPosition: THREE.Vector3;
  offsetQuaternion: THREE.Quaternion;
  /** 両手で持ち始めた瞬間の状態 */
  twoHand: {
    middle: THREE.Vector3;
    direction: THREE.Vector3;
    distance: number;
    scale: number;
    relativePosition: THREE.Vector3;
    quaternion: THREE.Quaternion;
  } | null;
  lastImpactTime: number;
}

interface SavedToy {
  kind: ToyKind;
  color: number;
  pose: SavedPose;
}

/** 球の半径 / ブロックの一辺の半分 (m) */
const BASE_SIZE = 0.05;
const MIN_SCALE = 0.4;
const MAX_SCALE = 6;
const MAX_TOYS = 40;
/** 物の表面からこの距離までなら、つかめる (m) */
const GRAB_MARGIN = 0.05;
/** これより遅い衝突では音を出さない (m/s) */
const MIN_IMPACT_SPEED = 0.3;
const MIN_IMPACT_INTERVAL = 0.08;

const BALL_GEOMETRY = new THREE.SphereGeometry(BASE_SIZE, 32, 20);
const BLOCK_GEOMETRY = new THREE.BoxGeometry(BASE_SIZE * 2, BASE_SIZE * 2, BASE_SIZE * 2);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _delta = new THREE.Quaternion();

/**
 * つかんで投げられるボールとブロック。現実の床・壁・机 (Room の当たり判定) で跳ね返る。
 * - 物の近くでつまむ・手全体で握る / グリップを握る: つかむ
 * - 何もない所でつまむ / トリガー: 手の中に新しく出す
 * - 両手で同じ物をつかむ: 手の間隔で拡大縮小、手の向きで回転
 */
export class Toys implements Feature {
  readonly name = 'toys';
  /** 物がぶつかったときの通知 (効果音用) */
  onImpact: ((position: THREE.Vector3, speed: number, kind: ToyKind) => void) | null = null;

  private readonly toys: Toy[] = [];
  private readonly byCollider = new Map<number, Toy>();
  private readonly held = new Map<HandState, { toy: Toy; button: GrabButton }>();
  private time = 0;

  constructor(private readonly app: App) {
    const { input, tools } = app;
    tools.addInterceptor((hand) => this.tryGrab(hand, 'select'));
    input.on('selectend', (hand) => this.release(hand, 'select'));
    input.on('squeezestart', (hand) => void this.tryGrab(hand, 'squeeze'));
    input.on('squeezeend', (hand) => this.release(hand, 'squeeze'));

    tools.register({
      id: 'ball',
      label: 'ボール',
      hint: 'つまむ/トリガーで出し、離して投げる',
      onSelectStart: (hand) => this.spawnInHand('ball', hand),
    });
    tools.register({
      id: 'block',
      label: 'ブロック',
      hint: '出して積む。両手でつかむと拡大・回転',
      onSelectStart: (hand) => this.spawnInHand('block', hand),
    });
    app.onClear(() => this.clear());
    app.physics.onCollisionStart((c1, c2) => this.handleCollision(c1, c2));
    app.persistence.register<SavedToy[]>('toys', {
      save: () =>
        this.toys.map((toy) => ({
          kind: toy.kind,
          color: toy.mesh.material.color.getHex(),
          pose: app.persistence.poseOf(toy.mesh),
        })),
      restore: (saved) => {
        for (const { kind, color, pose } of saved) {
          if (this.toys.length >= MAX_TOYS) break;
          const mesh = createMesh(kind, new THREE.Color(color));
          app.persistence.place(mesh, pose);
          // 眠らせた状態で戻す。復元の時点では、床や机の当たり判定がまだ届いていないことがあり、
          // 動ける状態で置くと、そのまま下へ落ちていってしまう。何かが当たるか、つかめば動き出す。
          this.addToy(kind, mesh, true);
        }
      },
    });
  }

  get count(): number {
    return this.toys.length;
  }

  end(): void {
    this.clear();
  }

  clear(): void {
    while (this.toys.length > 0) this.remove(this.toys[0]);
  }

  update(ctx: FrameContext): void {
    this.time = ctx.time;
    for (let i = this.toys.length - 1; i >= 0; i--) {
      const toy = this.toys[i];
      if (toy.holders.length > 0) {
        this.followHands(toy);
      } else {
        const position = toy.body.translation();
        if (position.y < -10) {
          // 当たり判定の無い所から落ちていった物は片付ける。
          this.remove(toy);
          continue;
        }
        toy.mesh.position.set(position.x, position.y, position.z);
        const rotation = toy.body.rotation();
        toy.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }
    }
  }

  private spawnInHand(kind: ToyKind, hand: HandState): void {
    if (!hand.tracked || this.held.has(hand)) return;
    if (this.toys.length >= MAX_TOYS) {
      const oldest = this.toys.find((toy) => toy.holders.length === 0);
      if (oldest) this.remove(oldest);
    }
    const mesh = createMesh(kind, new THREE.Color().setHSL(Math.random(), 0.75, 0.55));
    mesh.position.copy(hand.grabPosition);
    mesh.quaternion.copy(hand.grabQuaternion);
    this.grab(this.addToy(kind, mesh, false), hand, 'select');
  }

  /** メッシュの位置・向き・大きさに合わせて、物理の剛体を作る。 */
  private addToy(kind: ToyKind, mesh: Toy['mesh'], sleeping: boolean): Toy {
    const world = this.app.physics.world;
    const scale = THREE.MathUtils.clamp(mesh.scale.x, MIN_SCALE, MAX_SCALE);
    mesh.scale.setScalar(scale);
    this.app.scene.add(mesh);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
        .setRotation(mesh.quaternion)
        // 投げた球が薄い壁をすり抜けないよう、連続衝突判定を使う。
        .setCcdEnabled(true)
        .setLinearDamping(0.05)
        .setAngularDamping(0.4)
        .setSleeping(sleeping),
    );
    const toy: Toy = {
      kind,
      mesh,
      body,
      collider: world.createCollider(colliderDesc(kind, scale), body),
      scale,
      holders: [],
      offsetPosition: new THREE.Vector3(),
      offsetQuaternion: new THREE.Quaternion(),
      twoHand: null,
      lastImpactTime: 0,
    };
    this.byCollider.set(toy.collider.handle, toy);
    this.toys.push(toy);
    return toy;
  }

  private tryGrab(hand: HandState, button: GrabButton): boolean {
    if (!hand.tracked || this.held.has(hand)) return false;
    let nearest: Toy | null = null;
    let nearestDistance = Infinity;
    for (const toy of this.toys) {
      // ブロックは角までの距離を見込んで広めに取る。
      const reach = BASE_SIZE * toy.scale * (toy.kind === 'ball' ? 1 : 1.5) + GRAB_MARGIN;
      const distance = toy.mesh.position.distanceTo(hand.grabPosition) - reach;
      if (distance < 0 && distance < nearestDistance) {
        nearest = toy;
        nearestDistance = distance;
      }
    }
    if (!nearest) return false;
    this.grab(nearest, hand, button);
    return true;
  }

  private grab(toy: Toy, hand: HandState, button: GrabButton): void {
    if (toy.holders.length >= 2) return;
    if (toy.holders.length === 0) {
      // 持っている間は手に追従させるだけなので、物理の力を受けない kinematic にする。
      toy.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    }
    toy.holders.push(hand);
    this.held.set(hand, { toy, button });
    this.beginHold(toy);
    hand.pulse(0.5, 25);
  }

  private release(hand: HandState, button: GrabButton): void {
    const holding = this.held.get(hand);
    if (!holding || holding.button !== button) return;
    this.held.delete(hand);
    const toy = holding.toy;
    toy.holders.splice(toy.holders.indexOf(hand), 1);
    if (toy.twoHand) this.rebuildCollider(toy);

    if (toy.holders.length > 0) {
      this.beginHold(toy);
      return;
    }
    // 手を離した瞬間の手の速度を、そのまま物の初速にする。
    toy.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    toy.body.setTranslation(toy.mesh.position, true);
    toy.body.setRotation(toy.mesh.quaternion, true);
    toy.body.setLinvel(hand.velocity, true);
    toy.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    hand.pulse(0.25, 20);
  }

  /** 持ち手の数が変わったときに、その時点の位置関係を基準として覚え直す。 */
  private beginHold(toy: Toy): void {
    const [first, second] = toy.holders;
    if (second) {
      const direction = _a.copy(second.grabPosition).sub(first.grabPosition);
      const distance = Math.max(direction.length(), 0.02);
      const middle = new THREE.Vector3().addVectors(first.grabPosition, second.grabPosition).multiplyScalar(0.5);
      toy.twoHand = {
        middle,
        direction: direction.clone().normalize(),
        distance,
        scale: toy.scale,
        relativePosition: toy.mesh.position.clone().sub(middle),
        quaternion: toy.mesh.quaternion.clone(),
      };
    } else {
      toy.twoHand = null;
      _delta.copy(first.grabQuaternion).invert();
      toy.offsetPosition.copy(toy.mesh.position).sub(first.grabPosition).applyQuaternion(_delta);
      toy.offsetQuaternion.copy(_delta).multiply(toy.mesh.quaternion);
    }
  }

  private followHands(toy: Toy): void {
    const [first, second] = toy.holders;
    const mesh = toy.mesh;
    if (second && toy.twoHand) {
      const start = toy.twoHand;
      const direction = _a.copy(second.grabPosition).sub(first.grabPosition);
      const distance = Math.max(direction.length(), 0.02);
      direction.normalize();
      toy.scale = THREE.MathUtils.clamp((start.scale * distance) / start.distance, MIN_SCALE, MAX_SCALE);
      // 両手を結ぶ線の向きの変化を、そのまま物の回転にする。
      _delta.setFromUnitVectors(start.direction, direction);
      mesh.quaternion.copy(_delta).multiply(start.quaternion);
      mesh.position
        .copy(start.relativePosition)
        .applyQuaternion(_delta)
        .multiplyScalar(toy.scale / start.scale)
        .add(_b.addVectors(first.grabPosition, second.grabPosition).multiplyScalar(0.5));
      mesh.scale.setScalar(toy.scale);
    } else {
      mesh.quaternion.copy(first.grabQuaternion).multiply(toy.offsetQuaternion);
      mesh.position.copy(toy.offsetPosition).applyQuaternion(first.grabQuaternion).add(first.grabPosition);
    }
    toy.body.setNextKinematicTranslation(mesh.position);
    toy.body.setNextKinematicRotation(mesh.quaternion);
  }

  /** Rapier のコライダーは後から拡大できないので、大きさが変わったら作り直す。 */
  private rebuildCollider(toy: Toy): void {
    const world = this.app.physics.world;
    this.byCollider.delete(toy.collider.handle);
    world.removeCollider(toy.collider, false);
    toy.collider = world.createCollider(colliderDesc(toy.kind, toy.scale), toy.body);
    this.byCollider.set(toy.collider.handle, toy);
  }

  private remove(toy: Toy): void {
    for (const hand of toy.holders) this.held.delete(hand);
    this.byCollider.delete(toy.collider.handle);
    // 剛体を消すと、付いているコライダーも一緒に消える。
    this.app.physics.world.removeRigidBody(toy.body);
    this.app.scene.remove(toy.mesh);
    toy.mesh.material.dispose();
    this.toys.splice(this.toys.indexOf(toy), 1);
  }

  private handleCollision(collider1: number, collider2: number): void {
    for (const toy of [this.byCollider.get(collider1), this.byCollider.get(collider2)]) {
      if (!toy || toy.holders.length > 0) continue;
      if (this.time - toy.lastImpactTime < MIN_IMPACT_INTERVAL) continue;
      const velocity = toy.body.linvel();
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      if (speed < MIN_IMPACT_SPEED) continue;
      toy.lastImpactTime = this.time;
      const position = toy.body.translation();
      this.onImpact?.(_a.set(position.x, position.y, position.z), speed, toy.kind);
      // 2 つの物どうしの衝突でも、音は 1 回でよい。
      return;
    }
  }
}

function createMesh(kind: ToyKind, color: THREE.Color): Toy['mesh'] {
  const material = new THREE.MeshStandardMaterial({ color, roughness: kind === 'ball' ? 0.35 : 0.7 });
  const mesh = new THREE.Mesh(kind === 'ball' ? BALL_GEOMETRY : BLOCK_GEOMETRY, material);
  mesh.castShadow = true;
  return mesh;
}

function colliderDesc(kind: ToyKind, scale: number): RAPIER.ColliderDesc {
  const size = BASE_SIZE * scale;
  const desc = kind === 'ball' ? RAPIER.ColliderDesc.ball(size) : RAPIER.ColliderDesc.cuboid(size, size, size);
  return desc
    .setDensity(kind === 'ball' ? 300 : 500)
    .setRestitution(kind === 'ball' ? 0.75 : 0.15)
    .setFriction(kind === 'ball' ? 0.5 : 0.9)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
}
