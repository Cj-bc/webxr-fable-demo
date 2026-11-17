import * as THREE from 'three';
import type { App, Feature } from '../app';

/**
 * 現実の面を、実際より奥にあるものとして扱う量。距離 d (m) の面を d * (1 + RELATIVE) + ABSOLUTE に置く。
 * 深度センサーの値は毎フレーム揺れ、遠いほど誤差が大きい。そのままだと、床や壁に接している
 * 仮想物体が現実の面と前後を取り合ってチラつくので、この分だけ仮想物体を優先する。
 * 大きくするほどチラつきは減るが、現実の物のすぐ後ろにある仮想物体が隠れなくなる。
 */
const ABSOLUTE_BIAS = 0.02;
const RELATIVE_BIAS = 0.03;
/** 周囲の深度も見るときの、中心からの距離 (画面のピクセル数) */
const TAP_RADIUS = 4;

const VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position, 1.0);
}`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;
// 射影行列の z の係数。深度バッファの値と、カメラからの距離 (m) を相互に変換するのに使う。
uniform float projectionA;
uniform float projectionB;

float sampleDepth(vec2 pixel) {
  vec2 coord = pixel / vec2(depthWidth, depthHeight);
  // 左右の目の映像は横に並んでいて、深度テクスチャは目ごとに層が分かれている。
  float layer = step(1.0, coord.x);
  return texture(depthColor, vec3(coord.x - layer, coord.y, layer)).r;
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  // 周囲も調べて、いちばん奥の値を使う。現実の物の輪郭では深度が手前と奥を行き来するので、
  // 奥側に寄せておくと、輪郭のチラつきが「仮想物体が少しはみ出て見える」程度で済む。
  float depth = sampleDepth(pixel);
  depth = max(depth, sampleDepth(pixel + vec2(TAP_RADIUS, TAP_RADIUS)));
  depth = max(depth, sampleDepth(pixel + vec2(-TAP_RADIUS, TAP_RADIUS)));
  depth = max(depth, sampleDepth(pixel + vec2(TAP_RADIUS, -TAP_RADIUS)));
  depth = max(depth, sampleDepth(pixel + vec2(-TAP_RADIUS, -TAP_RADIUS)));

  // 深度バッファの値 → 距離 (m) → 奥へずらす → 深度バッファの値
  float meters = projectionB / min(depth * 2.0 - 1.0 + projectionA, -1e-6);
  meters = meters * (1.0 + RELATIVE_BIAS) + ABSOLUTE_BIAS;
  gl_FragDepth = clamp((projectionB / meters - projectionA) * 0.5 + 0.5, 0.0, 1.0);
}`;

/**
 * 現実の物や自分の手で、仮想物体を隠す (depth-sensing)。
 *
 * セッションに depth-sensing を要求しておくと、three.js の WebXRManager が毎フレーム
 * 深度テクスチャを受け取り、他の物より先に「現実の深度を深度バッファに書くだけのメッシュ」を描く。
 * 以降の仮想物体は、現実の面より奥にある画素が深度テストで落ちる。
 *
 * three.js 標準のシェーダーは深度をそのまま書くので、センサーの誤差がそのままチラつきになる。
 * ここではそのメッシュのシェーダーを、誤差のぶん奥へずらして書くものに差し替えている。
 */
export class Occlusion implements Feature {
  readonly name = 'occlusion';
  enabled = true;
  /** 深度データが届いているか */
  active = false;

  private patched: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;

  constructor(private readonly app: App) {
    app.menu.addToggle(
      '遮蔽',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
  }

  update(): void {
    const xr = this.app.renderer.xr;
    // 深度データが一度も届いていない間は null。
    const mesh = xr.getDepthSensingMesh();
    this.active = mesh !== null;
    if (!mesh) return;
    mesh.visible = this.enabled;
    if (mesh !== this.patched) this.patch(mesh);

    // 深度テクスチャは描画と同じ near / far で作られている (three.js がカメラ側を合わせる)。
    // 両目で共通なので、片目の射影行列から係数を取ればよい。
    const eye = xr.getCamera().cameras[0];
    if (eye && this.material) {
      this.material.uniforms.projectionA.value = eye.projectionMatrix.elements[10];
      this.material.uniforms.projectionB.value = eye.projectionMatrix.elements[14];
    }
  }

  end(): void {
    this.active = false;
    this.patched = null;
    this.material?.dispose();
    this.material = null;
  }

  /** three.js が作ったメッシュのマテリアルを差し替える。テクスチャなどの値は元のものを引き継ぐ。 */
  private patch(mesh: THREE.Mesh): void {
    const original = mesh.material as THREE.ShaderMaterial;
    this.material?.dispose();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      defines: {
        ABSOLUTE_BIAS: ABSOLUTE_BIAS.toFixed(4),
        RELATIVE_BIAS: RELATIVE_BIAS.toFixed(4),
        TAP_RADIUS: TAP_RADIUS.toFixed(1),
      },
      uniforms: {
        depthColor: original.uniforms.depthColor,
        depthWidth: original.uniforms.depthWidth,
        depthHeight: original.uniforms.depthHeight,
        projectionA: { value: -1 },
        projectionB: { value: -0.1 },
      },
    });
    mesh.material = this.material;
    original.dispose();
    this.patched = mesh;
  }
}
