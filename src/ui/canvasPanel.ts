import * as THREE from 'three';

export interface PanelPoint {
  /** キャンバス上の位置 (px) */
  x: number;
  y: number;
  /** パネル表面からの距離 (m)。表側が正。レイの場合はレイ上の距離。 */
  distance: number;
}

const _local = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

/** メニューはテクスチャが透明な部分を除き、指先などと同じ深度バッファを使う。 */
export function useMenuDepth(material: THREE.MeshBasicMaterial): void {
  material.alphaTest = 1 / 255;
  material.userData.occlusion = 'ignore';
}

/**
 * 2D キャンバスをテクスチャにした板。immersive セッションでは DOM を表示できないので、
 * 空間内の UI はこうして自前で描く。
 */
export class CanvasPanel {
  readonly canvas = document.createElement('canvas');
  readonly context: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly pixelsPerMeter: number,
  ) {
    this.canvas.width = Math.round(width * pixelsPerMeter);
    this.canvas.height = Math.round(height * pixelsPerMeter);
    this.context = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
  }

  /** キャンバスを描き直したあとに呼ぶ。 */
  markDirty(): void {
    this.texture.needsUpdate = true;
  }

  /** ワールド座標の点をキャンバス座標に直す。パネルの外なら null。 */
  project(world: THREE.Vector3): PanelPoint | null {
    _local.copy(world);
    this.mesh.worldToLocal(_local);
    return this.toPanelPoint(_local.x, _local.y, _local.z);
  }

  /** レイとパネルの交点をキャンバス座標で返す。当たらなければ null。 */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3): PanelPoint | null {
    _inverse.copy(this.mesh.matrixWorld).invert();
    _local.copy(origin).applyMatrix4(_inverse);
    _direction.copy(direction).transformDirection(_inverse);
    // 表側 (+Z) から裏へ向かうレイだけを受ける。
    if (_direction.z >= -1e-4 || _local.z <= 0) return null;
    const distance = -_local.z / _direction.z;
    return this.toPanelPoint(_local.x + _direction.x * distance, _local.y + _direction.y * distance, distance);
  }

  private toPanelPoint(x: number, y: number, distance: number): PanelPoint | null {
    if (Math.abs(x) > this.width / 2 || Math.abs(y) > this.height / 2) return null;
    return {
      x: (x + this.width / 2) * this.pixelsPerMeter,
      y: (this.height / 2 - y) * this.pixelsPerMeter,
      distance,
    };
  }
}
