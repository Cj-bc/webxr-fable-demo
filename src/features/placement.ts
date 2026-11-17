import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { copyPosition, copyQuaternion, type HandState } from '../input';
import { isHorizontal, orientOnSurface } from '../surface';
import type { HitTest } from './hitTest';

type Kind = 'plant' | 'lamp' | 'tower' | 'picture';

interface Placed {
  kind: Kind;
  object: THREE.Group;
  /** アンカーが作れなかった場合は null (置いた時の座標のまま) */
  anchor: XRAnchor | null;
  /** 永続化できた場合の識別子 */
  uuid: string | null;
}

interface Saved {
  uuid: string;
  kind: Kind;
}

const STORAGE_KEY = 'mr-playroom/anchors';
const FLOOR_KINDS: Kind[] = ['plant', 'lamp', 'tower'];
const TOOL_ID = 'place';

const _quaternion = new THREE.Quaternion();

/**
 * レイで指した現実の面に物を置き、アンカーで固定する (hit-test + anchors)。
 *
 * アンカーは「現実のこの場所」をシステムに覚えてもらう仕組み。部屋の認識が更新されて
 * 座標系がずれても、アンカーの姿勢を毎フレーム読み直せば物は現実の同じ場所に留まる。
 * Quest ではさらにアンカーを永続化でき、UUID を保存しておけば次回のセッションで復元できる。
 */
export class Placement implements Feature {
  readonly name = 'placement';
  /** 永続化の上限に達したなどで、保存できなかった回数 */
  persistFailures = 0;

  private readonly placed: Placed[] = [];
  /** 置く操作をした手。アンカーはフレーム処理の中でしか作れないので、update まで待つ。 */
  private readonly pending: HandState[] = [];
  /** 保存されているが、このセッションでは復元できていないもの */
  private unrestored: Saved[] = [];
  private nextKind = 0;
  private session: XRSession | null = null;

  constructor(
    private readonly app: App,
    private readonly hitTest: HitTest,
  ) {
    hitTest.showFor(TOOL_ID);
    app.tools.register({
      id: TOOL_ID,
      label: '配置',
      hint: 'レイで床や壁を指し、つまむ/トリガーで置く',
      onSelectStart: (hand) => this.pending.push(hand),
    });
    app.onClear(() => this.clear());
  }

  get count(): number {
    return this.placed.length;
  }

  get anchoredCount(): number {
    return this.placed.filter((p) => p.anchor).length;
  }

  get persistentCount(): number {
    return this.placed.filter((p) => p.uuid).length;
  }

  start(session: XRSession): void {
    this.session = session;
    this.persistFailures = 0;
    this.unrestored = loadSaved();
    // 復元の完了を待たずに描画を始める (待つと、その間ずっと何も表示されない)。
    void this.restore(session);
  }

  /** 前回までに保存した UUID からアンカーを復元する。 */
  private async restore(session: XRSession): Promise<void> {
    if (!session.restorePersistentAnchor) return;
    for (const saved of [...this.unrestored]) {
      try {
        const anchor = await session.restorePersistentAnchor(saved.uuid);
        if (this.session !== session || !this.unrestored.includes(saved)) return;
        this.unrestored.splice(this.unrestored.indexOf(saved), 1);
        const object = build(saved.kind);
        // 姿勢が取れるまでは、どこに置くべきか分からないので隠しておく。
        object.visible = false;
        this.add({ kind: saved.kind, object, anchor, uuid: saved.uuid });
      } catch (error) {
        // 別の部屋にいるなどで復元できないことがある。元の部屋に戻れば使えるので、保存は残す。
        console.warn(`[placement] アンカー ${saved.uuid} を復元できませんでした`, error);
      }
    }
  }

  end(): void {
    // 永続化したアンカーは残したまま、表示だけ片付ける。
    for (const placed of this.placed) this.app.scene.remove(placed.object);
    this.placed.length = 0;
    this.pending.length = 0;
    this.session = null;
  }

  clear(): void {
    for (const placed of this.placed) {
      this.app.scene.remove(placed.object);
      try {
        placed.anchor?.delete();
      } catch {
        // すでに無効になっている
      }
    }
    // 復元できなかったものも含めて、保存してあるアンカーをすべて消す。
    const uuids = [...this.placed.flatMap((p) => p.uuid ?? []), ...this.unrestored.map((saved) => saved.uuid)];
    for (const uuid of uuids) {
      this.session?.deletePersistentAnchor?.(uuid).catch((error: unknown) => {
        console.warn('[placement] 永続アンカーを削除できませんでした', error);
      });
    }
    this.placed.length = 0;
    this.unrestored = [];
    this.save();
  }

  private save(): void {
    store([...this.unrestored, ...this.placed.flatMap((p) => (p.uuid ? [{ uuid: p.uuid, kind: p.kind }] : []))]);
  }

  update(ctx: FrameContext): void {
    for (const hand of this.pending.splice(0)) this.place(hand, ctx);

    for (const placed of this.placed) {
      if (!placed.anchor) continue;
      // trackedAnchors は、いま追跡できているアンカーの集合。作った直後はまだ入っていない。
      const pose = ctx.frame.trackedAnchors?.has(placed.anchor)
        ? ctx.frame.getPose(placed.anchor.anchorSpace, ctx.refSpace)
        : null;
      if (!pose) continue;
      placed.object.visible = true;
      copyPosition(placed.object.position, pose.transform.position);
      copyQuaternion(placed.object.quaternion, pose.transform.orientation);
    }
  }

  private place(hand: HandState, ctx: FrameContext): void {
    const hit = this.hitTest.getHit(hand);
    if (!hit) return;
    let kind: Kind = 'picture';
    if (isHorizontal(hit.normal)) {
      kind = FLOOR_KINDS[this.nextKind];
      this.nextKind = (this.nextKind + 1) % FLOOR_KINDS.length;
    }
    const placed: Placed = { kind, object: build(kind), anchor: null, uuid: null };
    placed.object.position.copy(hit.position);
    orientOnSurface(hit.position, hit.normal, ctx.headPosition, placed.object.quaternion);
    this.add(placed);
    hand.pulse(0.7, 40);

    // XRHitTestResult.createAnchor() でも作れるが、物の向きをこちらで決めたいので
    // 姿勢を指定できる frame.createAnchor() を使う。アンカーの姿勢 = 物の姿勢になる。
    _quaternion.copy(placed.object.quaternion);
    const transform = new XRRigidTransform(
      { x: hit.position.x, y: hit.position.y, z: hit.position.z },
      { x: _quaternion.x, y: _quaternion.y, z: _quaternion.z, w: _quaternion.w },
    );
    ctx.frame
      .createAnchor?.(transform, ctx.refSpace)
      ?.then((anchor) => {
        if (!this.placed.includes(placed)) {
          anchor.delete();
          return;
        }
        placed.anchor = anchor;
        return this.persist(placed, anchor);
      })
      .catch((error: unknown) => {
        console.warn('[placement] アンカーを作れませんでした。置いた時の座標のまま表示します', error);
      });
  }

  private async persist(placed: Placed, anchor: XRAnchor): Promise<void> {
    if (!anchor.requestPersistentHandle) return;
    try {
      const uuid = await anchor.requestPersistentHandle();
      if (!this.placed.includes(placed)) {
        await this.session?.deletePersistentAnchor?.(uuid);
        return;
      }
      placed.uuid = uuid;
      this.save();
    } catch (error) {
      // Quest には永続アンカーの個数上限がある。超えると失敗するが、このセッション中は使える。
      this.persistFailures++;
      console.warn('[placement] アンカーを永続化できませんでした', error);
    }
  }

  private add(placed: Placed): void {
    this.placed.push(placed);
    this.app.scene.add(placed.object);
  }
}

function loadSaved(): Saved[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Saved => typeof item?.uuid === 'string' && typeof item?.kind === 'string' && item.kind in BUILDERS,
    );
  } catch {
    return [];
  }
}

function store(saved: Saved[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch (error) {
    console.warn('[placement] 保存できませんでした', error);
  }
}

function build(kind: Kind): THREE.Group {
  const group = BUILDERS[kind]();
  group.traverse((object) => {
    object.castShadow = true;
  });
  return group;
}

function standard(color: number, options: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...options });
}

function part(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}

/** 物の原点は接地点。水平面用は +Y が上、壁用は +Z が手前。 */
const BUILDERS: Record<Kind, () => THREE.Group> = {
  plant() {
    const leaf = standard(0x3f9b55);
    return new THREE.Group().add(
      part(new THREE.CylinderGeometry(0.07, 0.05, 0.1, 20), standard(0xb5653b), 0, 0.05, 0),
      part(new THREE.SphereGeometry(0.09, 16, 12), leaf, 0, 0.19, 0),
      part(new THREE.SphereGeometry(0.07, 16, 12), leaf, 0.05, 0.27, 0.02),
      part(new THREE.SphereGeometry(0.06, 16, 12), leaf, -0.04, 0.3, -0.03),
    );
  },
  lamp() {
    const metal = standard(0x2f3542, { roughness: 0.4, metalness: 0.6 });
    return new THREE.Group().add(
      part(new THREE.CylinderGeometry(0.08, 0.09, 0.02, 24), metal, 0, 0.01, 0),
      part(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 8), metal, 0, 0.27, 0),
      part(
        new THREE.SphereGeometry(0.07, 20, 14),
        standard(0xfff1c9, { emissive: 0xffc56b, emissiveIntensity: 1.2 }),
        0,
        0.56,
        0,
      ),
    );
  },
  tower() {
    const group = new THREE.Group();
    [0xff6b6b, 0xffd166, 0x4f8cff].forEach((color, i) => {
      const size = 0.12 - i * 0.025;
      const block = part(new THREE.BoxGeometry(size, 0.08, size), standard(color), 0, 0.04 + i * 0.08, 0);
      block.rotation.y = i * 0.5;
      group.add(block);
    });
    return group;
  },
  picture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 192;
    const g = canvas.getContext('2d')!;
    const hue = Math.floor(Math.random() * 360);
    const sky = g.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, `hsl(${hue}, 70%, 30%)`);
    sky.addColorStop(1, `hsl(${(hue + 60) % 360}, 80%, 70%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = `hsl(${(hue + 180) % 360}, 80%, 75%)`;
    g.beginPath();
    g.arc(180, 70, 28, 0, Math.PI * 2);
    g.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Group().add(
      part(new THREE.BoxGeometry(0.44, 0.34, 0.02), standard(0x3b2a1e), 0, 0, 0.01),
      part(new THREE.PlaneGeometry(0.4, 0.3), new THREE.MeshBasicMaterial({ map: texture }), 0, 0, 0.021),
    );
  },
};
