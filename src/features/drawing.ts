import * as THREE from 'three';
import type { App, Feature } from '../app';
import type { HandState } from '../input';
import type { Item } from '../items';
import { round, type SavedPose } from './persistence';

interface Stroke {
  points: THREE.Vector3[];
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  /** 描き終えている (もう点が増えない) */
  complete: boolean;
  /** 保存用に丸めて並べた点列。描き終えた線は変わらないので、一度作ったら使い回す。 */
  savedPoints?: number[];
  /** 削除・複製などの操作から見た、この線。描き終えたときに作る。 */
  item?: Item;
}

interface SavedStroke {
  color: number;
  points: number[];
  pose: SavedPose;
}

const RADIUS = 0.006;
/** これ以上動いたら点を足す (m) */
const MIN_STEP = 0.008;
/** 1 本の線の点数の上限。超えたら新しい線に切り替える (点が増えるほど作り直しが重くなるため)。 */
const MAX_POINTS = 400;
const COLORS = [0xff6b6b, 0xffd166, 0x6fe09a, 0x4f8cff, 0xc58cff, 0xffffff];
/** 線どうしがこの距離より近ければ、ひとつの絵として一緒に持つ (m)。線を囲む箱どうしで比べる。 */
const LINK_MARGIN = 0.02;

const _local = new THREE.Vector3();
const _segment = new THREE.Vector3();
const _closest = new THREE.Vector3();

/**
 * 空中に線を描く。素手ではつまんだ指先、コントローラーではトリガーを引いた先端が筆になる。
 * 線は空間に残るので、歩き回って別の角度から見られる。
 *
 * 描き終えた線は、持って動かせる (Holding)。重なっている線は、ひとつの絵としてまとめて動く。
 * お絵描きの道具を選んでいる間は、つまみ / トリガーは描くことに使うので、持つには手全体で握る (グリップを握る)。
 */
export class Drawing implements Feature {
  readonly name = 'drawing';
  private readonly strokes: Stroke[] = [];
  private readonly active = new Map<HandState, Stroke>();
  private nextColor = 0;

  constructor(private readonly app: App) {
    app.tools.register({
      id: 'draw',
      label: 'お絵描き',
      hint: 'つまむ/トリガーを引いたまま動かして描く',
      overridesHold: true,
      onSelectStart: (hand) => this.begin(hand),
      onSelectEnd: (hand) => this.finish(hand),
    });
    app.onClear(() => this.clear());
    // 描き終えた線だけを保存する。点列は線の座標のまま、線の姿勢と分けて持つ。
    app.persistence.register<SavedStroke[]>('strokes', {
      save: () =>
        this.strokes
          .filter((stroke) => stroke.complete)
          .map((stroke) => ({
            color: stroke.mesh.material.color.getHex(),
            points: (stroke.savedPoints ??= stroke.points.flatMap((point) => point.toArray().map(round))),
            pose: app.persistence.poseOf(stroke.mesh),
          })),
      restore: (saved) => {
        for (const { color, points, pose } of saved) {
          if (points.length < 6) continue;
          const stroke = this.createStroke(new THREE.Vector3().fromArray(points), color);
          for (let i = 3; i < points.length; i += 3) stroke.points.push(new THREE.Vector3().fromArray(points, i));
          rebuild(stroke);
          app.persistence.place(stroke.mesh, pose);
          this.complete(stroke);
        }
      },
    });
  }

  get count(): number {
    return this.strokes.length;
  }

  end(): void {
    this.clear();
  }

  clear(): void {
    for (const stroke of this.strokes) this.dispose(stroke);
    this.strokes.length = 0;
    this.active.clear();
  }

  update(): void {
    for (const [hand, stroke] of this.active) {
      if (!hand.tracked) continue;
      const point = penPosition(hand);
      const last = stroke.points[stroke.points.length - 1];
      if (point.distanceTo(last) < MIN_STEP) continue;
      stroke.points.push(point.clone());
      rebuild(stroke);
      if (stroke.points.length >= MAX_POINTS) {
        // 続きは新しい線で描く。同じ色・同じ点から始めるので、見た目はつながる。
        const next = this.createStroke(point, stroke.mesh.material.color.getHex());
        this.active.set(hand, next);
        this.complete(stroke);
      }
    }
  }

  private begin(hand: HandState): void {
    if (!hand.tracked) return;
    const color = COLORS[this.nextColor];
    this.nextColor = (this.nextColor + 1) % COLORS.length;
    this.active.set(hand, this.createStroke(penPosition(hand), color));
  }

  private finish(hand: HandState): void {
    const stroke = this.active.get(hand);
    this.active.delete(hand);
    if (!stroke) return;
    // 動かさずに離した場合は、線にならないので捨てる。
    if (stroke.points.length < 2) {
      this.dispose(stroke);
      this.strokes.splice(this.strokes.indexOf(stroke), 1);
    } else {
      this.complete(stroke);
    }
  }

  /** 描き終えた線を、持てるようにする。 */
  private complete(stroke: Stroke): Item {
    const { mesh, points } = stroke;
    mesh.geometry.computeBoundingBox();
    stroke.complete = true;
    this.app.holding.add({
      object: mesh,
      // 持って動かしたり拡大したりしたあとは、点列 (描いたときの座標) とワールド座標がずれるので、
      // 線の座標に直して測り、長さをワールドの縮尺に戻す。
      distanceTo: (point) => {
        const local = mesh.worldToLocal(_local.copy(point));
        let nearest = Infinity;
        for (let i = 1; i < points.length; i++) {
          nearest = Math.min(nearest, distanceToSegment(local, points[i - 1], points[i]));
        }
        return (nearest - RADIUS) * mesh.scale.x;
      },
      group: () => this.linked(stroke).map((linked) => linked.mesh),
    });
    stroke.item = this.createItem(stroke);
    this.app.items.register(stroke.item);
    return stroke.item;
  }

  private createItem(stroke: Stroke): Item {
    const { mesh } = stroke;
    const item: Item = {
      kind: 'stroke',
      object: mesh,
      remove: () => {
        const index = this.strokes.indexOf(stroke);
        if (index < 0) return;
        this.dispose(stroke);
        this.strokes.splice(index, 1);
      },
      duplicate: () => {
        const copy = this.createStroke(stroke.points[0], mesh.material.color.getHex());
        for (let i = 1; i < stroke.points.length; i++) copy.points.push(stroke.points[i].clone());
        rebuild(copy);
        copy.mesh.position.copy(mesh.position);
        copy.mesh.quaternion.copy(mesh.quaternion);
        copy.mesh.scale.copy(mesh.scale);
        return this.complete(copy);
      },
      setPose: (position, quaternion) => {
        if (this.app.items.holdersOf(item).length > 0) return;
        mesh.position.copy(position);
        mesh.quaternion.copy(quaternion);
      },
      grab: (hand, button) => this.app.holding.hold(hand, mesh, button),
    };
    return item;
  }

  /** 指定した線と、重なりをたどってつながる線すべて。描いている途中の線は含めない。 */
  private linked(start: Stroke): Stroke[] {
    const boxes = new Map<Stroke, THREE.Box3>();
    for (const stroke of this.strokes) {
      const box = stroke.mesh.geometry.boundingBox;
      if (!stroke.complete || !box) continue;
      stroke.mesh.updateMatrixWorld();
      boxes.set(stroke, box.clone().applyMatrix4(stroke.mesh.matrixWorld).expandByScalar(LINK_MARGIN / 2));
    }
    const group = [start];
    for (let i = 0; i < group.length; i++) {
      const box = boxes.get(group[i]);
      if (!box) continue;
      for (const [stroke, other] of boxes) {
        if (!group.includes(stroke) && box.intersectsBox(other)) group.push(stroke);
      }
    }
    return group;
  }

  private createStroke(start: THREE.Vector3, color: number): Stroke {
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.35,
      roughness: 0.5,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.castShadow = true;
    // 線は長く伸びるので、作り直すたびに境界を計算するより、常に描画対象にする。
    mesh.frustumCulled = false;
    this.app.scene.add(mesh);
    const stroke: Stroke = { points: [start.clone()], mesh, complete: false };
    this.strokes.push(stroke);
    return stroke;
  }

  private dispose(stroke: Stroke): void {
    this.app.scene.remove(stroke.mesh);
    this.app.holding.remove(stroke.mesh);
    if (stroke.item) this.app.items.unregister(stroke.item);
    stroke.mesh.geometry.dispose();
    stroke.mesh.material.dispose();
  }
}

function penPosition(hand: HandState): THREE.Vector3 {
  return hand.isHand ? hand.grabPosition : hand.tipPosition;
}

/** 点 p から線分 ab までの距離 */
function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _segment.subVectors(b, a);
  const t = THREE.MathUtils.clamp(_closest.subVectors(p, a).dot(_segment) / Math.max(_segment.lengthSq(), 1e-8), 0, 1);
  return _closest.copy(a).addScaledVector(_segment, t).distanceTo(p);
}

/** 点列をなめらかな曲線でつなぎ、チューブ状のメッシュにする。 */
function rebuild(stroke: Stroke): void {
  stroke.mesh.geometry.dispose();
  stroke.mesh.geometry = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(stroke.points),
    stroke.points.length * 2,
    RADIUS,
    6,
    false,
  );
}
