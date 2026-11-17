import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { clearBlobs } from '../blobStore';
import { copyPosition, copyQuaternion } from '../input';
import { savedAnchorIds } from './placement';

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
  /** 作ったが、まだ永続化していない基準のアンカー。追跡が始まるのを待ってから永続化する。 */
  private pendingAnchor: XRAnchor | null = null;
  private persisting = false;
  /** 前回の物を戻している最中 */
  private restoring = false;
  /** 基準のアンカー → ワールド座標 の変換と、その逆 */
  private readonly origin = new THREE.Matrix4();
  private readonly originInverse = new THREE.Matrix4();
  private lastSave = 0;
  private lastJson = '';
  /** 直近の失敗の理由 */
  private error = '';

  constructor(app: App) {
    app.onClear(() => this.handleClear());
  }

  /** 状態パネルに出す 1 行 */
  get status(): string {
    if (!this.error) return STATUS[this.state];
    // 失敗の理由が個数の上限かどうかを見分けられるよう、このサイトが持っている永続アンカーの数も出す。
    const count = this.session?.persistentAnchors?.length;
    return `${STATUS[this.state]} (${this.error}${count === undefined ? '' : ` / 永続アンカー ${count} 個`})`;
  }

  /** 失敗の理由を、状態パネルに出せるよう覚えておく。Quest ではコンソールを見にくいため。 */
  private fail(state: State, step: string, error?: unknown): void {
    this.state = state;
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : error ? String(error) : '';
    this.error = reason ? `${step}: ${reason}` : step;
    console.warn(`[persistence] ${step}`, error);
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
    this.pendingAnchor = null;
    this.persisting = false;
    this.restoring = false;
    this.lastJson = '';
    this.error = '';
    this.uuid = localStorage.getItem(ORIGIN_KEY);
    this.deleteOrphans(session);
    if (!session.restorePersistentAnchor) {
      this.fail('unsupported', 'restorePersistentAnchor がありません');
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
        this.fail('lost', '復元', error);
      },
    );
  }

  end(): void {
    // 他の機能が物を片付ける前に、最後の状態を書いておく (この機能は他より先に登録されている)。
    if (this.state === 'ready') this.save();
    this.session = null;
    this.anchor = null;
  }

  /**
   * このサイトの永続アンカーのうち、どこからも使われていないものを消す。
   * 永続アンカーには個数の上限があり、保存した識別子を失ったもの (サイトのデータを消した、
   * 永続化の途中でセッションが終わったなど) が残っていると、新しく作れなくなるため。
   */
  private deleteOrphans(session: XRSession): void {
    const known = new Set([...savedAnchorIds(), ...(this.uuid ? [this.uuid] : [])]);
    for (const uuid of session.persistentAnchors ?? []) {
      if (known.has(uuid)) continue;
      session.deletePersistentAnchor?.(uuid).catch((error: unknown) => {
        console.warn(`[persistence] 使われていない永続アンカー ${uuid} を削除できませんでした`, error);
      });
    }
  }

  update(ctx: FrameContext): void {
    if (this.state === 'creating' && !this.creating) this.createOrigin(ctx);
    if (this.state === 'creating' && this.pendingAnchor && !this.persisting) {
      if (ctx.frame.trackedAnchors?.has(this.pendingAnchor)) this.persistOrigin(ctx.session, this.pendingAnchor);
    }
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

  /** 頭の真下の床に、基準のアンカーを作る。永続化は、追跡が始まってから persistOrigin() で行う。 */
  private createOrigin(ctx: FrameContext): void {
    const session = ctx.session;
    this.creating = true;
    const transform = new XRRigidTransform({ x: ctx.headPosition.x, y: 0, z: ctx.headPosition.z });
    const created = ctx.frame.createAnchor?.(transform, ctx.refSpace);
    if (!created) {
      this.fail('unsupported', 'createAnchor がありません');
      return;
    }
    created.then(
      (anchor) => {
        if (this.session !== session || this.state !== 'creating') {
          anchor.delete();
          return;
        }
        this.pendingAnchor = anchor;
      },
      (error: unknown) => {
        if (this.session === session && this.state === 'creating') this.fail('failed', '作成', error);
      },
    );
  }

  /**
   * 基準のアンカーを永続化する。作った直後のアンカーは、まだシステムが場所を把握しきれておらず、
   * 永続化に失敗することがあるので、追跡が始まってから呼ぶ。
   */
  private persistOrigin(session: XRSession, anchor: XRAnchor): void {
    if (!anchor.requestPersistentHandle) {
      this.fail('unsupported', 'requestPersistentHandle がありません');
      return;
    }
    this.persisting = true;
    anchor.requestPersistentHandle().then(
      (uuid) => {
        if (this.session !== session || this.state !== 'creating') {
          session.deletePersistentAnchor?.(uuid).catch(() => {});
          anchor.delete();
          return;
        }
        localStorage.setItem(ORIGIN_KEY, uuid);
        this.uuid = uuid;
        this.anchor = anchor;
        this.pendingAnchor = null;
        this.fresh = true;
        this.state = 'locating';
      },
      (error: unknown) => {
        // Quest には永続アンカーの個数上限がある。配置した物が上限まで使っていると、ここで失敗する。
        if (this.session === session && this.state === 'creating') this.fail('failed', '永続化', error);
      },
    );
  }

  private save(): void {
    if (this.restoring) return;
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
    const session = this.session;
    const restoring: Promise<void>[] = [];
    for (const [key, participant] of this.participants) {
      if (data[key] === undefined) continue;
      // 1 つの機能の復元に失敗しても、他の機能は復元する。
      restoring.push(
        Promise.resolve()
          .then(() => participant.restore(data[key]))
          .catch((error: unknown) => console.error(`[persistence] ${key} を復元できませんでした`, error)),
      );
    }
    // 画像の読み込みなど、復元に時間のかかる物がある。戻りきる前に保存すると、まだ戻っていない物が
    // 保存から抜けてしまうので、全部終わるまで保存を止める。
    this.restoring = true;
    void Promise.all(restoring).then(() => {
      if (this.session === session) this.restoring = false;
    });
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
    for (const anchor of [this.anchor, this.pendingAnchor]) {
      try {
        anchor?.delete();
      } catch {
        // すでに無効になっている
      }
    }
    localStorage.removeItem(ORIGIN_KEY);
    localStorage.removeItem(STATE_KEY);
    // 復元できなかった写真の画像が残っているので、まとめて消す。
    void clearBlobs().catch(() => {});
    this.uuid = null;
    this.anchor = null;
    this.pendingAnchor = null;
    this.creating = false;
    this.persisting = false;
    this.error = '';
    // 配置した物のアンカーも同時に消えるので、上限で失敗していた場合も、ここで作り直せる。
    this.state = 'creating';
  }
}

/** 保存する値は 0.1 mm 単位に丸めて、文字列を短くする。 */
export function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
