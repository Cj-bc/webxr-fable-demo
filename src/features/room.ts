import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { copyPosition, copyQuaternion } from '../input';
import { RAPIER } from '../physics';

/** 検出された平面 / メッシュ 1 つぶんの表示と当たり判定 */
interface Built {
  root: THREE.Group;
  debug: THREE.Group;
  colliderDesc: RAPIER.ColliderDesc | null;
  label: string;
  offset: THREE.Vector3;
}

interface Surface {
  root: THREE.Group;
  /** 輪郭・ラベルなど、「部屋の形」の表示を切ると消える部分 */
  debug: THREE.Group;
  collider: RAPIER.Collider | null;
  /** コライダーの中心の、平面ローカル座標でのずれ */
  colliderOffset: THREE.Vector3;
  lastChangedTime: number;
  label: string;
}

/** Quest が返す semanticLabel の日本語名 */
const LABEL_NAMES: Record<string, string> = {
  floor: '床',
  ceiling: '天井',
  wall: '壁',
  'wall face': '壁',
  table: '机',
  desk: '机',
  couch: 'ソファ',
  bed: 'ベッド',
  door: 'ドア',
  'door frame': 'ドア',
  window: '窓',
  'window frame': '窓',
  screen: '画面',
  storage: '収納',
  shelf: '棚',
  lamp: '照明',
  plant: '植物',
  'wall art': '壁の絵',
  'global mesh': '部屋全体のメッシュ',
  other: 'その他',
};

const LABEL_COLORS: Record<string, number> = {
  床: 0x4f8cff,
  壁: 0x6fe09a,
  天井: 0x9aa4b8,
  机: 0xffb86b,
};
const DEFAULT_COLOR = 0xc58cff;
const MESH_COLOR = 0x5ad1e6;

/** 平面の当たり判定の厚みの半分 (m)。薄すぎると速い球がすり抜ける。 */
const PLANE_HALF_THICKNESS = 0.02;
const SURFACE_FRICTION = 0.8;
const SURFACE_RESTITUTION = 0.5;
/** 影を受ける面を、現実の面から浮かせる距離 (m)。重ねると深度センサーの誤差で影が欠ける。 */
const SHADOW_LIFT = 0.01;
const SHADOW_OPACITY = 0.3;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _offset = new THREE.Vector3();

/**
 * 平面検出 (plane-detection) とメッシュ検出 (mesh-detection) の結果を、
 * 見える形 (輪郭・ワイヤーフレーム・ラベル) と物理の当たり判定にする。
 *
 * Quest では、どちらも事前の「スペースのセットアップ」で作られた部屋のデータが返る。
 * 未設定だと何も返らないので、メニューの「部屋をスキャン」からセットアップを呼び出せる。
 */
export class Room implements Feature {
  readonly name = 'room';
  visible = true;

  private readonly planes = new Map<XRPlane, Surface>();
  private readonly meshes = new Map<XRMesh, Surface>();
  private readonly group = new THREE.Group();
  /** 部屋のデータが無いときに使う、y=0 の仮の床 */
  private fallbackFloor: RAPIER.Collider | null = null;
  /** 床が検出されていないときに影を受ける、y=0 の面 */
  private readonly fallbackShadow = makeShadowReceiver(new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2));
  private session: XRSession | null = null;

  constructor(private readonly app: App) {
    this.fallbackShadow.visible = false;
    this.fallbackShadow.position.y = SHADOW_LIFT;
    app.scene.add(this.group, this.fallbackShadow);
    app.menu.addToggle(
      '部屋の形',
      () => this.visible,
      (value) => (this.visible = value),
    );
    app.menu.addAction('部屋をスキャン', () => {
      // Quest のスペースセットアップを開く。1 セッションにつき 1 回しか呼べない。
      this.session?.initiateRoomCapture?.().catch((error: unknown) => {
        console.warn('[room] initiateRoomCapture に失敗しました', error);
      });
    });
  }

  get planeCount(): number {
    return this.planes.size;
  }

  get meshCount(): number {
    return this.meshes.size;
  }

  /** 床として検出された平面があるか */
  get hasFloor(): boolean {
    for (const surface of this.planes.values()) if (surface.label === '床') return true;
    return false;
  }

  start(session: XRSession): void {
    this.session = session;
    this.fallbackFloor = this.app.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(30, 0.1, 30)
        .setTranslation(0, -0.1, 0)
        .setFriction(SURFACE_FRICTION)
        .setRestitution(SURFACE_RESTITUTION),
    );
  }

  end(): void {
    for (const surface of this.planes.values()) this.dispose(surface);
    for (const surface of this.meshes.values()) this.dispose(surface);
    this.planes.clear();
    this.meshes.clear();
    if (this.fallbackFloor) this.app.physics.world.removeCollider(this.fallbackFloor, false);
    this.fallbackFloor = null;
    this.fallbackShadow.visible = false;
    this.session = null;
  }

  update(ctx: FrameContext): void {
    // detectedPlanes / detectedMeshes は「いま見えている集合」。
    // 消えたものは集合から外れ、形が変わったものは lastChangedTime が進む。
    this.sync(ctx, ctx.frame.detectedPlanes, this.planes, (plane) => plane.planeSpace, buildPlane);
    this.sync(ctx, ctx.frame.detectedMeshes, this.meshes, (mesh) => mesh.meshSpace, buildMesh);
    this.fallbackFloor?.setEnabled(this.planes.size === 0 && this.meshes.size === 0);
    this.fallbackShadow.visible = !this.hasFloor;
  }

  private sync<T extends { lastChangedTime: number }>(
    ctx: FrameContext,
    detected: ReadonlySet<T> | undefined,
    surfaces: Map<T, Surface>,
    getSpace: (item: T) => XRSpace,
    build: (item: T) => Built,
  ): void {
    if (!detected) return;
    for (const [item, surface] of surfaces) {
      if (detected.has(item)) continue;
      this.dispose(surface);
      surfaces.delete(item);
    }
    detected.forEach((item) => {
      let surface = surfaces.get(item);
      if (!surface || surface.lastChangedTime !== item.lastChangedTime) {
        if (surface) this.dispose(surface);
        const built = build(item);
        surface = {
          root: built.root,
          debug: built.debug,
          collider: built.colliderDesc ? this.app.physics.world.createCollider(built.colliderDesc) : null,
          colliderOffset: built.offset,
          lastChangedTime: item.lastChangedTime,
          label: built.label,
        };
        this.group.add(surface.root);
        surfaces.set(item, surface);
      }
      surface.debug.visible = this.visible;
      // 形はそれぞれの空間 (planeSpace / meshSpace) のローカル座標で与えられる。
      // 空間の姿勢は毎フレーム変わりうるので、そのつど取り直す。
      const pose = ctx.frame.getPose(getSpace(item), ctx.refSpace);
      if (!pose) return;
      copyPosition(_position, pose.transform.position);
      copyQuaternion(_quaternion, pose.transform.orientation);
      if (surface.root.position.equals(_position) && surface.root.quaternion.equals(_quaternion)) return;
      surface.root.position.copy(_position);
      surface.root.quaternion.copy(_quaternion);
      if (surface.collider) {
        _offset.copy(surface.colliderOffset).applyQuaternion(_quaternion).add(_position);
        surface.collider.setTranslation(_offset);
        surface.collider.setRotation(_quaternion);
      }
    });
  }

  private dispose(surface: Surface): void {
    this.group.remove(surface.root);
    surface.root.traverse((object) => {
      const mesh = object as Partial<THREE.Mesh<THREE.BufferGeometry, THREE.Material>> & Partial<THREE.Sprite>;
      mesh.geometry?.dispose();
      const material = mesh.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
      material?.map?.dispose();
      material?.dispose();
    });
    if (surface.collider) this.app.physics.world.removeCollider(surface.collider, false);
  }
}

function describe(semanticLabel: string | undefined, fallback: string): { name: string; text: string } {
  if (!semanticLabel) return { name: fallback, text: fallback };
  const name = LABEL_NAMES[semanticLabel];
  return name ? { name, text: `${name} (${semanticLabel})` } : { name: semanticLabel, text: semanticLabel };
}

function buildPlane(plane: XRPlane): Built {
  // polygon は平面ローカルの XZ 平面上の輪郭 (y は 0)。法線は +Y。
  const points = plane.polygon.map((p) => new THREE.Vector2(p.x, p.z));
  if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();

  const { name, text } = describe(plane.semanticLabel, plane.orientation === 'vertical' ? '垂直面' : '水平面');
  const color = LABEL_COLORS[name] ?? DEFAULT_COLOR;
  const root = new THREE.Group();
  const debug = new THREE.Group();
  root.add(debug);
  const min = new THREE.Vector2(Infinity, Infinity);
  const max = new THREE.Vector2(-Infinity, -Infinity);
  const positions = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 2] = p.y;
    min.min(p);
    max.max(p);
  });
  if (points.length < 3) return { root, debug, colliderDesc: null, label: name, offset: new THREE.Vector3() };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(THREE.ShapeUtils.triangulateShape(points, []).flat());
  debug.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    ),
    new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color })),
  );

  const center = new THREE.Vector3((min.x + max.x) / 2, 0, (min.y + max.y) / 2);
  const label = makeLabel(text, color);
  label.position.copy(center).setY(0.04);
  debug.add(label);

  // 現実の面に仮想物体の影を落とすための、影だけが見える面。
  const receiver = makeShadowReceiver(geometry);
  receiver.position.y = SHADOW_LIFT;
  root.add(receiver);

  // 当たり判定は輪郭を囲む薄い箱にする。Quest の平面はほぼ長方形なので、これで足りる。
  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    Math.max((max.x - min.x) / 2, 0.01),
    PLANE_HALF_THICKNESS,
    Math.max((max.y - min.y) / 2, 0.01),
  )
    .setFriction(SURFACE_FRICTION)
    .setRestitution(SURFACE_RESTITUTION);
  return { root, debug, colliderDesc, label: name, offset: center };
}

function buildMesh(mesh: XRMesh): Built {
  const { name } = describe(mesh.semanticLabel, 'メッシュ');
  const root = new THREE.Group();
  const debug = new THREE.Group();
  root.add(debug);
  const offset = new THREE.Vector3();
  if (mesh.indices.length < 3) return { root, debug, colliderDesc: null, label: name, offset };

  // vertices / indices はそのまま三角形メッシュ。コピーして持つ (元の配列は次の更新で変わりうる)。
  const vertices = new Float32Array(mesh.vertices);
  const indices = new Uint32Array(mesh.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  debug.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: MESH_COLOR, wireframe: true, transparent: true, opacity: 0.3 }),
    ),
  );
  const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices)
    .setFriction(SURFACE_FRICTION)
    .setRestitution(SURFACE_RESTITUTION);
  return { root, debug, colliderDesc, label: name, offset };
}

/** ShadowMaterial は影の部分だけを半透明の黒で描く。パススルー映像の上に影だけが乗る。 */
function makeShadowReceiver(geometry: THREE.BufferGeometry): THREE.Mesh {
  const receiver = new THREE.Mesh(
    geometry,
    new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY, side: THREE.DoubleSide, depthWrite: false }),
  );
  receiver.receiveShadow = true;
  return receiver;
}

function makeLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(16, 20, 28, 0.8)';
  g.beginPath();
  g.roundRect(0, 0, canvas.width, canvas.height, 24);
  g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 2, canvas.width - 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  sprite.scale.set(0.32, 0.06, 1);
  sprite.renderOrder = 10;
  return sprite;
}
