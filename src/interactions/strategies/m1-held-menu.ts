import * as THREE from 'three';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import { CanvasPanel, useMenuDepth } from '../../ui/canvasPanel';
import { ITEM_ACTIONS } from '../actions';
import type { InteractionFactory } from '../types';

const PANEL_WIDTH = 0.2;
const PIXELS_PER_METER = 2000;
const MARGIN = 10;
const HEADER_HEIGHT = 64;
const BUTTON_HEIGHT = 84;

/** 手のひらからパネルまでの高さ (m)。既存のメニューと同じ。 */
const HAND_OFFSET = 0.13;
/**
 * 手のひらの向きの上向き成分が SHOW を超えたらパネルを出し、HIDE を下回ったら隠す。
 * 境目で点滅しないよう、出す条件と隠す条件に差をつけている (既存のメニューと同じ値)。
 */
const PALM_UP_SHOW = Math.cos(THREE.MathUtils.degToRad(50));
const PALM_UP_HIDE = Math.cos(THREE.MathUtils.degToRad(65));
/** 指先がパネルの手前この距離より離れると、次の押下を受け付ける (m) */
const POKE_ARM_DISTANCE = 0.02;
/** レイでパネルを押せる最大距離 (m) */
const RAY_REACH = 2;

export interface ButtonRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 手のひらが上を向いているか。出ている間は、向きが少し崩れても保つ。 */
export function isPalmUp(normalY: number, wasUp: boolean): boolean {
  return normalY > (wasUp ? PALM_UP_HIDE : PALM_UP_SHOW);
}

/** ボタンを縦に並べたときの配置。 */
export function layoutButtons(count: number, widthPx: number): ButtonRect[] {
  return Array.from({ length: count }, (_, i) => ({
    x: MARGIN,
    y: HEADER_HEIGHT + i * (BUTTON_HEIGHT + MARGIN),
    width: widthPx - MARGIN * 2,
    height: BUTTON_HEIGHT,
  }));
}

/** キャンバス上の点がどのボタンに当たるか。どれでもなければ -1。 */
export function buttonAt(buttons: readonly ButtonRect[], x: number, y: number): number {
  return buttons.findIndex((b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
}

const create: InteractionFactory = (ctx) => {
  const widthPx = PANEL_WIDTH * PIXELS_PER_METER;
  const buttons = layoutButtons(ITEM_ACTIONS.length, widthPx);
  const heightPx = HEADER_HEIGHT + ITEM_ACTIONS.length * (BUTTON_HEIGHT + MARGIN);

  let active = false;
  let panel: CanvasPanel | null = null;
  let palmUp = false;
  /** 操作したあと、手のひらを下ろすまでは出し直さない (複製では元の物が手に残るため) */
  let dismissed = false;
  /** パネルを出している間の、物を持っている手 */
  let holder: HandState | null = null;
  /** パネルを出している手のひら側の手 */
  let palmHand: HandState | null = null;
  const pokeArmed = new Map<HandState, boolean>();

  const holdingHand = (): HandState | null =>
    ctx.app.input.hands.find((hand) => hand.tracked && ctx.items.heldBy(hand).length > 0) ?? null;

  // この案が有効で物を持っている間は、既存のメニューを出さない。
  ctx.app.menu.addSuppressor(() => active && holdingHand() !== null);

  function createPanel(): CanvasPanel {
    const p = new CanvasPanel(PANEL_WIDTH, heightPx / PIXELS_PER_METER, PIXELS_PER_METER);
    useMenuDepth(p.mesh.material);
    p.mesh.visible = false;
    const g = p.context;
    g.fillStyle = 'rgba(16, 20, 28, 0.88)';
    g.beginPath();
    g.roundRect(0, 0, p.canvas.width, p.canvas.height, 24);
    g.fill();
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = 'bold 28px system-ui, sans-serif';
    g.fillText('持っている物', MARGIN + 6, HEADER_HEIGHT / 2);
    ITEM_ACTIONS.forEach((action, i) => {
      const b = buttons[i];
      g.fillStyle = action.id === 'delete' ? '#8a2f3a' : '#2a3142';
      g.beginPath();
      g.roundRect(b.x, b.y, b.width, b.height, 14);
      g.fill();
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.font = 'bold 26px system-ui, sans-serif';
      g.fillText(action.label, b.x + b.width / 2, b.y + b.height / 2 + 1, b.width - 12);
    });
    p.markDirty();
    return p;
  }

  function dispose(): void {
    if (!panel) return;
    ctx.app.scene.remove(panel.mesh);
    panel.texture.dispose();
    panel.mesh.geometry.dispose();
    panel.mesh.material.dispose();
    panel = null;
  }

  function press(index: number, presser: HandState): void {
    const action = ITEM_ACTIONS[index];
    if (!action || !holder) return;
    const targets: Item[] = ctx.items.heldBy(holder);
    ctx.audio.click(presser.tipPosition);
    presser.pulse(0.6, 30);
    action.run(ctx.items, targets);
    // 対象の物が無くなる (または元が手に残る) ので、パネルを閉じる。
    dismissed = true;
    if (panel) panel.mesh.visible = false;
  }

  // パネルを出しているときに、手のひら側でない手でつまむ / トリガーを引いたら、レイで押す。
  ctx.addSelectInterceptor((hand) => {
    if (!panel || !panel.mesh.visible || hand === palmHand || !hand.tracked) return false;
    const point = panel.raycast(hand.rayOrigin, hand.rayDirection);
    if (!point || point.distance > RAY_REACH) return false;
    const index = buttonAt(buttons, point.x, point.y);
    if (index >= 0) press(index, hand);
    // ボタンの隙間でも、パネル越しに道具が発動しないよう入力は消費する。
    return true;
  });

  return {
    id: 'M1',
    label: '持物メニュー',
    category: 'menu',
    enable() {
      active = true;
      dismissed = false;
      palmUp = false;
      pokeArmed.clear();
      panel = createPanel();
      ctx.app.scene.add(panel.mesh);
    },
    disable() {
      active = false;
      holder = null;
      palmHand = null;
      pokeArmed.clear();
      dispose();
    },
    update(frame) {
      if (!panel) return;
      holder = holdingHand();
      palmHand = holder ? ctx.app.input.other(holder) : null;
      if (!holder || !palmHand || !palmHand.tracked) {
        panel.mesh.visible = false;
        palmUp = false;
        dismissed = false;
        holder = null;
        palmHand = null;
        return;
      }
      palmUp = isPalmUp(palmHand.palmNormal.y, palmUp);
      if (!palmUp) dismissed = false;
      // 手のひら側の手が物をつまんでいる間は、押す動作と紛れるので出さない。
      panel.mesh.visible = palmUp && !dismissed && !palmHand.selecting && !palmHand.squeezing;
      if (!panel.mesh.visible) return;
      panel.mesh.position.copy(palmHand.grabPosition);
      panel.mesh.position.y += HAND_OFFSET + panel.height / 2;
      panel.mesh.lookAt(frame.headPosition);
      panel.mesh.updateMatrixWorld();

      // 指先で押す: 持っている手の指先がパネルの表から裏へ抜けた瞬間に押す。
      for (const hand of ctx.app.input.hands) {
        if (hand === palmHand || !hand.tracked) {
          pokeArmed.set(hand, false);
          continue;
        }
        const point = panel.project(hand.tipPosition);
        if (!point || point.distance > POKE_ARM_DISTANCE) {
          pokeArmed.set(hand, true);
        } else if (point.distance < 0.005 && point.distance > -0.04 && pokeArmed.get(hand)) {
          pokeArmed.set(hand, false);
          const index = buttonAt(buttons, point.x, point.y);
          if (index >= 0) {
            press(index, hand);
            return;
          }
        }
      }
    },
  };
};

export default create;
