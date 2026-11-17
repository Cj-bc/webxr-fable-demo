import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';

const DEFAULT_DIRECTION = new THREE.Vector3(0.3, 1, 0.2).normalize();
const DEFAULT_SUN_INTENSITY = 2.2;
/** 影を計算する範囲の半径 (m)。頭の真下を中心に追従させる。 */
const SHADOW_RANGE = 3;
const SUN_DISTANCE = 6;

/**
 * 仮想物体の照明と影。
 *
 * light-estimation が使える端末では、現実の主光源の向き・強さと環境光 (球面調和関数) を
 * 毎フレーム受け取って照明に反映する。使えない端末 (Quest 3 のブラウザは現状こちら) では、
 * 上からの固定の光で照らす。
 */
export class Lighting implements Feature {
  readonly name = 'lighting';
  shadows = true;
  /** 光源推定の値が届いているか */
  estimating = false;

  private readonly ambient = new THREE.HemisphereLight(0xffffff, 0x9aa4b8, 1.6);
  private readonly sun = new THREE.DirectionalLight(0xffffff, DEFAULT_SUN_INTENSITY);
  /** 光源推定の環境光を入れる。推定値が届くまでは使わない。 */
  private readonly probe = new THREE.LightProbe();
  private readonly direction = DEFAULT_DIRECTION.clone();
  private lightProbe: XRLightProbe | null = null;
  private session: XRSession | null = null;

  constructor(app: App) {
    app.renderer.shadowMap.enabled = true;
    app.renderer.shadowMap.type = THREE.PCFShadowMap;

    const shadow = this.sun.shadow;
    shadow.mapSize.set(1024, 1024);
    shadow.camera.left = shadow.camera.bottom = -SHADOW_RANGE;
    shadow.camera.right = shadow.camera.top = SHADOW_RANGE;
    shadow.camera.near = 0.5;
    shadow.camera.far = SUN_DISTANCE * 2;
    shadow.bias = -0.001;
    shadow.normalBias = 0.01;

    this.probe.visible = false;
    app.scene.add(this.ambient, this.sun, this.sun.target, this.probe);
    app.menu.addToggle(
      '影',
      () => this.shadows,
      (value) => (this.shadows = value),
    );
  }

  start(session: XRSession): void {
    this.session = session;
    // 待たずに始める。非対応の端末では拒否されるだけで、他に影響はない。
    session
      .requestLightProbe?.()
      .then((lightProbe) => {
        if (this.session === session) this.lightProbe = lightProbe;
      })
      .catch(() => {
        // light-estimation が有効化されなかった
      });
  }

  end(): void {
    this.session = null;
    this.lightProbe = null;
    this.setEstimating(false);
  }

  update(ctx: FrameContext): void {
    const estimate = this.lightProbe ? ctx.frame.getLightEstimate?.(this.lightProbe) : null;
    this.setEstimating(Boolean(estimate));
    if (estimate) {
      // primaryLightDirection は「光源のある方向」。
      const { x, y, z } = estimate.primaryLightDirection;
      this.direction.set(x, y, z).normalize();
      const { x: r, y: g, z: b } = estimate.primaryLightIntensity;
      const intensity = Math.max(r, g, b, 1e-3);
      this.sun.color.setRGB(r / intensity, g / intensity, b / intensity);
      this.sun.intensity = intensity;
      this.probe.sh.fromArray(estimate.sphericalHarmonicsCoefficients);
    }

    this.sun.castShadow = this.shadows;
    this.sun.target.position.set(ctx.headPosition.x, 0, ctx.headPosition.z);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.direction, SUN_DISTANCE);
  }

  private setEstimating(estimating: boolean): void {
    if (this.estimating === estimating) return;
    this.estimating = estimating;
    this.probe.visible = estimating;
    this.ambient.visible = !estimating;
    if (!estimating) {
      this.direction.copy(DEFAULT_DIRECTION);
      this.sun.color.set(0xffffff);
      this.sun.intensity = DEFAULT_SUN_INTENSITY;
    }
  }
}
