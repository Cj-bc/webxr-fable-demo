import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { GROUP_ALL, GROUP_DEPTH, GROUP_HAND, RAPIER, interactionGroups } from '../physics';
import type { Room } from './room';

/** 深度を読み出す格子の大きさ。この数だけ点を取る。 */
const COLUMNS = 24;
const ROWS = 24;
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
/** 手のこの範囲 (m) の点は使わない。手は HandColliders が関節ごとに当たり判定を持っている。 */
const HAND_MARGIN = 0.15;
/**
 * 三角形の面が視線とほぼ平行 (法線と視線の向きの cos がこれ未満) なら、面ではなく物の輪郭とみなして張らない。
 * 手前の物と奥の壁を結ぶ三角形は、視線に沿って奥へ伸びるので、ここで落とせる。
 */
const MIN_FACING = 0.15;
/** これより長い辺を持つ三角形は張らない (m)。輪郭の判定から漏れた、手前と奥を結ぶ三角形を落とす。 */
const MAX_EDGE = 0.4;
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
  eye: THREE.Vector3;
  session: number;
}

const _point = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _ray = new THREE.Vector3();
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

    const world = new THREE.Matrix4().fromArray(transform.matrix);
    return {
      world,
      inverseProjection: new THREE.Matrix4().fromArray(projection).invert(),
      eye: new THREE.Vector3().setFromMatrixPosition(world),
      session: this.session,
    };
  }

  /** 読み出した距離を格子の点にし、隣り合う点を三角形で結んで、当たり判定を作り直す。 */
  private build(snapshot: Snapshot): void {
    const world = this.app.physics.world;
    const hands = this.app.input.hands.filter((hand) => hand.tracked);
    const { points, valid } = this;
    for (let index = 0; index < POINT_COUNT; index++) {
      valid[index] = 0;
      const meters = ((this.pixels[index * 4] * 256 + this.pixels[index * 4 + 1]) / 65535) * ENCODE_RANGE;
      if (meters < MIN_RANGE || meters > MAX_RANGE) continue;

      // 格子の中心を、深度の視点の座標を経てワールド座標にする。
      const x = ((index % COLUMNS) + 0.5) / COLUMNS;
      const y = (Math.floor(index / COLUMNS) + 0.5) / ROWS;
      _point.set(x * 2 - 1, y * 2 - 1, -1).applyMatrix4(snapshot.inverseProjection);
      _point.multiplyScalar(meters / -_point.z).applyMatrix4(snapshot.world);

      if (hands.some((hand) => hand.grabPosition.distanceTo(_point) < HAND_MARGIN)) continue;
      const nearest = world.projectPoint(_point, true, RAPIER.QueryFilterFlags.ONLY_FIXED, ROOM_ONLY);
      if (nearest && (nearest.isInside || _point.distanceTo(nearest.point) < ROOM_MARGIN)) continue;
      _point.toArray(points, index * 3);
      valid[index] = 1;
    }

    // 格子の 1 マスを 2 つの三角形にする。使える点だけで、面として妥当なものだけを張る。
    const triangles: number[] = [];
    for (let row = 0; row < ROWS - 1; row++) {
      for (let column = 0; column < COLUMNS - 1; column++) {
        const i = row * COLUMNS + column;
        this.addTriangle(triangles, snapshot.eye, i, i + 1, i + COLUMNS);
        this.addTriangle(triangles, snapshot.eye, i + 1, i + COLUMNS + 1, i + COLUMNS);
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

  private addTriangle(triangles: number[], eye: THREE.Vector3, i: number, j: number, k: number): void {
    if (!this.valid[i] || !this.valid[j] || !this.valid[k]) return;
    _a.fromArray(this.points, i * 3);
    _b.fromArray(this.points, j * 3);
    _c.fromArray(this.points, k * 3);
    if (_a.distanceTo(_b) > MAX_EDGE || _b.distanceTo(_c) > MAX_EDGE || _c.distanceTo(_a) > MAX_EDGE) return;
    _normal.crossVectors(_ab.subVectors(_b, _a), _ac.subVectors(_c, _a));
    const area = _normal.length();
    if (area < 1e-8) return;
    _ray.addVectors(_a, _b).add(_c).divideScalar(3).sub(eye).normalize();
    if (Math.abs(_normal.dot(_ray)) / area < MIN_FACING) return;
    triangles.push(i, j, k);
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
