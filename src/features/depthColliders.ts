import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { GROUP_ALL, GROUP_DEPTH, GROUP_HAND, RAPIER, interactionGroups } from '../physics';
import type { Room } from './room';

/** 深度を読み出す格子の大きさ。この数だけ点を取る。 */
const COLUMNS = 32;
const ROWS = 32;
const POINT_COUNT = COLUMNS * ROWS;
/** 深度を読み出す間隔 (秒)。読み出しが終わるまでは次を始めない。 */
const INTERVAL = 0.1;
/** この範囲の距離 (m) の点だけを使う。近すぎる所と遠い所は誤差が大きい。 */
const MIN_RANGE = 0.25;
const MAX_RANGE = 4;
/** 深度を 16 bit に詰めるときの最大値 (m) */
const ENCODE_RANGE = 8;
/** 部屋の当たり判定 (床・壁・机など) からこの距離 (m) 以内の点は、もう当たり判定があるので使わない */
const ROOM_MARGIN = 0.06;
/**
 * 素手の関節の表面からこの距離 (m) 以内の点は、手そのものなので使わない。
 * 手は HandColliders が関節ごとに当たり判定を持っている。
 * 手のひらの関節の間と、深度の遅れや輪郭の揺れのぶんを見込む。広げすぎると、手を近付けた物の面まで消える。
 */
const JOINT_MARGIN = 0.04;
/** コントローラーは関節が取れないので、握りの位置からこの範囲 (m) の点を使わない。 */
const CONTROLLER_MARGIN = 0.1;
/**
 * 隣り合う 2 点の「距離の逆数」の差が、この割合以下なら、ほぼ同じ距離なので、そのまま面でつなぐ。
 * これを超える差は、斜めの面か、物の輪郭 (手前の物と奥の壁の境目) のどちらか。
 */
const SMOOTH_STEP = 0.05;
/**
 * 斜めの面と輪郭の見分け方。平らな面では、距離の逆数が格子に沿って一定の割合で変わる。
 * 前後の点との差も同じくらい (この割合までのずれ) なら、斜めに続く面とみなしてつなぐ。
 * 輪郭では、そこだけ差が跳ぶので、前後の差とは揃わない。
 */
const SLOPE_TOLERANCE = 0.5;
const DEPTH_FRICTION = 0.8;
const DEPTH_RESTITUTION = 0.4;
const DEBUG_COLOR = 0xffa040;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** 深度テクスチャの値を距離 (m) に直し、16 bit に詰めて R と G に書く。 */
const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2DArray depthTexture;
uniform float layer;
// 射影行列の z の係数。深度バッファの値を、カメラからの距離 (m) に直すのに使う。
uniform vec2 projection;
varying vec2 vUv;
void main() {
  // 隣の画素と混ぜると、物の輪郭に存在しない距離ができるので、補間せずに 1 画素だけ読む。
  ivec2 size = textureSize(depthTexture, 0).xy;
  float depth = texelFetch(depthTexture, ivec3(vUv * vec2(size), int(layer)), 0).r;
  float meters = projection.y / min(depth * 2.0 - 1.0 + projection.x, -1e-6);
  float value = floor(clamp(meters / ${ENCODE_RANGE.toFixed(1)}, 0.0, 1.0) * 65535.0 + 0.5);
  float high = floor(value / 256.0);
  gl_FragColor = vec4(high / 255.0, (value - high * 256.0) / 255.0, 0.0, 1.0);
}`;

/** 深度を読み出したときの、深度の視点。読み出しは数フレーム後に終わるので、頼んだ時点のものを覚えておく。 */
interface Snapshot {
  /** 深度の視点 → ワールド */
  world: THREE.Matrix4;
  /** クリップ空間 → 深度の視点 */
  inverseProjection: THREE.Matrix4;
  /** 手の点を除く球 (xyz が中心、w が半径)。深度と同じ時点の手の位置にする。 */
  hands: THREE.Vector4[];
  session: number;
}

const _point = new THREE.Vector3();

function onSphere(point: THREE.Vector3, sphere: THREE.Vector4): boolean {
  const dx = point.x - sphere.x;
  const dy = point.y - sphere.y;
  const dz = point.z - sphere.z;
  return dx * dx + dy * dy + dz * dz < sphere.w * sphere.w;
}
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const EMPTY_VERTICES = new Float32Array(0);
const EMPTY_INDICES = new Uint32Array(0);
/** 部屋の当たり判定だけを探す問い合わせ。手と深度の面は除く。 */
const ROOM_ONLY = interactionGroups(GROUP_ALL, GROUP_ALL & ~(GROUP_HAND | GROUP_DEPTH));

/**
 * 深度センサー (depth-sensing) の値から、現実の物の当たり判定をリアルタイムに作る。
 *
 * 部屋の当たり判定 (Room) は事前のスキャン結果なので、後から動かした椅子や、人、
 * 置いた荷物には当たらない。深度は毎フレーム届くので、それを格子状の点の集まりにして、
 * 隣り合う点を三角形で結んだ面を、当たり判定として作り直す。
 * (点ごとに球を置く方式は、球の間、特に斜めから見た床や机の上で、物がすり抜けた。)
 *
 * 深度は GPU のテクスチャでしか受け取れないので、小さなレンダーターゲットへ縮小して書き出し、
 * 非同期に CPU へ読み出す。読み出しを待つ間も描画は止まらない。
 */
export class DepthColliders implements Feature {
  readonly name = 'depthColliders';
  enabled = true;
  /** いまの当たり判定の三角形の数 */
  count = 0;

  private readonly target = new THREE.WebGLRenderTarget(COLUMNS, ROWS, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
  private readonly material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      depthTexture: { value: null as THREE.Texture | null },
      layer: { value: 0 },
      projection: { value: new THREE.Vector2(-1, -0.1) },
    },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera();
  private readonly pixels = new Uint8Array(POINT_COUNT * 4);
  /** 格子の点のワールド座標と、使える点かどうか */
  private readonly points = new Float32Array(POINT_COUNT * 3);
  private readonly valid = new Uint8Array(POINT_COUNT);
  /** 格子の点の、距離 (m) の逆数。面の続き具合を調べるのに使う。 */
  private readonly inverse = new Float32Array(POINT_COUNT);
  /** 格子の点 → 当たり判定の頂点の番号。使わない点は -1。 */
  private readonly vertexOf = new Int32Array(POINT_COUNT);
  private collider: RAPIER.Collider | null = null;
  private readonly debug: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private pending = false;
  private lastRequest = -Infinity;
  /** セッションごとに進める番号。終了後に届いた読み出し結果を捨てるのに使う。 */
  private session = 0;

  constructor(
    private readonly app: App,
    private readonly room: Room,
  ) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    const debugMaterial = new THREE.MeshBasicMaterial({
      color: DEBUG_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    // 面は現実の面にぴったり重なっているので、遮蔽すると見えなくなる。
    debugMaterial.userData.occlusion = 'ignore';
    this.debug = new THREE.Mesh(new THREE.BufferGeometry(), debugMaterial);
    this.debug.frustumCulled = false;
    app.scene.add(this.debug);

    app.menu.addToggle(
      '深度で当たる',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
  }

  start(): void {
    this.session++;
    this.pending = false;
    this.lastRequest = -Infinity;
  }

  end(): void {
    this.session++;
    this.setMesh(EMPTY_VERTICES, EMPTY_INDICES);
  }

  update(ctx: FrameContext): void {
    this.debug.visible = this.room.visible;
    if (!this.enabled) {
      if (this.count > 0) this.setMesh(EMPTY_VERTICES, EMPTY_INDICES);
      return;
    }
    if (this.pending || ctx.time - this.lastRequest < INTERVAL) return;
    const snapshot = this.render(ctx);
    if (!snapshot) return;
    this.lastRequest = ctx.time;
    this.pending = true;
    this.app.renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, COLUMNS, ROWS, this.pixels)
      .then(() => {
        if (snapshot.session === this.session && this.enabled) this.build(snapshot);
      })
      .catch((error: unknown) => console.warn('[depthColliders] 深度の読み出しに失敗しました', error))
      .finally(() => {
        if (snapshot.session === this.session) this.pending = false;
      });
  }

  /** 左目の深度を、距離 (m) にしてレンダーターゲットへ書く。 */
  private render(ctx: FrameContext): Snapshot | null {
    const xr = this.app.renderer.xr;
    const texture = xr.getDepthTexture();
    const view = ctx.frame.getViewerPose(ctx.refSpace)?.views[0];
    if (!texture || !view) return null;
    // 深度は描画の視点とは別の視点 (深度センサーの視点) で取られていることがあり、
    // そのときは深度の情報に視点の姿勢と射影が付いてくる。無ければ描画の視点と同じとみなす。
    const info = xr.getBinding().getDepthInformation(view);
    const projection = info?.projectionMatrix ?? view.projectionMatrix;
    const transform = info?.transform ?? view.transform;

    const uniforms = this.material.uniforms;
    uniforms.depthTexture.value = texture;
    uniforms.layer.value = info?.imageIndex ?? 0;
    uniforms.projection.value.set(projection[10], projection[14]);

    const renderer = this.app.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousXr = xr.enabled;
    try {
      // XR セッション中の renderer は XR のカメラで描くので、一時的に外す。
      xr.enabled = false;
      renderer.setRenderTarget(this.target);
      renderer.render(this.quadScene, this.quadCamera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      xr.enabled = previousXr;
    }

    return {
      world: new THREE.Matrix4().fromArray(transform.matrix),
      inverseProjection: new THREE.Matrix4().fromArray(projection).invert(),
      hands: this.handSpheres(ctx),
      session: this.session,
    };
  }

  /**
   * 深度に写った手を見分けるための球。素手なら関節ごと、コントローラーなら握りの位置に 1 つ。
   * (握りの位置からの距離だけで除くと、手を近付けた机や箱の面まで消えて、物がすり抜けた。)
   */
  private handSpheres(ctx: FrameContext): THREE.Vector4[] {
    const spheres: THREE.Vector4[] = [];
    for (const hand of this.app.input.hands) {
      if (!hand.tracked) continue;
      const joints = hand.source?.hand;
      if (!joints) {
        const { x, y, z } = hand.grabPosition;
        spheres.push(new THREE.Vector4(x, y, z, CONTROLLER_MARGIN));
        continue;
      }
      for (const space of joints.values()) {
        const pose = ctx.frame.getJointPose?.(space, ctx.refSpace);
        if (!pose) continue;
        const { x, y, z } = pose.transform.position;
        spheres.push(new THREE.Vector4(x, y, z, (pose.radius ?? 0.01) + JOINT_MARGIN));
      }
    }
    return spheres;
  }

  /** 読み出した距離を格子の点にし、隣り合う点を三角形で結んで、当たり判定を作り直す。 */
  private build(snapshot: Snapshot): void {
    const world = this.app.physics.world;
    const { points, valid } = this;
    for (let index = 0; index < POINT_COUNT; index++) {
      valid[index] = 0;
      const meters = ((this.pixels[index * 4] * 256 + this.pixels[index * 4 + 1]) / 65535) * ENCODE_RANGE;
      if (meters < MIN_RANGE || meters > MAX_RANGE) continue;
      this.inverse[index] = 1 / meters;

      // 格子の中心を、深度の視点の座標を経てワールド座標にする。
      const x = ((index % COLUMNS) + 0.5) / COLUMNS;
      const y = (Math.floor(index / COLUMNS) + 0.5) / ROWS;
      _point.set(x * 2 - 1, y * 2 - 1, -1).applyMatrix4(snapshot.inverseProjection);
      _point.multiplyScalar(meters / -_point.z).applyMatrix4(snapshot.world);

      if (snapshot.hands.some((sphere) => onSphere(_point, sphere))) continue;
      const nearest = world.projectPoint(_point, true, RAPIER.QueryFilterFlags.ONLY_FIXED, ROOM_ONLY);
      if (nearest && (nearest.isInside || _point.distanceTo(nearest.point) < ROOM_MARGIN)) continue;
      _point.toArray(points, index * 3);
      valid[index] = 1;
    }

    // 格子の 1 マスを 2 つの三角形にする。3 辺とも面として続いているものだけを張る。
    const triangles: number[] = [];
    for (let row = 0; row < ROWS - 1; row++) {
      for (let column = 0; column < COLUMNS - 1; column++) {
        const right = this.continuous(column, row, 1, 0);
        const up = this.continuous(column, row, 0, 1);
        const diagonal = this.continuous(column + 1, row, -1, 1);
        const top = this.continuous(column, row + 1, 1, 0);
        const side = this.continuous(column + 1, row, 0, 1);
        const i = row * COLUMNS + column;
        if (right && up && diagonal) triangles.push(i, i + 1, i + COLUMNS);
        if (side && top && diagonal) triangles.push(i + 1, i + COLUMNS + 1, i + COLUMNS);
      }
    }

    // 三角形に使われた点だけを、当たり判定の頂点として詰めて並べる。
    this.vertexOf.fill(-1);
    const vertices: number[] = [];
    const indices = new Uint32Array(triangles.length);
    triangles.forEach((index, n) => {
      if (this.vertexOf[index] < 0) {
        this.vertexOf[index] = vertices.length / 3;
        vertices.push(points[index * 3], points[index * 3 + 1], points[index * 3 + 2]);
      }
      indices[n] = this.vertexOf[index];
    });
    this.setMesh(new Float32Array(vertices), indices);
    this.wakeTouching();
  }

  /**
   * 格子の点 (column, row) と、そこから (dc, dr) 進んだ点が、同じ面の続きかどうか。
   *
   * 平らな面では、距離の逆数が格子に沿って一定の割合で変わる (透視投影の性質)。
   * なので、浅い角度で見た机や、傾いた背もたれのように距離が大きく変わる所でも、
   * 前後の点との差と揃っていれば面の続きと分かる。輪郭では、そこだけ差が跳ぶ。
   */
  private continuous(column: number, row: number, dc: number, dr: number): boolean {
    const a = this.indexAt(column, row);
    const b = this.indexAt(column + dc, row + dr);
    if (a < 0 || b < 0) return false;
    const w = this.inverse;
    const step = w[b] - w[a];
    if (Math.abs(step) <= SMOOTH_STEP * Math.max(w[a], w[b])) return true;
    const before = this.indexAt(column - dc, row - dr);
    const after = this.indexAt(column + 2 * dc, row + 2 * dr);
    return (
      (before >= 0 && Math.abs(w[a] - w[before] - step) <= SLOPE_TOLERANCE * Math.abs(step)) ||
      (after >= 0 && Math.abs(w[after] - w[b] - step) <= SLOPE_TOLERANCE * Math.abs(step))
    );
  }

  /** 格子の点の番号。格子の外か、使えない点なら -1。 */
  private indexAt(column: number, row: number): number {
    if (column < 0 || column >= COLUMNS || row < 0 || row >= ROWS) return -1;
    const index = row * COLUMNS + column;
    return this.valid[index] ? index : -1;
  }

  /** 当たり判定と表示を、この三角形の集まりに置き換える。空なら当たり判定を消す。 */
  private setMesh(vertices: Float32Array, indices: Uint32Array): void {
    const world = this.app.physics.world;
    if (this.collider) world.removeCollider(this.collider, false);
    this.collider =
      indices.length > 0
        ? world.createCollider(
            RAPIER.ColliderDesc.trimesh(vertices, indices)
              .setFriction(DEPTH_FRICTION)
              .setRestitution(DEPTH_RESTITUTION)
              .setCollisionGroups(interactionGroups(GROUP_DEPTH, GROUP_ALL & ~(GROUP_HAND | GROUP_DEPTH))),
          )
        : null;
    this.count = indices.length / 3;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.debug.geometry.dispose();
    this.debug.geometry = geometry;
  }

  /**
   * 眠っている (止まって計算を省かれている) 物は、剛体を持たない当たり判定が動いてきても起きない。
   * 現実の物が押しのけられるよう、重なった物は起こす。
   */
  private wakeTouching(): void {
    const collider = this.collider;
    if (!collider) return;
    this.app.physics.world.intersectionsWithShape(
      collider.translation(),
      IDENTITY,
      collider.shape,
      (other) => {
        const body = other.parent();
        if (body?.isSleeping()) body.wakeUp();
        return true;
      },
      RAPIER.QueryFilterFlags.ONLY_DYNAMIC,
    );
  }
}
