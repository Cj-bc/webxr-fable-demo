import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import type { HandState } from '../input';
import { isHorizontal, orientOnSurface } from '../surface';
import type { HitTest } from './hitTest';
import type { OcclusionMode } from './occlusion';

interface PortalInstance {
  /** ステンシルに書く番号。ポータルごとに変えて、中の世界が他の穴から見えないようにする。 */
  ref: number;
  root: THREE.Group;
  /** 穴の縁・マスクなど、開くときに拡大する部分 */
  opening: THREE.Group;
  spinners: THREE.Object3D[];
  bornAt: number;
}

const TOOL_ID = 'portal';
const MAX_PORTALS = 3;
const RADIUS = 0.35;
/**
 * 穴を面から浮かせる距離 (m)。面にぴったり重ねると、深度センサーの誤差で
 * 現実の壁に隠れたり隠れなかったりして、穴が虫食いになる。
 */
const SURFACE_OFFSET = 0.05;
const OPEN_DURATION = 0.45;
const SKY_RADIUS = 40;

const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * 壁や床に、別の世界が覗ける穴を開ける。
 *
 * 描画は 3 段階 (renderOrder の順):
 *  1. マスク: 穴の円盤をステンシルにだけ書く。深度テストは行うので、手前に物があればそこは書かれない。
 *  2. 深度の穴あけ: ステンシルが立った所の深度を最遠に戻す。
 *     こうしないと、壁の向こうにある中の世界が、現実の壁の深度 (遮蔽) に負けて描かれない。
 *  3. 中の世界: ステンシルが立った所にだけ、通常どおり深度テストして描く。
 */
export class Portal implements Feature {
  readonly name = 'portal';
  /** 穴を開けたときの通知 (効果音用) */
  onOpened: ((position: THREE.Vector3) => void) | null = null;
  private readonly portals: PortalInstance[] = [];
  private time = 0;

  constructor(
    private readonly app: App,
    private readonly hitTest: HitTest,
  ) {
    hitTest.showFor(TOOL_ID);
    app.tools.register({
      id: TOOL_ID,
      label: 'ポータル',
      hint: 'レイで壁や床を指し、つまむ/トリガーで穴を開ける',
      onSelectStart: (hand) => this.open(hand),
    });
    app.onClear(() => this.clear());
  }

  get count(): number {
    return this.portals.length;
  }

  end(): void {
    this.clear();
  }

  clear(): void {
    for (const portal of this.portals) this.dispose(portal);
    this.portals.length = 0;
  }

  update(ctx: FrameContext): void {
    this.time = ctx.time;
    for (const portal of this.portals) {
      const progress = Math.min((ctx.time - portal.bornAt) / OPEN_DURATION, 1);
      // 少し行き過ぎてから戻る動きで開く。
      const eased = 1 + 2.2 * Math.pow(progress - 1, 3) + 1.2 * Math.pow(progress - 1, 2);
      portal.opening.scale.setScalar(Math.max(eased, 0.001));
      portal.spinners.forEach((spinner, i) => {
        spinner.rotation.x += ctx.dt * (0.2 + i * 0.07);
        spinner.rotation.y += ctx.dt * (0.3 + i * 0.05);
      });
    }
  }

  private open(hand: HandState): void {
    const hit = this.hitTest.getHit(hand);
    if (!hit) return;
    if (this.portals.length >= MAX_PORTALS) this.dispose(this.portals.shift()!);
    const used = new Set(this.portals.map((p) => p.ref));
    let ref = 1;
    while (used.has(ref)) ref++;

    const portal = build(ref, this.time);
    portal.root.position.copy(hit.position);
    // ローカル +Z を面の手前に向ける。壁では鉛直を保ち、中の世界が傾かないようにする。
    if (isHorizontal(hit.normal)) portal.root.quaternion.setFromUnitVectors(FORWARD, hit.normal);
    else orientOnSurface(hit.position, hit.normal, hit.position, portal.root.quaternion);
    this.app.scene.add(portal.root);
    this.portals.push(portal);
    hand.pulse(1, 80);
    this.onOpened?.(hit.position);
  }

  private dispose(portal: PortalInstance): void {
    this.app.scene.remove(portal.root);
    portal.root.traverse((object) => {
      const mesh = object as Partial<THREE.Mesh<THREE.BufferGeometry, THREE.Material & { map?: THREE.Texture | null }>>;
      mesh.geometry?.dispose();
      mesh.material?.map?.dispose();
      mesh.material?.dispose();
    });
  }
}

function build(ref: number, time: number): PortalInstance {
  const hue = Math.random();
  const root = new THREE.Group();
  const opening = new THREE.Group();
  opening.position.z = SURFACE_OFFSET;
  root.add(opening);

  const disc = new THREE.CircleGeometry(RADIUS, 48);
  const mask = new THREE.Mesh(
    disc,
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: ref,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    }),
  );
  mask.renderOrder = 1;
  // 遮蔽が「ぼかし」のときは深度バッファに現実の深度が無いので、手前に現実の物がある所は
  // マスク自身が描かないことで、穴が現実の物の上に出ないようにする。
  mask.material.userData.occlusion = 'mask' satisfies OcclusionMode;

  const depthPunch = new THREE.Mesh(
    disc,
    new THREE.ShaderMaterial({
      // z = w にすると、深度は最遠 (1.0) になる。
      vertexShader: `void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
      fragmentShader: `void main() { gl_FragColor = vec4(0.0); }`,
      colorWrite: false,
      depthFunc: THREE.AlwaysDepth,
      ...stencilEqual(ref),
    }),
  );
  depthPunch.renderOrder = 2;

  const rimColor = new THREE.Color().setHSL(hue, 0.9, 0.65);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(RADIUS, 0.012, 12, 64),
    new THREE.MeshStandardMaterial({ color: rimColor, emissive: rimColor, emissiveIntensity: 1.5 }),
  );
  opening.add(mask, depthPunch, rim);

  // 中の世界。面の向こう側 (ローカル -Z) に置く。
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture(hue), side: THREE.BackSide, ...stencilEqual(ref) }),
  );
  sky.renderOrder = 3;
  root.add(sky);

  const spinners: THREE.Object3D[] = [];
  const geometries = [
    new THREE.IcosahedronGeometry(0.35),
    new THREE.TorusKnotGeometry(0.25, 0.08, 80, 12),
    new THREE.OctahedronGeometry(0.4),
    new THREE.TorusGeometry(0.3, 0.1, 16, 40),
    new THREE.DodecahedronGeometry(0.3),
  ];
  for (let i = 0; i < 12; i++) {
    const color = new THREE.Color().setHSL((hue + 0.35 + Math.random() * 0.3) % 1, 0.7, 0.6);
    const spinner = new THREE.Mesh(
      geometries[i % geometries.length],
      new THREE.MeshStandardMaterial({ color, roughness: 0.3, flatShading: true, ...stencilEqual(ref) }),
    );
    // 奥に向かって広がるように散らす。
    const depth = 1.2 + i * 0.7;
    const angle = i * 2.4;
    spinner.position.set(Math.cos(angle) * depth * 0.45, Math.sin(angle) * depth * 0.35, -depth);
    spinner.renderOrder = 3;
    spinners.push(spinner);
    root.add(spinner);
  }
  return { ref, root, opening, spinners, bornAt: time };
}

/** ステンシルが ref の所にだけ描く設定 */
function stencilEqual(ref: number): THREE.MaterialParameters {
  return {
    // three.js では stencilWrite を true にしないと、ステンシルテスト自体が有効にならない。
    stencilWrite: true,
    stencilRef: ref,
    stencilFunc: THREE.EqualStencilFunc,
    // 中の世界は現実の壁より奥にあるので、現実の深度では隠さない (穴の形はマスクが決める)。
    userData: { occlusion: 'ignore' satisfies OcclusionMode },
  };
}

function skyTexture(hue: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const g = canvas.getContext('2d')!;
  const degrees = Math.floor(hue * 360);
  const gradient = g.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `hsl(${degrees}, 70%, 8%)`);
  gradient.addColorStop(0.5, `hsl(${(degrees + 30) % 360}, 75%, 35%)`);
  gradient.addColorStop(0.62, `hsl(${(degrees + 70) % 360}, 90%, 70%)`);
  gradient.addColorStop(1, `hsl(${(degrees + 200) % 360}, 50%, 15%)`);
  g.fillStyle = gradient;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 400; i++) {
    g.globalAlpha = 0.3 + Math.random() * 0.7;
    g.fillRect(Math.random() * canvas.width, Math.random() * canvas.height * 0.5, 2, 2);
  }
  g.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
