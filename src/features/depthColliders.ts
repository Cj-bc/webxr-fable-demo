import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { GROUP_ALL, GROUP_DEPTH, GROUP_HAND, RAPIER, interactionGroups } from '../physics';
import type { Room } from './room';

/** 深度を読み出す格子の大きさ。この数だけ点を取る。 */
const COLUMNS = 24;
const ROWS = 24;
const MAX_COLLIDERS = COLUMNS * ROWS;
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
/** 球の半径は、隣の点との間隔のこの割合。隙間なく並ぶよう、半分より少し大きくする。 */
const RADIUS_RATIO = 0.6;
const MIN_RADIUS = 0.015;
const MAX_RADIUS = 0.06;
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
  /** 横方向の射影の係数。点の間隔を求めるのに使う。 */
  scaleX: number;
  eye: THREE.Vector3;
  session: number;
}

const _point = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
/** 部屋の当たり判定だけを探す問い合わせ。手と深度の球は除く。 */
const ROOM_ONLY = interactionGroups(GROUP_ALL, GROUP_ALL & ~(GROUP_HAND | GROUP_DEPTH));

/**
 * 深度センサー (depth-sensing) の値から、現実の物の当たり判定をリアルタイムに作る。
 *
 * 部屋の当たり判定 (Room) は事前のスキャン結果なので、後から動かした椅子や、人、
 * 置いた荷物には当たらない。深度は毎フレーム届くので、それを点の集まりにして、
 * 点ごとに小さな球の当たり判定を置き直す。
 *
 * 深度は GPU のテクスチャでしか受け取れないので、小さなレンダーターゲットへ縮小して書き出し、
 * 非同期に CPU へ読み出す。読み出しを待つ間も描画は止まらない。
 */
export class DepthColliders implements Feature {
  readonly name = 'depthColliders';
  enabled = true;
  /** いま置いている当たり判定の数 */
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
  private readonly pixels = new Uint8Array(COLUMNS * ROWS * 4);
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly debug: THREE.InstancedMesh;
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
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    // 球は現実の面に半分埋まっているので、遮蔽すると見えなくなる。
    debugMaterial.userData.occlusion = 'ignore';
    this.debug = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), debugMaterial, MAX_COLLIDERS);
    this.debug.count = 0;
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
    const world = this.app.physics.world;
    for (let i = 0; i < MAX_COLLIDERS; i++) {
      this.colliders.push(
        world.createCollider(
          RAPIER.ColliderDesc.ball(MIN_RADIUS)
            .setEnabled(false)
            .setFriction(DEPTH_FRICTION)
            .setRestitution(DEPTH_RESTITUTION)
            .setCollisionGroups(interactionGroups(GROUP_DEPTH, GROUP_ALL & ~(GROUP_HAND | GROUP_DEPTH))),
        ),
      );
    }
  }

  end(): void {
    this.session++;
    const world = this.app.physics.world;
    for (const collider of this.colliders) world.removeCollider(collider, false);
    this.colliders.length = 0;
    this.count = 0;
    this.debug.count = 0;
  }

  update(ctx: FrameContext): void {
    this.debug.visible = this.room.visible;
    if (!this.enabled) {
      if (this.count > 0) this.apply(0);
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
      scaleX: projection[0],
      eye: new THREE.Vector3().setFromMatrixPosition(world),
      session: this.session,
    };
  }

  /** 読み出した距離を点にして、当たり判定の球を置き直す。 */
  private build(snapshot: Snapshot): void {
    const world = this.app.physics.world;
    const hands = this.app.input.hands.filter((hand) => hand.tracked);
    let used = 0;
    for (let index = 0; index < MAX_COLLIDERS; index++) {
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

      // 球の手前の面が、測った面に来るように、視線の奥へ半径ぶんずらす。
      const spacing = (2 * meters) / (snapshot.scaleX * COLUMNS);
      const radius = THREE.MathUtils.clamp(spacing * RADIUS_RATIO, MIN_RADIUS, MAX_RADIUS);
      _ray.copy(_point).sub(snapshot.eye).normalize();
      _point.addScaledVector(_ray, radius);

      const collider = this.colliders[used];
      collider.setRadius(radius);
      collider.setTranslation(_point);
      collider.setEnabled(true);
      this.debug.setMatrixAt(used, _matrix.makeScale(radius, radius, radius).setPosition(_point));
      used++;
    }
    this.apply(used);
    this.wakeTouching();
  }

  /** 先頭の used 個だけを有効にする。 */
  private apply(used: number): void {
    for (let i = used; i < this.count; i++) this.colliders[i].setEnabled(false);
    this.count = used;
    this.debug.count = used;
    this.debug.instanceMatrix.needsUpdate = true;
  }

  /**
   * 眠っている (止まって計算を省かれている) 物は、剛体を持たない当たり判定が動いてきても起きない。
   * 現実の物が押しのけられるよう、重なった物は起こす。
   */
  private wakeTouching(): void {
    const world = this.app.physics.world;
    for (let i = 0; i < this.count; i++) {
      const collider = this.colliders[i];
      world.intersectionsWithShape(
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
}
