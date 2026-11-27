import * as THREE from 'three';
import type { Feature, FrameContext } from '../app';
import type { HandState } from '../input';
import type { ISelector } from '../selector';
import type { SelectInputHandler } from '../tools';
import { CanvasPanel } from '../ui/canvasPanel';

const OPEN_EXTENSION = 0.85;
const PALM_UP_SHOW = Math.cos(THREE.MathUtils.degToRad(50));
const PALM_UP_HIDE = Math.cos(THREE.MathUtils.degToRad(65));
const CONTACT_MARGIN = 0.004;
const RELEASE_MARGIN = 0.01;

export class FingerSelector<T extends { label: string }> implements Feature, SelectInputHandler {
  readonly name = 'finger-selector';
  onSelect: ((position: THREE.Vector3) => void) | null = null;

  private enabled = false;
  private source: XRInputSource | null = null;
  private slots: readonly T[] = [];
  private consumed = false;
  private readonly labels: CanvasPanel[] = [];
  private readonly center = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly hand: HandState,
    private readonly selection: ISelector<T>,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.end();
  }

  end(): void {
    this.source = null;
    this.consumed = false;
    this.hide();
  }

  interceptSelect(hand: HandState): boolean {
    // XR の人差し指ピンチが接触判定の前後どちらに届いても、後続の処理には回さない。
    return hand === this.hand && hand.tracked && hand.source === this.source &&
      (this.slots.length > 0 || this.consumed);
  }

  update(ctx: FrameContext): void {
    const hand = this.hand;
    if (!this.enabled || !hand.tracked || !hand.fingertipsTracked) {
      this.end();
      return;
    }
    if (hand.source !== this.source) this.end();
    this.source = hand.source;

    let nearest = -1;
    let nearestGap = CONTACT_MARGIN;
    let released = true;
    for (const [i, tip] of hand.fingertips.entries()) {
      const gap = hand.thumbTip.position.distanceTo(tip.position) -
        (hand.thumbTip.radius || 0.008) - (tip.radius || 0.008);
      if (gap <= CONTACT_MARGIN + RELEASE_MARGIN) released = false;
      if (this.slots[i] && gap < nearestGap) {
        nearest = i;
        nearestGap = gap;
      }
    }

    if (released && !hand.selecting) this.consumed = false;
    const palmThreshold = this.slots.length > 0 ? PALM_UP_HIDE : PALM_UP_SHOW;
    if (hand.squeezing || hand.palmNormal.y < palmThreshold) {
      this.hide();
      return;
    }
    if (this.slots.length === 0) {
      if (this.consumed || hand.selecting || !released ||
          !hand.fingertips.every((tip) => tip.extension >= OPEN_EXTENSION)) return;
      // 手を開き直すまで割り当てを固定する。現在の選択を除き、指先の数だけ候補を並べる。
      this.slots = this.selection.list
        .filter((item) => item !== this.selection.active)
        .slice(0, hand.fingertips.length);
      this.slots.forEach((item, i) => this.drawLabel(i, item.label));
    }

    if (nearest >= 0) {
      const item = this.slots[nearest];
      this.consumed = true;
      this.hide();
      this.selection.setActive(item);
      this.onSelect?.(hand.fingertips[nearest].position);
      return;
    }

    this.center.addVectors(hand.fingertips[0].position, hand.fingertips[hand.fingertips.length - 1].position)
      .multiplyScalar(0.5);
    this.slots.forEach((_, i) => {
      const mesh = this.labels[i].mesh;
      // 隣のラベルと重なりにくいよう、指先の並びを少し広げる。
      mesh.position.copy(hand.fingertips[i].position).lerp(this.center, -0.6)
        .addScaledVector(hand.palmNormal, 0.025);
      mesh.lookAt(ctx.headPosition);
    });
  }

  private hide(): void {
    this.slots = [];
    for (const label of this.labels) label.mesh.visible = false;
  }

  private drawLabel(index: number, text: string): void {
    let label = this.labels[index];
    if (!label) {
      label = new CanvasPanel(0.04, 0.018, 4000);
      label.mesh.renderOrder = 101;
      label.mesh.material.depthTest = false;
      label.mesh.material.depthWrite = false;
      this.scene.add(label.mesh);
      this.labels[index] = label;
    }
    const { context, canvas } = label;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#2a3142';
    context.beginPath();
    context.roundRect(0, 0, canvas.width, canvas.height, 16);
    context.fill();
    context.fillStyle = '#fff';
    context.font = 'bold 28px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 16);
    label.markDirty();
    label.mesh.visible = true;
  }
}
