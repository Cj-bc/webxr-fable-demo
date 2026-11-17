import * as THREE from 'three';
import type { App, Feature } from '../app';
import type { HandState } from '../input';

interface Stroke {
  points: THREE.Vector3[];
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
}

const RADIUS = 0.006;
/** これ以上動いたら点を足す (m) */
const MIN_STEP = 0.008;
/** 1 本の線の点数の上限。超えたら新しい線に切り替える (点が増えるほど作り直しが重くなるため)。 */
const MAX_POINTS = 400;
const COLORS = [0xff6b6b, 0xffd166, 0x6fe09a, 0x4f8cff, 0xc58cff, 0xffffff];

/**
 * 空中に線を描く。素手ではつまんだ指先、コントローラーではトリガーを引いた先端が筆になる。
 * 線は空間に残るので、歩き回って別の角度から見られる。
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
      onSelectStart: (hand) => this.begin(hand),
      onSelectEnd: (hand) => this.finish(hand),
    });
    app.onClear(() => this.clear());
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
    // 動かさずに離した場合は、線にならないので捨てる。
    if (stroke && stroke.points.length < 2) {
      this.dispose(stroke);
      this.strokes.splice(this.strokes.indexOf(stroke), 1);
    }
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
    const stroke: Stroke = { points: [start.clone()], mesh };
    this.strokes.push(stroke);
    return stroke;
  }

  private dispose(stroke: Stroke): void {
    this.app.scene.remove(stroke.mesh);
    stroke.mesh.geometry.dispose();
    stroke.mesh.material.dispose();
  }
}

function penPosition(hand: HandState): THREE.Vector3 {
  return hand.isHand ? hand.grabPosition : hand.tipPosition;
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
