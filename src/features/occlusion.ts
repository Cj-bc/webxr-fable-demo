import type { App, Feature } from '../app';

/**
 * 現実の物や自分の手で、仮想物体を隠す (depth-sensing)。
 *
 * 深度の取得と遮蔽そのものは three.js がやってくれる。セッションに depth-sensing を
 * 要求しておくと、WebXRManager が毎フレーム深度テクスチャを受け取り、他の物より先に
 * 「現実の深度を深度バッファに書くだけのメッシュ」を描く。以降の仮想物体は、現実の
 * 面より奥にある画素が深度テストで落ちる。ここではそのメッシュの表示を切り替えるだけ。
 */
export class Occlusion implements Feature {
  readonly name = 'occlusion';
  enabled = true;
  /** 深度データが届いているか */
  active = false;

  constructor(private readonly app: App) {
    app.menu.addToggle(
      '遮蔽',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
  }

  update(): void {
    // 深度データが一度も届いていない間は null。
    const mesh = this.app.renderer.xr.getDepthSensingMesh();
    this.active = mesh !== null;
    if (mesh) mesh.visible = this.enabled;
  }

  end(): void {
    this.active = false;
  }
}
