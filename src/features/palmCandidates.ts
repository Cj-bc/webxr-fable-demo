import { BoxHelper, Vector3 } from 'three';
import type { App, Feature, FrameContext } from '../app';
import type { HandState } from '../input';
import type { Item } from '../items';
import { fingerGapTargets } from '../interactions/fingerGapTargets';
import { TargetParticles } from '../interactions/targetParticles';
import { CanvasPanel } from '../ui/canvasPanel';
import type { PointerEvent, PointerQuery, PointerTarget } from '../ui/pointers';

const MAX_CANDIDATES = 5;
const LABELS = { ball: 'ボール', block: 'ブロック', photo: '写真', stroke: '線' };

export class PalmCandidates implements Feature, PointerTarget {
  readonly name = 'palmCandidates';
  enabled = false;
  private panel: CanvasPanel | null = null;
  private candidates: Item[] = [];
  private highlight: BoxHelper | null = null;
  private readonly effects: TargetParticles[] = [];
  private preview: Item | null = null;
  private readonly forward = new Vector3();
  selected: Item | null = null;

  constructor(private readonly app: App) {
    app.pointers.register(this);
    app.menu.addSuppressor(() => this.panel?.mesh.visible ?? false);
    app.menu.addToggle('物の候補を手元に表示', () => this.enabled, (enabled) => {
      this.enabled = enabled;
      if (!enabled) this.clear();
    });
  }

  update(ctx: FrameContext): void {
    if (!this.enabled) return;
    const hand = this.app.input.left;
    if (this.selected && !this.app.items.all.includes(this.selected)) this.selected = null;
    const aiming = hand.tracked && hand.isHand && !hand.selecting && !hand.squeezing
      && hand.fingerExtension > 0.8
      && this.forward.set(0, 0, -1).applyQuaternion(ctx.headQuaternion).dot(hand.palmNormal) > 0.55;
    const right = this.app.input.right;
    const nearPanel = right.tracked && this.panel?.mesh.visible
      && Math.abs(this.panel.project(right.tipPosition)?.distance ?? Infinity) < 0.07;
    if (aiming && !nearPanel) {
      const next = fingerGapTargets(this.app.items, ctx.headPosition, hand).slice(0, MAX_CANDIDATES);
      if (next.length !== this.candidates.length || next.some((item, i) => item !== this.candidates[i])) {
        this.candidates = next;
        if (next.length && this.panel?.mesh.visible) this.draw(this.panel);
        else if (!next.length) this.clearPanel();
      }
    }
    const remaining = this.candidates.filter((item) => this.app.items.all.includes(item)
      && this.app.items.holdersOf(item).length === 0);
    // 表示中は行を入れ替えない。対象が使えなくなったら一度閉じる。
    if (!aiming || remaining.length !== this.candidates.length) {
      this.clearPanel();
    } else if (this.candidates.length) {
      const panel = this.panel ?? this.createPanel();
      if (!panel.mesh.visible) {
        panel.mesh.visible = true;
        this.draw(panel);
      }
      panel.mesh.position.copy(hand.grabPosition).addScaledVector(this.forward, 0.035);
      panel.mesh.position.y += 0.13;
      panel.mesh.lookAt(ctx.headPosition);
      panel.mesh.updateMatrixWorld();
    }
    for (const [index, item] of this.candidates.entries()) {
      const effect = this.effects[index] ??= new TargetParticles(this.app.scene, 0xffd275);
      effect.update(item.object, ctx.time);
    }
    for (const effect of this.effects.slice(this.candidates.length)) effect.hide();
    this.showPreview(this.preview ?? this.selected);
  }

  hitTest(query: PointerQuery, hand: HandState) {
    if (query.kind !== 'poke' || hand !== this.app.input.right || !this.panel?.mesh.visible) return null;
    const point = this.panel.project(query.position);
    return point && { distance: point.distance, panelPoint: point };
  }

  onPointer(event: PointerEvent): void {
    if (event.kind === 'cancel' || event.kind === 'up') {
      this.preview = null;
      return;
    }
    const point = event.hit?.panelPoint;
    if (!point || !this.panel) return;
    const index = Math.floor(point.y / (this.panel.canvas.height / MAX_CANDIDATES));
    const item = this.candidates[index];
    this.preview = item ?? null;
    if (event.kind === 'down' && item && this.app.items.all.includes(item)) {
      this.selected = item;
      this.draw(this.panel);
      event.hand.pulse(0.35, 25);
    }
  }

  private createPanel(): CanvasPanel {
    const panel = new CanvasPanel(0.21, 0.2, 2000);
    panel.mesh.visible = false;
    this.app.scene.add(panel.mesh);
    this.panel = panel;
    return panel;
  }

  private draw(panel: CanvasPanel): void {
    const { context, canvas } = panel;
    const rowHeight = canvas.height / MAX_CANDIDATES;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = '30px sans-serif';
    context.textBaseline = 'middle';
    for (const [index, item] of this.candidates.entries()) {
      context.fillStyle = item === this.selected ? '#245b79' : '#142131';
      context.fillRect(0, index * rowHeight, canvas.width, rowHeight - 4);
      context.fillStyle = '#ffffff';
      context.fillText(`${index + 1}. ${LABELS[item.kind]}`, 16, (index + 0.5) * rowHeight);
    }
    panel.markDirty();
  }

  private showPreview(item: Item | null): void {
    if (!this.highlight && item) {
      this.highlight = new BoxHelper(item.object, 0xffd275);
      this.app.scene.add(this.highlight);
    }
    if (!this.highlight) return;
    this.highlight.visible = !!item;
    if (item) this.highlight.setFromObject(item.object);
  }

  private clearPanel(): void {
    if (this.panel) this.panel.mesh.visible = false;
    this.candidates = [];
    for (const effect of this.effects) effect.hide();
    this.preview = null;
  }

  private clear(): void {
    this.clearPanel();
    this.selected = null;
    this.showPreview(null);
  }

  end(): void {
    this.clear();
    if (this.panel) {
      this.panel.mesh.removeFromParent();
      this.panel.mesh.geometry.dispose();
      this.panel.mesh.material.dispose();
      this.panel.texture.dispose();
      this.panel = null;
    }
    this.highlight?.removeFromParent();
    this.highlight?.dispose();
    this.highlight = null;
    for (const effect of this.effects) effect.dispose();
    this.effects.length = 0;
  }
}
