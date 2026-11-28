import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import type { HandState } from '../input';
import type { ISelector } from '../selector';
import type { Tool } from '../tools';
import type { PointerEvent, PointerQuery, PointerTarget } from '../ui/pointers';
import { CanvasPanel } from '../ui/canvasPanel';

type Group = 'tool' | 'toggle' | 'action' | 'experiment';

interface MenuItem {
  group: Group;
  label: string;
  isActive(): boolean;
  press(): void;
  x: number;
  y: number;
  width: number;
  height: number;
  flashUntil: number;
}

const PANEL_WIDTH = 0.26;
const PIXELS_PER_METER = 2500;
const COLUMNS = 3;
const MARGIN = 12;
const HEADER_HEIGHT = 96;
const SECTION_HEIGHT = 40;
const BUTTON_HEIGHT = 88;
const GROUP_TITLES: Record<Group, string> = { tool: '道具', toggle: '表示', action: '操作', experiment: '持った物の操作 (試作)' };
const GROUPS: Group[] = ['tool', 'toggle', 'action', 'experiment'];

/** 左手からメニューまでの高さ (m) */
const HAND_OFFSET = 0.13;
/**
 * 左手のひらの向きの上向き成分が SHOW を超えたらメニューを出し、HIDE を下回ったら隠す。
 * 境目で点滅しないよう、出す条件と隠す条件に差をつけている。
 */
const PALM_UP_SHOW = Math.cos(THREE.MathUtils.degToRad(50));
const PALM_UP_HIDE = Math.cos(THREE.MathUtils.degToRad(65));
const _forward = new THREE.Vector3();

/**
 * 左手の上に浮かぶメニュー。左手のひらを上に向けている間だけ現れる。
 * 反対の手の指先で直接押すか、レイを当ててつまむ / トリガーで押す。
 * 左手が見つからないときは、最後にあった場所 (最初は正面) に留まる。
 */
export class Menu implements Feature, PointerTarget {
  readonly name = 'menu';
  /** ボタンが押されたときの通知 (効果音など) */
  onPress: ((position: THREE.Vector3) => void) | null = null;

  private readonly items: MenuItem[] = [];
  private panel: CanvasPanel | null = null;
  /** ボタンの構成が変わったので、パネルを作り直す必要がある */
  private layoutDirty = true;
  /** 見た目が変わったので、描き直す必要がある */
  private dirty = true;
  private toolCount = 0;
  private time = 0;
  private placedInFront = false;
  private palmUp = false;
  private readonly suppressors: (() => boolean)[] = [];

  constructor(
    private readonly app: App,
    private readonly selection: ISelector<Tool>,
  ) {
    selection.onChange(() => {
      // 道具の選択が変わっただけなら、描き直すだけでよい。
      if (selection.list.length !== this.toolCount) this.syncTools();
      this.dirty = true;
    });
    this.syncTools();
  }

  addToggle(
    label: string,
    get: () => boolean,
    set: (value: boolean) => void,
    group: 'toggle' | 'experiment' = 'toggle',
  ): void {
    this.addItem(group, label, get, () => set(!get()));
  }

  addAction(label: string, run: () => void): void {
    this.addItem('action', label, () => false, run);
  }

  /** 1 つでも true を返すものがあれば、左手のひらを上にしてもメニューを出さない (別の UI がその手を使うとき)。 */
  addSuppressor(suppressor: () => boolean): void {
    this.suppressors.push(suppressor);
  }

  start(): void {
    this.placedInFront = false;
    this.palmUp = false;
    this.layoutDirty = true;
  }

  end(): void {
    if (this.panel) this.panel.mesh.visible = false;
  }

  update(ctx: FrameContext): void {
    if (this.layoutDirty) this.rebuild();
    const panel = this.panel;
    if (!panel) return;
    this.time = ctx.time;
    this.updatePlacement(panel, ctx);
    if (this.items.some((item) => item.flashUntil > 0 && item.flashUntil <= ctx.time)) {
      for (const item of this.items) if (item.flashUntil <= ctx.time) item.flashUntil = 0;
      this.dirty = true;
    }
    if (this.dirty) this.draw(panel);
  }

  /** 道具の一覧は Tools が持っているので、道具が増えたらボタンを作り直す。 */
  private syncTools(): void {
    const tools = this.selection;
    const others = this.items.filter((item) => item.group !== 'tool');
    this.items.length = 0;
    for (const tool of tools.list) {
      this.addItem(
        'tool',
        tool.label,
        () => tools.active === tool,
        () => tools.setActive(tool),
      );
    }
    this.items.push(...others);
    this.toolCount = tools.list.length;
  }

  private addItem(group: Group, label: string, isActive: () => boolean, press: () => void): void {
    this.items.push({ group, label, isActive, press, x: 0, y: 0, width: 0, height: 0, flashUntil: 0 });
    // ここでは作り直さない。フレーム処理の途中でパネルを差し替えると、古い方に描いてしまう。
    this.layoutDirty = true;
  }

  /** ボタンの数からレイアウトを決め、パネルを作り直す。 */
  private rebuild(): void {
    this.layoutDirty = false;
    const widthPx = PANEL_WIDTH * PIXELS_PER_METER;
    const buttonWidth = (widthPx - MARGIN * (COLUMNS + 1)) / COLUMNS;
    let y = HEADER_HEIGHT;
    for (const group of GROUPS) {
      const items = this.items.filter((item) => item.group === group);
      if (items.length === 0) continue;
      y += SECTION_HEIGHT;
      items.forEach((item, i) => {
        item.x = MARGIN + (i % COLUMNS) * (buttonWidth + MARGIN);
        item.y = y + Math.floor(i / COLUMNS) * (BUTTON_HEIGHT + MARGIN);
        item.width = buttonWidth;
        item.height = BUTTON_HEIGHT;
      });
      y += Math.ceil(items.length / COLUMNS) * (BUTTON_HEIGHT + MARGIN);
    }

    const old = this.panel;
    const panel = new CanvasPanel(PANEL_WIDTH, y / PIXELS_PER_METER, PIXELS_PER_METER);
    // メニューは他の仮想物体に埋もれないよう、最後に深度を無視して描く。
    panel.mesh.renderOrder = 100;
    panel.mesh.material.depthTest = false;
    if (old) {
      panel.mesh.position.copy(old.mesh.position);
      panel.mesh.quaternion.copy(old.mesh.quaternion);
      panel.mesh.visible = old.mesh.visible;
      this.app.scene.remove(old.mesh);
      old.texture.dispose();
      old.mesh.geometry.dispose();
      old.mesh.material.dispose();
    }
    this.app.scene.add(panel.mesh);
    this.panel = panel;
    this.dirty = true;
  }

  private updatePlacement(panel: CanvasPanel, ctx: FrameContext): void {
    const mesh = panel.mesh;
    const left = this.app.input.left;
    if (left.tracked) {
      mesh.position.copy(left.grabPosition);
      mesh.position.y += HAND_OFFSET + panel.height / 2;
      this.palmUp = left.palmNormal.y > (this.palmUp ? PALM_UP_HIDE : PALM_UP_SHOW);
      // 左手で物をつかんでいる間は邪魔なので隠す。
      mesh.visible = this.palmUp && !left.selecting && !left.squeezing && !this.suppressors.some((s) => s());
      this.placedInFront = true;
    } else if (!this.placedInFront) {
      _forward.set(0, 0, -1).applyQuaternion(ctx.headQuaternion).setY(0).normalize();
      mesh.position.copy(ctx.headPosition).addScaledVector(_forward, 0.45);
      mesh.position.y -= 0.25;
      mesh.visible = true;
      this.placedInFront = true;
    } else {
      mesh.visible = true;
    }
    mesh.lookAt(ctx.headPosition);
    mesh.updateMatrixWorld();
  }

  /** メニューを持っている手 (左手が見えていれば左手) では押せない。 */
  private canPress(hand: HandState): boolean {
    const left = this.app.input.left;
    return hand.tracked && !(left.tracked && hand === left);
  }

  hitTest(query: PointerQuery, hand: HandState) {
    const panel = this.panel;
    if (!panel?.mesh.visible || !this.canPress(hand)) return null;
    const point = query.kind === 'poke'
      ? panel.project(query.position)
      : panel.raycast(query.origin, query.direction);
    return point && { distance: point.distance, panelPoint: point };
  }

  onPointer(event: PointerEvent): void {
    const point = event.hit?.panelPoint;
    if (event.kind === 'down' && point) this.pressAt(point.x, point.y, event.hand);
  }

  private pressAt(x: number, y: number, hand: HandState): void {
    const item = this.items.find(
      (it) => x >= it.x && x <= it.x + it.width && y >= it.y && y <= it.y + it.height,
    );
    if (!item) return;
    item.flashUntil = this.time + 0.15;
    hand.pulse(0.6, 30);
    this.onPress?.(hand.tipPosition);
    try {
      item.press();
    } catch (error) {
      // ボタンの処理の失敗で、メニューごと止まらないようにする。
      console.error(`[menu] 「${item.label}」の処理に失敗しました`, error);
    }
    this.dirty = true;
  }

  private draw(panel: CanvasPanel): void {
    this.dirty = false;
    const g = panel.context;
    const { width, height } = panel.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = 'rgba(16, 20, 28, 0.88)';
    g.beginPath();
    g.roundRect(0, 0, width, height, 24);
    g.fill();

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = 'bold 30px system-ui, sans-serif';
    g.fillText('MR プレイルーム', MARGIN + 6, 30);
    g.fillStyle = '#a9b4c8';
    g.font = '20px system-ui, sans-serif';
    g.fillText(this.selection.active?.hint ?? '', MARGIN + 6, 70, width - MARGIN * 2 - 12);

    let lastGroup: Group | null = null;
    for (const item of GROUPS.flatMap((group) => this.items.filter((it) => it.group === group))) {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        g.textAlign = 'left';
        g.fillStyle = '#8a94a8';
        g.font = '20px system-ui, sans-serif';
        g.fillText(GROUP_TITLES[item.group], MARGIN + 6, item.y - SECTION_HEIGHT / 2 + 4);
      }
      const active = item.isActive();
      g.fillStyle = item.flashUntil > 0 ? '#ffffff' : active ? '#4f8cff' : '#2a3142';
      g.beginPath();
      g.roundRect(item.x, item.y, item.width, item.height, 14);
      g.fill();
      g.fillStyle = item.flashUntil > 0 ? '#10141c' : '#ffffff';
      g.textAlign = 'center';
      g.font = 'bold 24px system-ui, sans-serif';
      g.fillText(item.label, item.x + item.width / 2, item.y + item.height / 2 + 1, item.width - 12);
    }
    panel.markDirty();
  }
}
