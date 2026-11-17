import * as THREE from 'three';
import { Menu } from './features/menu';
import { Input } from './input';
import { Tools } from './tools';
import { OPTIONAL_FEATURES, REQUIRED_FEATURES } from './xrFeatures';

/** 1 フレームぶんの情報。各機能の update に渡す。 */
export interface FrameContext {
  /** 秒 */
  time: number;
  /** 前フレームからの経過秒 (上限つき) */
  dt: number;
  frame: XRFrame;
  session: XRSession;
  /** local-floor の参照空間。three.js のワールド座標と一致する。 */
  refSpace: XRReferenceSpace;
  headPosition: THREE.Vector3;
  headQuaternion: THREE.Quaternion;
}

/** デモの 1 機能。機能ごとに独立させ、1 つが失敗しても他が動き続けるようにする。 */
export interface Feature {
  readonly name: string;
  start?(session: XRSession): void | Promise<void>;
  update?(ctx: FrameContext): void;
  end?(): void;
}

export class App {
  // stencil はポータル (壁の穴) の描画で使う。XR のフレームバッファにも引き継がれる。
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
  readonly input = new Input();
  readonly tools = new Tools(this.input);
  readonly menu = new Menu(this);
  session: XRSession | null = null;
  onSessionStart: ((session: XRSession) => void) | null = null;
  onSessionEnd: (() => void) | null = null;

  private readonly features: Feature[] = [];
  private readonly failed = new Set<Feature>();
  private readonly headPosition = new THREE.Vector3();
  private readonly headQuaternion = new THREE.Quaternion();
  private lastTime = 0;

  constructor() {
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    document.body.appendChild(this.renderer.domElement);
    this.add(this.input);
    this.add(this.menu);
    window.addEventListener('resize', () => {
      if (this.renderer.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  add<T extends Feature>(feature: T): T {
    this.features.push(feature);
    return feature;
  }

  async enterXR(): Promise<void> {
    if (this.session || !navigator.xr) return;
    // immersive-ar はパススルー映像の上に描画するセッション。
    // optionalFeatures は非対応でもセッション開始に失敗せず、session.enabledFeatures で結果が分かる。
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: REQUIRED_FEATURES.map((f) => f.id),
      optionalFeatures: OPTIONAL_FEATURES.map((f) => f.id),
      // GPU テクスチャとして深度を受け取る (three.js が遮蔽に使う)。形式はブラウザ任せ。
      depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] },
    });
    await this.renderer.xr.setSession(session);
    this.session = session;
    this.lastTime = 0;
    this.failed.clear();
    session.addEventListener('end', this.handleSessionEnd);
    this.onSessionStart?.(session);

    for (const feature of this.features) {
      try {
        await feature.start?.(session);
      } catch (error) {
        this.reportFailure(feature, 'start', error);
      }
    }
    this.renderer.setAnimationLoop(this.handleFrame);
  }

  private readonly handleSessionEnd = (): void => {
    this.renderer.setAnimationLoop(null);
    for (const feature of this.features) {
      try {
        feature.end?.();
      } catch (error) {
        this.reportFailure(feature, 'end', error);
      }
    }
    this.session = null;
    this.onSessionEnd?.();
  };

  private readonly handleFrame = (timeMs: number, frame?: XRFrame): void => {
    const session = this.session;
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (!frame || !session || !refSpace) return;

    const time = timeMs / 1000;
    const dt = this.lastTime === 0 ? 1 / 72 : Math.min(time - this.lastTime, 0.05);
    this.lastTime = time;

    const viewerPose = frame.getViewerPose(refSpace);
    if (viewerPose) {
      const { position, orientation } = viewerPose.transform;
      this.headPosition.set(position.x, position.y, position.z);
      this.headQuaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    }

    const ctx: FrameContext = {
      time,
      dt,
      frame,
      session,
      refSpace,
      headPosition: this.headPosition,
      headQuaternion: this.headQuaternion,
    };
    for (const feature of this.features) {
      if (this.failed.has(feature)) continue;
      try {
        feature.update?.(ctx);
      } catch (error) {
        this.reportFailure(feature, 'update', error);
      }
    }
    this.renderer.render(this.scene, this.camera);
  };

  /** 失敗した機能は以後の update を止める。毎フレーム同じ例外を投げ続けないため。 */
  private reportFailure(feature: Feature, phase: string, error: unknown): void {
    this.failed.add(feature);
    console.error(`[${feature.name}] ${phase} に失敗したため、この機能を停止します`, error);
  }
}
