import * as THREE from 'three';
import type { App, Feature } from '../app';

/** 仮想物体を照らす照明。 */
export class Lighting implements Feature {
  readonly name = 'lighting';
  readonly ambient = new THREE.HemisphereLight(0xffffff, 0x9aa4b8, 1.6);
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);

  constructor(app: App) {
    this.sun.position.set(1.5, 4, 1);
    app.scene.add(this.ambient, this.sun, this.sun.target);
  }
}
