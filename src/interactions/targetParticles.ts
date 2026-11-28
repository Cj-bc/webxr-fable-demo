import * as THREE from 'three';

const COUNT = 24;

export class TargetParticles {
  private readonly positions = new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.PointsMaterial;
  private readonly points: THREE.Points;
  private readonly texture: THREE.CanvasTexture;
  private readonly bounds = new THREE.Box3();
  private readonly center = new THREE.Vector3();
  private readonly size = new THREE.Vector3();

  constructor(scene: THREE.Scene, color: number) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d')!;
    const glow = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    glow.addColorStop(0, 'white');
    glow.addColorStop(0.25, 'rgba(255,255,255,0.8)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 32, 32);
    this.texture = new THREE.CanvasTexture(canvas);
    this.material = new THREE.PointsMaterial({
      color, map: this.texture, size: 0.025, transparent: true, opacity: 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.geometry.setAttribute('position', this.positions);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(object: THREE.Object3D, time: number, hand?: THREE.Vector3): void {
    this.points.visible = true;
    this.bounds.setFromObject(object).getCenter(this.center);
    this.bounds.getSize(this.size).multiplyScalar(0.65).addScalar(0.025);
    for (let i = 0; i < COUNT; i++) {
      const progress = hand ? (i / COUNT + time * 0.65) % 1 : 0;
      const angle = i * 2.39996 + time * 2.2;
      const drift = hand ? (1 - progress) * 0.7 : 1;
      const x = this.center.x + Math.cos(angle) * this.size.x * drift;
      const y = this.center.y + Math.sin(angle * 1.7) * this.size.y * drift;
      const z = this.center.z + Math.sin(angle) * this.size.z * drift;
      this.positions.setXYZ(i,
        hand ? x + (hand.x - x) * progress : x,
        hand ? y + (hand.y - y) * progress : y,
        hand ? z + (hand.z - z) * progress : z);
    }
    this.positions.needsUpdate = true;
  }

  hide(): void {
    this.points.visible = false;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
