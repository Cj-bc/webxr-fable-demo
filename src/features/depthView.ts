import * as THREE from 'three';
import type { App, Feature } from '../app';

/** 色を一巡させる距離 (m)。これより遠い所は、いちばん遠い色のまま。 */
const COLOR_RANGE = 5;

const VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2DArray depthTexture;
uniform vec2 depthSize;
// 射影行列の z の係数。深度バッファの値を、カメラからの距離 (m) に直すのに使う。
uniform vec2 projection;

// 近い所を赤、遠い所を青にする色の並び (Turbo の多項式近似)。
vec3 turbo(float t) {
  const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kr2 = vec2(-152.94239396, 59.28637943);
  const vec2 kg2 = vec2(4.27729857, 2.82956604);
  const vec2 kb2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, t, t * t, t * t * t);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}

void main() {
  // 左右の目の映像は横に並んでいて、深度テクスチャは目ごとに層が分かれている。
  vec2 coord = gl_FragCoord.xy / depthSize;
  float layer = step(1.0, coord.x);
  float depth = texture(depthTexture, vec3(coord.x - layer, coord.y, layer)).r;
  // 後から描く仮想物体が、深度テストですべて隠れるよう、いちばん手前の深度を書く。
  gl_FragDepth = 0.0;
  // 値が届いていない所 (いちばん奥のまま) は黒にする。
  if (depth >= 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float meters = projection.y / min(depth * 2.0 - 1.0 + projection.x, -1e-6);
  vec3 color = turbo(clamp(1.0 - meters / ${COLOR_RANGE.toFixed(1)}, 0.0, 1.0));
  // 1 m ごとに暗い線を引いて、距離を読めるようにする。
  float edge = abs(fract(meters + 0.5) - 0.5) / max(fwidth(meters), 1e-4);
  color *= 1.0 - 0.6 * (1.0 - clamp(edge / 1.5, 0.0, 1.0));
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

/**
 * 深度センサー (depth-sensing) の値だけを、色分けして画面全体に表示する。
 * 近い所ほど赤く、遠い所ほど青い。遮蔽や深度の当たり判定が、何を元にしているかを確かめるためのもの。
 *
 * パススルー映像と仮想物体は、この表示で覆い隠す。深度テストをしないもの (メニュー、照準) は
 * その上に描かれるので、表示中もメニューで元に戻せる。
 */
export class DepthView implements Feature {
  readonly name = 'depthView';
  enabled = false;

  private readonly material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      depthTexture: { value: null as THREE.Texture | null },
      depthSize: { value: new THREE.Vector2(1, 1) },
      projection: { value: new THREE.Vector2(-1, -0.1) },
    },
    depthTest: false,
    depthWrite: true,
    blending: THREE.NoBlending,
  });
  private readonly mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);

  constructor(private readonly app: App) {
    this.mesh.frustumCulled = false;
    // 不透明な物の中で最初に描き、深度バッファを手前で埋めてから他を描かせる。
    this.mesh.renderOrder = -1e9;
    this.mesh.visible = false;
    app.scene.add(this.mesh);
    app.menu.addToggle(
      '深度だけ表示',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
  }

  update(): void {
    const xr = this.app.renderer.xr;
    // 深度データが一度も届いていない間は null。
    const texture = xr.getDepthTexture();
    const eye = xr.getCamera().cameras[0];
    this.mesh.visible = this.enabled && texture !== null && eye !== undefined;
    if (!this.mesh.visible || !eye) return;
    // 深度テクスチャは描画と同じ near / far で作られている (three.js がカメラ側を合わせる)。
    const uniforms = this.material.uniforms;
    uniforms.depthTexture.value = texture;
    uniforms.depthSize.value.set(eye.viewport.z, eye.viewport.w);
    uniforms.projection.value.set(eye.projectionMatrix.elements[10], eye.projectionMatrix.elements[14]);
  }

  end(): void {
    this.mesh.visible = false;
    this.material.uniforms.depthTexture.value = null;
  }
}
