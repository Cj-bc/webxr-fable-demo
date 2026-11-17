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
/** 「くっきり」方式で周囲の深度も見るときの、中心からの距離 (画面のピクセル数) */
const TAP_RADIUS = 4;
/**
 * 「ぼかし」方式で深度を調べる範囲の半径 (画面のピクセル数)。
 * 広いほど深度の揺れが平均されてチラつきが減るが、輪郭のぼけも広がる。
 */
const SOFT_RADIUS = 12;
/**
 * 「ぼかし」方式で、仮想物体が現実の面のどれだけ奥にあれば完全に隠れるか。
 * 距離 d (m) で SOFT_FADE_ABSOLUTE + d * SOFT_FADE_RELATIVE (m)。この間は徐々に薄くなる。
 */
const SOFT_FADE_ABSOLUTE = 0.04;
const SOFT_FADE_RELATIVE = 0.04;

/** マテリアルごとの遮蔽の扱い。material.userData.occlusion で指定する。 */
export type OcclusionMode =
  /** 現実の物に隠れる (既定) */
  | 'soft'
  /** 隠れない。ポータルの中の世界など、現実の面より奥に描きたいもの。 */
  | 'ignore'
  /** 隠れる所を描かない。半透明にできない、ステンシルへの書き込み用。 */
  | 'mask';

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

/** 「ぼかし」方式で、各マテリアルのフラグメントシェーダーの先頭に足す宣言 */
const SOFT_DECLARATIONS = /* glsl */ `
uniform sampler2DArray xrDepthTexture;
uniform vec2 xrDepthSize;
uniform vec2 xrProjection;
uniform float xrOcclusionStrength;

float xrMeters(float depth) {
  return xrProjection.y / min(depth * 2.0 - 1.0 + xrProjection.x, -1e-6);
}

// この画素の位置で、仮想物体が現実の面より手前にあれば 1、十分に奥なら 0。
float xrTap(vec2 pixel, float fragmentMeters, float fade) {
  vec2 coord = pixel / xrDepthSize;
  float layer = step(1.0, coord.x);
  float depth = texture(xrDepthTexture, vec3(coord.x - layer, coord.y, layer)).r;
  float realMeters = xrMeters(depth) * (1.0 + ${RELATIVE_BIAS.toFixed(4)}) + ${ABSOLUTE_BIAS.toFixed(4)};
  return clamp((realMeters - fragmentMeters) / fade + 1.0, 0.0, 1.0);
}

// 周囲の複数の点で前後を判定し、その平均を「見えている割合」とする。
// 深度そのものを平均すると、輪郭で手前と奥の中間という存在しない距離ができてしまうので、
// 判定の結果のほうを平均する。
float xrOcclusionVisibility() {
  if (xrOcclusionStrength < 0.5) return 1.0;
  float fragmentMeters = xrMeters(gl_FragCoord.z);
  float fade = ${SOFT_FADE_ABSOLUTE.toFixed(4)} + ${SOFT_FADE_RELATIVE.toFixed(4)} * fragmentMeters;
  vec2 pixel = gl_FragCoord.xy;
  const float r = ${SOFT_RADIUS.toFixed(1)};
  const float d = r * 0.7071;
  float sum = xrTap(pixel, fragmentMeters, fade) * 2.0;
  sum += xrTap(pixel + vec2(r, 0.0), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(-r, 0.0), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(0.0, r), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(0.0, -r), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(d, d), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(-d, d), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(d, -d), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(-d, -d), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(r * 0.5, 0.0), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(-r * 0.5, 0.0), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(0.0, r * 0.5), fragmentMeters, fade);
  sum += xrTap(pixel + vec2(0.0, -r * 0.5), fragmentMeters, fade);
  return sum / 14.0;
}
`;

/** main() の最後に足す処理 */
const SOFT_APPLY: Record<Exclude<OcclusionMode, 'ignore'>, string> = {
  // パススルー映像との合成は、フレームバッファのアルファ (乗算済み) で行われる。
  // 不透明なマテリアルはブレンドしないので、色とアルファの両方を下げて現実を透かす。
  // 半透明なマテリアルは、アルファを下げればブレンドの結果として薄くなる。
  soft: /* glsl */ `
  float xrVisible = xrOcclusionVisibility();
  if (xrVisible < 0.004) discard;
  #ifdef OPAQUE
    gl_FragColor *= xrVisible;
  #else
    gl_FragColor.a *= xrVisible;
  #endif
`,
  mask: /* glsl */ `
  if (xrOcclusionVisibility() < 0.5) discard;
`,
};

/** 全マテリアルで共有する uniform。値を書き換えると、すべてのマテリアルに反映される。 */
const softUniforms = {
  xrDepthTexture: { value: null as THREE.Texture | null },
  xrDepthSize: { value: new THREE.Vector2(1, 1) },
  xrProjection: { value: new THREE.Vector2(-1, -0.1) },
  xrOcclusionStrength: { value: 0 },
};

function occlusionMode(material: THREE.Material): OcclusionMode {
  const flags = material as THREE.Material & {
    isShaderMaterial?: boolean;
    isMeshDepthMaterial?: boolean;
    isMeshDistanceMaterial?: boolean;
  };
  // 自前のシェーダーと、影の計算用のマテリアルには手を入れない。
  if (flags.isShaderMaterial || flags.isMeshDepthMaterial || flags.isMeshDistanceMaterial) return 'ignore';
  // 深度テストをしないもの (メニュー、照準、ラベル) は、常に見せたいものなので隠さない。
  if (!material.depthTest) return 'ignore';
  return (material.userData.occlusion as OcclusionMode | undefined) ?? 'soft';
}

/**
 * 遮蔽なしで描く。XR の画面以外 (写真用のレンダーターゲットなど) へ描くときに使う。
 * 「ぼかし」方式は XR の画面の画素位置から深度を引くので、別の視点の描画には使えない。
 */
export function withoutOcclusion(render: () => void): void {
  const strength = softUniforms.xrOcclusionStrength.value;
  softUniforms.xrOcclusionStrength.value = 0;
  try {
    render();
  } finally {
    softUniforms.xrOcclusionStrength.value = strength;
  }
}

let installed = false;

/**
 * 「ぼかし」方式の遮蔽を、three.js の標準マテリアルすべてに組み込む。
 *
 * 画素ごとに薄くするには、各マテリアルのフラグメントシェーダーで現実の深度と比べる必要がある。
 * マテリアルを作る場所ごとに設定して回る代わりに、Material の既定のフック (onBeforeCompile) を
 * 差し替えて、シェーダーのコンパイル時に一括で処理を足している。
 */
function installSoftOcclusion(): void {
  if (installed) return;
  installed = true;
  // 同じ種類のマテリアルでも、遮蔽の扱いが違えば別のシェーダーになるようにする。
  THREE.Material.prototype.customProgramCacheKey = function (this: THREE.Material): string {
    return `xr-occlusion:${occlusionMode(this)}`;
  };
  THREE.Material.prototype.onBeforeCompile = function (this: THREE.Material, shader): void {
    const mode = occlusionMode(this);
    if (mode === 'ignore') return;
    const end = shader.fragmentShader.lastIndexOf('}');
    if (end < 0) return;
    Object.assign(shader.uniforms, softUniforms);
    shader.fragmentShader =
      SOFT_DECLARATIONS + shader.fragmentShader.slice(0, end) + SOFT_APPLY[mode] + shader.fragmentShader.slice(end);
  };
}

/**
 * 現実の物や自分の手で、仮想物体を隠す (depth-sensing)。方式が 2 つある。
 *
 * くっきり: 現実の深度を、仮想物体より先に深度バッファへ書いておく。three.js 標準の仕組みで、
 *   WebXRManager が毎フレーム深度テクスチャを受け取り、それを書くだけのメッシュを最初に描く。
 *   以降の仮想物体は、現実の面より奥にある画素が深度テストで落ちる。
 *   ここではそのメッシュのシェーダーを、センサーの誤差のぶん奥へずらして書くものに差し替えている。
 *   画素ごとに「見える / 見えない」の二択なので、深度が揺れる所ではチラつく。
 *
 * ぼかし: 深度バッファには書かず、各マテリアルのシェーダーの中で現実の深度と比べ、
 *   周囲の判定の平均に応じて薄くする。輪郭がなめらかになり、深度の揺れは濃淡の揺れに和らぐ。
 *   そのぶん、仮想物体を描く画素ごとに深度を何度も読むので重い。
 */
export class Occlusion implements Feature {
  readonly name = 'occlusion';
  enabled = true;
  /** true なら「ぼかし」、false なら「くっきり」 */
  soft = true;
  /** 深度データが届いているか */
  active = false;

  private patched: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;

  constructor(private readonly app: App) {
    installSoftOcclusion();
    app.menu.addToggle(
      '遮蔽',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
    app.menu.addToggle(
      '遮蔽をぼかす',
      () => this.soft,
      (value) => (this.soft = value),
    );
  }

  update(): void {
    const xr = this.app.renderer.xr;
    // 深度データが一度も届いていない間は null。
    const mesh = xr.getDepthSensingMesh();
    const texture = xr.getDepthTexture();
    this.active = mesh !== null && texture !== null;
    softUniforms.xrDepthTexture.value = texture;
    softUniforms.xrOcclusionStrength.value = this.active && this.enabled && this.soft ? 1 : 0;
    if (!mesh) return;
    mesh.visible = this.enabled && !this.soft;
    if (mesh !== this.patched) this.patch(mesh);

    // 深度テクスチャは描画と同じ near / far で作られている (three.js がカメラ側を合わせる)。
    // 両目で共通なので、片目の射影行列から係数を取ればよい。
    const eye = xr.getCamera().cameras[0];
    if (!eye || !this.material) return;
    const a = eye.projectionMatrix.elements[10];
    const b = eye.projectionMatrix.elements[14];
    this.material.uniforms.projectionA.value = a;
    this.material.uniforms.projectionB.value = b;
    softUniforms.xrProjection.value.set(a, b);
    softUniforms.xrDepthSize.value.set(eye.viewport.z, eye.viewport.w);
  }

  end(): void {
    this.active = false;
    this.patched = null;
    this.material?.dispose();
    this.material = null;
    softUniforms.xrDepthTexture.value = null;
    softUniforms.xrOcclusionStrength.value = 0;
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
