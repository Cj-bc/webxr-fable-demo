import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { copyPosition, copyQuaternion, type HandState } from '../input';

/** レイが現実の面に当たった位置 */
export interface SurfaceHit {
  position: THREE.Vector3;
  /** 面の法線 (面から手前に向かう向き) */
  normal: THREE.Vector3;
}

interface HandHitTest {
  inputSource: XRInputSource | null;
  hitTestSource: XRHitTestSource | null;
  hit: SurfaceHit;
  hasHit: boolean;
  reticle: THREE.Mesh;
  ray: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

const _quaternion = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 手 / コントローラーのレイと現実の面の交点を求める (hit-test)。
 * 結果は照準 (リング) で表示し、配置やポータルの道具が使う。
 *
 * hit-test は「どの空間からレイを飛ばすか」を登録して XRHitTestSource を作り、
 * 毎フレーム frame.getHitTestResults() で結果を受け取る仕組み。
 */
export class HitTest implements Feature {
  readonly name = 'hit-test';
  /** hit-test が使えず、y=0 の床との交点で代用しているか */
  usingFallback = false;

  /** 照準を出す道具の id */
  private readonly toolIds = new Set<string>();
  private readonly states = new Map<HandState, HandHitTest>();
  private session: XRSession | null = null;

  constructor(private readonly app: App) {
    const reticleGeometry = new THREE.RingGeometry(0.035, 0.045, 32).rotateX(-Math.PI / 2);
    for (const hand of app.input.hands) {
      const reticle = new THREE.Mesh(
        reticleGeometry,
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false }),
      );
      reticle.renderOrder = 20;
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
      );
      ray.frustumCulled = false;
      reticle.visible = ray.visible = false;
      app.scene.add(reticle, ray);
      this.states.set(hand, {
        inputSource: null,
        hitTestSource: null,
        hit: { position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) },
        hasHit: false,
        reticle,
        ray,
      });
    }
  }

  /** この道具を選んでいる間、照準を表示する。 */
  showFor(toolId: string): void {
    this.toolIds.add(toolId);
  }

  /** この手のレイが、いま現実の面に当たっている位置。当たっていなければ null。 */
  getHit(hand: HandState): SurfaceHit | null {
    const state = this.states.get(hand);
    return state?.hasHit ? state.hit : null;
  }

  start(session: XRSession): void {
    this.session = session;
    this.usingFallback = !session.requestHitTestSource;
  }

  end(): void {
    for (const state of this.states.values()) {
      cancel(state.hitTestSource);
      state.hitTestSource = null;
      state.inputSource = null;
      state.hasHit = false;
      state.reticle.visible = state.ray.visible = false;
    }
    this.session = null;
  }

  update(ctx: FrameContext): void {
    const active = this.toolIds.has(this.app.tools.active?.id ?? '');
    for (const [hand, state] of this.states) {
      if (state.inputSource !== hand.source) this.resubscribe(hand, state);

      state.hasHit = false;
      if (active && hand.tracked) {
        if (state.hitTestSource) {
          const results = ctx.frame.getHitTestResults(state.hitTestSource);
          // 結果は近い順。姿勢の位置が交点で、Y 軸が面の法線。
          const pose = results[0]?.getPose(ctx.refSpace);
          if (pose) {
            copyPosition(state.hit.position, pose.transform.position);
            copyQuaternion(_quaternion, pose.transform.orientation);
            state.hit.normal.set(0, 1, 0).applyQuaternion(_quaternion);
            state.hasHit = true;
          }
        } else if (this.usingFallback && hand.rayDirection.y < -0.05) {
          const distance = -hand.rayOrigin.y / hand.rayDirection.y;
          if (distance > 0 && distance < 10) {
            state.hit.position.copy(hand.rayOrigin).addScaledVector(hand.rayDirection, distance);
            state.hit.normal.set(0, 1, 0);
            state.hasHit = true;
          }
        }
      }

      state.reticle.visible = state.ray.visible = state.hasHit;
      if (!state.hasHit) continue;
      state.reticle.position.copy(state.hit.position);
      state.reticle.quaternion.setFromUnitVectors(UP, state.hit.normal);
      const positions = state.ray.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, hand.rayOrigin.x, hand.rayOrigin.y, hand.rayOrigin.z);
      positions.setXYZ(1, state.hit.position.x, state.hit.position.y, state.hit.position.z);
      positions.needsUpdate = true;
    }
  }

  /** 入力ソースが入れ替わったら (素手 ⇔ コントローラー)、その targetRaySpace で登録し直す。 */
  private resubscribe(hand: HandState, state: HandHitTest): void {
    cancel(state.hitTestSource);
    state.hitTestSource = null;
    const inputSource = (state.inputSource = hand.source);
    if (!inputSource || !this.session?.requestHitTestSource) return;
    this.session
      .requestHitTestSource({ space: inputSource.targetRaySpace })
      ?.then((hitTestSource) => {
        // 登録を待つ間に入力ソースがまた入れ替わっていたら、使わずに捨てる。
        if (state.inputSource === inputSource) state.hitTestSource = hitTestSource;
        else cancel(hitTestSource);
      })
      .catch((error: unknown) => {
        // hit-test が有効化されなかった場合はここに来る。仮の床で代用する。
        this.usingFallback = true;
        console.warn('[hit-test] requestHitTestSource に失敗しました', error);
      });
  }
}

/** セッション終了後の cancel() は例外になるので、握りつぶす。 */
function cancel(hitTestSource: XRHitTestSource | null): void {
  try {
    hitTestSource?.cancel();
  } catch {
    // すでに無効になっている
  }
}
