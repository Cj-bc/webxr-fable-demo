import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { CanvasPanel } from '../ui/canvasPanel';
import { ALL_FEATURES } from '../xrFeatures';

const WIDTH = 0.64;
const PIXELS_PER_METER = 1250;
const ROW_HEIGHT = 58;
const HEADER_HEIGHT = 84;
const FOOTER_HEIGHT = 56;
/** 末尾の注記 (空間の保存の状況など、長くなりうる文) の高さ。パネルの幅いっぱいに 2 行まで出す。 */
const NOTE_HEIGHT = 60;
const REDRAW_INTERVAL = 0.5;
/** パネルを出す位置の、頭からの距離 (m) */
const DISTANCE = 1.1;

const _forward = new THREE.Vector3();

/**
 * 各 WebXR 機能が有効になったかと、いま何が取れているかを空間内に表示する。
 * optionalFeatures で要求した機能が実際に使えるかは、session.enabledFeatures で分かる。
 */
export class StatusPanel implements Feature {
  readonly name = 'status';
  visible = true;

  private readonly panel: CanvasPanel;
  /** 機能 id → 現在の状況を 1 行で返す関数 */
  private readonly details = new Map<string, () => string>();
  private footer: () => string = () => '';
  private note: () => string = () => '';
  private enabledFeatures: readonly string[] | undefined;
  private needsPlacement = true;
  private lastDraw = -Infinity;
  private frames = 0;
  private fps = 0;

  constructor(app: App) {
    const height =
      (HEADER_HEIGHT + ALL_FEATURES.length * ROW_HEIGHT + FOOTER_HEIGHT + NOTE_HEIGHT) / PIXELS_PER_METER;
    this.panel = new CanvasPanel(WIDTH, height, PIXELS_PER_METER);
    this.panel.mesh.visible = false;
    app.scene.add(this.panel.mesh);
    app.menu.addToggle(
      '状態パネル',
      () => this.visible,
      (value) => {
        this.visible = value;
        // 出し直したときは、いま向いている方に置く。
        this.needsPlacement = value;
      },
    );
  }

  setDetail(featureId: string, detail: () => string): void {
    this.details.set(featureId, detail);
  }

  setFooter(footer: () => string): void {
    this.footer = footer;
  }

  setNote(note: () => string): void {
    this.note = note;
  }

  start(session: XRSession): void {
    this.enabledFeatures = session.enabledFeatures;
    this.needsPlacement = true;
    this.lastDraw = -Infinity;
  }

  end(): void {
    this.panel.mesh.visible = false;
  }

  update(ctx: FrameContext): void {
    const mesh = this.panel.mesh;
    mesh.visible = this.visible;
    this.frames++;
    if (!this.visible) return;

    if (this.needsPlacement) {
      this.needsPlacement = false;
      _forward.set(0, 0, -1).applyQuaternion(ctx.headQuaternion).setY(0).normalize();
      mesh.position.copy(ctx.headPosition).addScaledVector(_forward, DISTANCE);
      mesh.lookAt(ctx.headPosition);
    }
    const elapsed = ctx.time - this.lastDraw;
    if (elapsed < REDRAW_INTERVAL) return;
    this.fps = Number.isFinite(elapsed) ? this.frames / elapsed : 0;
    this.frames = 0;
    this.lastDraw = ctx.time;
    this.draw();
  }

  private draw(): void {
    const g = this.panel.context;
    const { width, height } = this.panel.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = 'rgba(16, 20, 28, 0.85)';
    g.beginPath();
    g.roundRect(0, 0, width, height, 24);
    g.fill();

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = 'bold 30px system-ui, sans-serif';
    g.fillText('WebXR 機能の状態', 24, HEADER_HEIGHT / 2);
    g.textAlign = 'right';
    g.fillStyle = '#a9b4c8';
    g.font = '22px system-ui, sans-serif';
    g.fillText(`${this.fps.toFixed(0)} fps`, width - 24, HEADER_HEIGHT / 2);

    ALL_FEATURES.forEach((feature, i) => {
      const y = HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2;
      const enabled = this.enabledFeatures?.includes(feature.id);
      g.textAlign = 'left';
      g.font = 'bold 24px system-ui, sans-serif';
      g.fillStyle = enabled === undefined ? '#a9b4c8' : enabled ? '#6fe09a' : '#ff7b7b';
      g.fillText(enabled === undefined ? '不明' : enabled ? '有効' : '非対応', 24, y);
      g.fillStyle = '#ffffff';
      g.fillText(feature.label, 120, y - 12);
      g.fillStyle = '#8a94a8';
      g.font = '18px ui-monospace, monospace';
      g.fillText(feature.id, 120, y + 14);
      g.fillStyle = '#e8ecf4';
      drawWrapped(g, this.details.get(feature.id)?.() ?? '', 380, y, width - 380 - 24);
    });

    g.fillStyle = '#a9b4c8';
    g.font = '22px system-ui, sans-serif';
    g.fillText(this.footer(), 24, height - NOTE_HEIGHT - FOOTER_HEIGHT / 2, width - 48);
    g.fillStyle = '#e8ecf4';
    drawWrapped(g, this.note(), 24, height - NOTE_HEIGHT / 2 - 6, width - 48);
    this.panel.markDirty();
  }
}

/**
 * 1 行に収まらない文は、文字を小さくして 2 行に折り返す。それでも収まらない分だけ横に詰める。
 * 失敗の理由などの長い文が、潰れて読めなくならないようにする。
 */
function drawWrapped(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): void {
  g.font = '22px system-ui, sans-serif';
  if (g.measureText(text).width <= maxWidth) {
    g.fillText(text, x, y);
    return;
  }
  g.font = '18px system-ui, sans-serif';
  // 日本語は単語の区切りがないので、1 文字ずつ足して収まる所で切る。
  let split = 1;
  while (split < text.length && g.measureText(text.slice(0, split + 1)).width <= maxWidth) split++;
  g.fillText(text.slice(0, split), x, y - 11);
  g.fillText(text.slice(split), x, y + 11, maxWidth);
}
