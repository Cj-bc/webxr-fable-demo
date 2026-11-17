import * as THREE from 'three';
import type { App, Feature } from '../app';

const IDLE_COLOR = 0xffffff;
const ACTIVE_COLOR = 0x4f8cff;

/** つかむ位置に小さな球を出す。入力が取れているか、つまみが認識されたかが見て分かる。 */
export class Cursors implements Feature {
  readonly name = 'cursors';
  private readonly cursors: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];

  constructor(private readonly app: App) {
    const geometry = new THREE.SphereGeometry(0.006, 12, 8);
    for (let i = 0; i < app.input.hands.length; i++) {
      const cursor = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: IDLE_COLOR }));
      cursor.visible = false;
      app.scene.add(cursor);
      this.cursors.push(cursor);
    }
  }

  update(): void {
    this.app.input.hands.forEach((hand, i) => {
      const cursor = this.cursors[i];
      cursor.visible = hand.tracked;
      cursor.position.copy(hand.grabPosition);
      cursor.material.color.setHex(hand.selecting || hand.squeezing ? ACTIVE_COLOR : IDLE_COLOR);
    });
  }

  end(): void {
    for (const cursor of this.cursors) cursor.visible = false;
  }
}
