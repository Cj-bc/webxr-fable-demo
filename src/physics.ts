import RAPIER from '@dimforge/rapier3d-compat';
import type { Feature, FrameContext } from './app';

export { RAPIER };

/** 衝突が始まったときの通知。引数は衝突した 2 つのコライダーのハンドル。 */
export type CollisionListener = (collider1: number, collider2: number) => void;

/** 物理ワールド (Rapier)。座標系は local-floor 参照空間と同じで、単位はメートル。 */
export class Physics implements Feature {
  readonly name = 'physics';
  world!: RAPIER.World;

  private eventQueue!: RAPIER.EventQueue;
  private readonly collisionListeners: CollisionListener[] = [];

  /** WASM の読み込みが要るので、使う前に一度 await する。 */
  async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  onCollisionStart(listener: CollisionListener): void {
    this.collisionListeners.push(listener);
  }

  update(ctx: FrameContext): void {
    this.world.timestep = ctx.dt;
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents((collider1, collider2, started) => {
      if (!started) return;
      for (const listener of this.collisionListeners) listener(collider1, collider2);
    });
  }
}
