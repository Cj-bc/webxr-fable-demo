import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { clearBlobs } from '../blobStore';
import { copyPosition, copyQuaternion } from '../input';

/** 基準のアンカーから見た、物の位置 (x, y, z)・向き (x, y, z, w)・拡大率 */
export type SavedPose = number[];

/** 保存と復元に参加する機能。保存する値は JSON にできるものに限る。 */
export interface Persistent<T> {
  /** いまある物を書き出す。位置は poseOf() で、基準のアンカーから見た値にする。 */
  save(): T;
  /** 前回書き出した物を作り直す。位置は place() で、いまの座標に戻す。 */
  restore(data: T): void | Promise<void>;
}

type State =
  /** アンカーの永続化が使えない */
  | 'unsupported'
  /** 基準のアンカーを新しく作っている */
  | 'creating'
  /** 前回のアンカーが、いまの場所で見つかるのを待っている */
  | 'locating'
  /** 保存と復元が働いている */
  | 'ready'
  /** 前回のアンカーを復元できなかった (別の部屋にいるなど) */
  | 'lost'
  /** アンカーを作れなかった、または永続化できなかった */
  | 'failed';

const ORIGIN_KEY = 'mr-playroom/origin';
const STATE_KEY = 'mr-playroom/space';
/** 保存する間隔 (秒)。ページはいつ閉じられるか分からないので、こまめに書く。 */
const SAVE_INTERVAL = 2;

const STATUS: Record<State, string> = {
  unsupported: '空間の保存なし',
  creating: '空間: 基準を作成中',
  locating: '空間: 前回の場所を探索中',
  ready: '空間: 保存中',
  lost: '空間: 前回の場所が見つからず保存停止',
  failed: '空間: 保存できません',
};

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * 空間にある物を覚えておき、次にページを開いたときに、現実の同じ場所へ戻す。
 *
 * local-floor の座標は、セッションのたびに原点も向きも変わるので、座標をそのまま保存しても元の場所には戻らない。
 * そこで、永続アンカーを 1 つ「部屋の基準」として置き、物の位置はすべてそのアンカーから見た値で保存する。
 * 次のセッションでアンカーを復元すれば、そこから物の位置を計算し直せる。
 * (物ごとにアンカーを持たせないのは、永続アンカーに個数の上限があるため。)
 *
 * 前回のアンカーが見つからない間は、何も保存しない。別の部屋で開いたときに、元の部屋の内容を
 * 上書きしないようにするため。「全部消す」を押すと、いまの場所で基準を作り直す。
 */
export class Persistence implements Feature {
  readonly name = 'persistence';

  private readonly participants = new Map<string, Persistent<unknown>>();
  private state: State = 'unsupported';
  private session: XRSession | null = null;
  private anchor: XRAnchor | null = null;
  /** 永続化した基準のアンカーの識別子 */
  private uuid: string | null = null;
  /** このセッションで基準を作り直した (復元するものがない) */
  private fresh = false;
  private creating = false;
  /** 基準のアンカー → ワールド座標 の変換と、その逆 */
  private readonly origin = new THREE.Matrix4();
  private readonly originInverse = new THREE.Matrix4();
  private lastSave = 0;
  private lastJson = '';

  constructor(app: App) {
    app.onClear(() => this.handleClear());
  }

  /** 状態パネルに出す 1 行 */
  get status(): string {
    return STATUS[this.state];
  }

  register<T>(key: string, participant: Persistent<T>): void {
    this.participants.set(key, participant as Persistent<unknown>);
  }

  /** 物の姿勢を、基準のアンカーから見た値にする。save() の中で使う。 */
  poseOf(object: THREE.Object3D): SavedPose {
    _matrix.compose(object.position, object.quaternion, object.scale).premultiply(this.originInverse);
    _matrix.decompose(_position, _quaternion, _scale);
    return [..._position.toArray(), ..._quaternion.toArray(), _scale.x].map(round);
  }

  /** 保存した姿勢を、いまのワールド座標に直して物に設定する。restore() の中で使う。 */
  place(object: THREE.Object3D, pose: SavedPose): void {
    _position.fromArray(pose, 0);
    _quaternion.fromArray(pose, 3).normalize();
    _matrix.compose(_position, _quaternion, _scale.setScalar(pose[7])).premultiply(this.origin);
    _matrix.decompose(object.position, object.quaternion, object.scale);
  }

  start(session: XRSession): void {
    this.session = session;
    this.anchor = null;
    this.fresh = false;
    this.creating = false;
    this.lastJson = '';
    this.uuid = localStorage.getItem(ORIGIN_KEY);
    if (!session.restorePersistentAnchor) {
      this.state = 'unsupported';
      return;
    }
    if (!this.uuid) {
      this.state = 'creating';
      return;
    }
    this.state = 'locating';
    session.restorePersistentAnchor(this.uuid).then(
      (anchor) => {
        if (this.session === session && this.state === 'locating') this.anchor = anchor;
      },
      (error: unknown) => {
        if (this.session !== session || this.state !== 'locating') return;
        this.state = 'lost';
        console.warn('[persistence] 基準のアンカーを復元できませんでした', error);
      },
    );
  }

  end(): void {
    // 他の機能が物を片付ける前に、最後の状態を書いておく (この機能は他より先に登録されている)。
    if (this.state === 'ready') this.save();
    this.session = null;
    this.anchor = null;
  }

  update(ctx: FrameContext): void {
    if (this.state === 'creating' && !this.creating) this.createOrigin(ctx);
    const anchor = this.anchor;
    if (!anchor || (this.state !== 'locating' && this.state !== 'ready')) return;
    const pose = ctx.frame.trackedAnchors?.has(anchor) ? ctx.frame.getPose(anchor.anchorSpace, ctx.refSpace) : null;
    if (!pose) return;
    copyPosition(_position, pose.transform.position);
    copyQuaternion(_quaternion, pose.transform.orientation);
    this.origin.compose(_position, _quaternion, _scale.setScalar(1));
    this.originInverse.copy(this.origin).invert();

    if (this.state === 'locating') {
      this.state = 'ready';
      this.lastSave = ctx.time;
      if (!this.fresh) this.restore();
    }
    if (ctx.time - this.lastSave >= SAVE_INTERVAL) {
      this.lastSave = ctx.time;
      this.save();
    }
  }

  /** 頭の真下の床に、基準のアンカーを作って永続化する。 */
  private createOrigin(ctx: FrameContext): void {
    const session = ctx.session;
    this.creating = true;
    const transform = new XRRigidTransform({ x: ctx.headPosition.x, y: 0, z: ctx.headPosition.z });
    const created = ctx.frame.createAnchor?.(transform, ctx.refSpace);
    if (!created) {
      this.state = 'unsupported';
      return;
    }
    created
      .then(async (anchor) => {
        const uuid = await anchor.requestPersistentHandle?.();
        if (this.session !== session || this.state !== 'creating' || !uuid) {
          if (uuid) await session.deletePersistentAnchor?.(uuid);
          anchor.delete();
          if (this.session === session && this.state === 'creating') this.state = 'unsupported';
          return;
        }
        localStorage.setItem(ORIGIN_KEY, uuid);
        this.uuid = uuid;
        this.anchor = anchor;
        this.fresh = true;
        this.state = 'locating';
      })
      .catch((error: unknown) => {
        // Quest には永続アンカーの個数上限がある。配置した物が上限まで使っていると、ここで失敗する。
        if (this.session === session && this.state === 'creating') this.state = 'failed';
        console.warn('[persistence] 基準のアンカーを作れませんでした', error);
      });
  }

  private save(): void {
    const data: Record<string, unknown> = {};
    for (const [key, participant] of this.participants) {
      try {
        data[key] = participant.save();
      } catch (error) {
        console.error(`[persistence] ${key} を書き出せませんでした`, error);
      }
    }
    const json = JSON.stringify(data);
    if (json === this.lastJson) return;
    try {
      localStorage.setItem(STATE_KEY, json);
      this.lastJson = json;
    } catch (error) {
      console.warn('[persistence] 保存できませんでした', error);
    }
  }

  private restore(): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') ?? {};
    } catch {
      return;
    }
    for (const [key, participant] of this.participants) {
      if (data[key] === undefined) continue;
      // 1 つの機能の復元に失敗しても、他の機能は復元する。
      Promise.resolve()
        .then(() => participant.restore(data[key]))
        .catch((error: unknown) => console.error(`[persistence] ${key} を復元できませんでした`, error));
    }
  }

  /** 「全部消す」。保存が止まっているときは、前回の内容を捨てて、いまの場所で基準を作り直す。 */
  private handleClear(): void {
    if (this.state !== 'lost' && this.state !== 'failed' && this.state !== 'locating') return;
    if (!this.session) return;
    if (this.uuid) {
      this.session.deletePersistentAnchor?.(this.uuid).catch((error: unknown) => {
        console.warn('[persistence] 基準のアンカーを削除できませんでした', error);
      });
    }
    try {
      this.anchor?.delete();
    } catch {
      // すでに無効になっている
    }
    localStorage.removeItem(ORIGIN_KEY);
    localStorage.removeItem(STATE_KEY);
    // 復元できなかった写真の画像が残っているので、まとめて消す。
    void clearBlobs().catch(() => {});
    this.uuid = null;
    this.anchor = null;
    this.creating = false;
    this.state = 'creating';
  }
}

/** 保存する値は 0.1 mm 単位に丸めて、文字列を短くする。 */
export function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
