// M2 円形メニュー (マーキングメニュー)。
// 物を持っている間に、もう一方の手でつまむ (コントローラーではトリガー) と、つまんだ位置に円形のメニューが出る。
// つまんだまま上下左右のどれかへ動かして離すと、その方向の操作を実行する。動かさずに離したら何もしない。
import * as THREE from 'three';
import { CanvasPanel, useMenuDepth } from '../../ui/canvasPanel';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import { ITEM_ACTIONS, type ItemAction } from '../actions';
import type { InteractionFactory } from '../types';

export type MenuDirection = 'up' | 'down' | 'left' | 'right';
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 方向への操作の割り当て。null は何も無い方向 (動かしても何も起きない) */
export const DIRECTION_ACTIONS: Record<MenuDirection, ItemAction['id'] | null> = {
  up: 'duplicate',
  down: 'delete',
  left: null,
  right: null,
};

/** つまみ始めからこれだけ動かすと、その方向が選ばれかける (m)。手の震えや、つまむときのずれでは選ばれない大きさ。 */
export const SELECT_DISTANCE = 0.06;
/** もう一方の手が持っている物の、この距離 (m) より近くでつまんだときは、両手持ち (Holding / Toys) に任せる。物の大きさ (scale) ぶん広げる。 */
const TWO_HAND_REACH = 0.2;
const TWO_HAND_REACH_PER_SCALE = 0.15;
/** 方向が切り替わるときの弱い振動 */
const SWITCH_PULSE = { intensity: 0.15, durationMs: 15 };

/** メニューの板の大きさ (m) と解像度 (px/m) */
const PANEL_SIZE = 0.3;
const PANEL_PPM = 800;

/**
 * つまみ始めの位置 origin と頭の位置 head から、メニューの面の軸を求める。
 * 面は鉛直で、頭の方を向く (頭の高さの違いは無視して、水平方向だけで向きを決める)。
 * 頭が真上・真下で向きが決まらなければ、z 軸 (面の法線) は +Z とする。
 */
export function menuAxes(origin: Vec3, head: Vec3): { right: Vec3; up: Vec3; normal: Vec3 } {
  let nx = head.x - origin.x;
  let nz = head.z - origin.z;
  const length = Math.hypot(nx, nz);
  if (length < 1e-4) {
    nx = 0;
    nz = 1;
  } else {
    nx /= length;
    nz /= length;
  }
  // right = up × normal = (0,1,0) × (nx,0,nz)
  return { right: { x: nz, y: 0, z: -nx }, up: { x: 0, y: 1, z: 0 }, normal: { x: nx, y: 0, z: nz } };
}

/**
 * つまみ始めからの手の移動 delta を、面の軸 (right, up) に投影して、選ばれかけている方向を返す。
 * 面の中での移動が threshold 未満なら null。面に垂直な動き (手前・奥) は無視する。
 * 斜めのときは、移動の大きい方の軸を選ぶ (4 方向が 90 度ずつ)。
 */
export function pickDirection(delta: Vec3, right: Vec3, up: Vec3, threshold: number): MenuDirection | null {
  const x = delta.x * right.x + delta.y * right.y + delta.z * right.z;
  const y = delta.x * up.x + delta.y * up.y + delta.z * up.z;
  if (Math.hypot(x, y) < threshold) return null;
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'up' : 'down';
}

interface OpenMenu {
  hand: HandState;
  origin: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** メニューを開いた時点で、もう一方の手が持っていた物 */
  targets: Item[];
  direction: MenuDirection | null;
}

const _delta = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

const create: InteractionFactory = (ctx) => {
  const panel = new CanvasPanel(PANEL_SIZE, PANEL_SIZE, PANEL_PPM);
  useMenuDepth(panel.mesh.material);
  let menu: OpenMenu | null = null;
  const head = new THREE.Vector3();
  let headKnown = false;

  const actionFor = (direction: MenuDirection | null): ItemAction | undefined => {
    const id = direction && DIRECTION_ACTIONS[direction];
    return id ? ITEM_ACTIONS.find((action) => action.id === id) : undefined;
  };

  const draw = (selected: MenuDirection | null): void => {
    const g = panel.context;
    const size = panel.canvas.width;
    const c = size / 2;
    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(20, 24, 32, 0.78)';
    g.beginPath();
    g.arc(c, c, c * 0.96, 0, Math.PI * 2);
    g.fill();
    // 方向ごとの扇形。選ばれかけている方向を明るくする。
    const centers: Record<MenuDirection, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
    for (const direction of Object.keys(centers) as MenuDirection[]) {
      const angle = centers[direction];
      const action = actionFor(direction);
      if (direction === selected && action) {
        g.fillStyle = 'rgba(80, 170, 255, 0.85)';
        g.beginPath();
        g.moveTo(c, c);
        g.arc(c, c, c * 0.96, angle - Math.PI / 4, angle + Math.PI / 4);
        g.closePath();
        g.fill();
      }
      g.fillStyle = action ? '#ffffff' : 'rgba(255, 255, 255, 0.25)';
      g.font = `bold ${size * 0.11}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(action?.label ?? '—', c + Math.cos(angle) * c * 0.62, c + Math.sin(angle) * c * 0.62);
    }
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(c, c, size * 0.025, 0, Math.PI * 2);
    g.fill();
    panel.markDirty();
  };

  const close = (): void => {
    menu = null;
    panel.mesh.removeFromParent();
  };

  /** もう一方の手が持っている物の近く (両手持ちが先に動く範囲) か */
  const nearHeldItem = (hand: HandState, held: readonly Item[]): boolean =>
    held.some(
      (item) =>
        item.object.position.distanceTo(hand.grabPosition) <
        TWO_HAND_REACH + TWO_HAND_REACH_PER_SCALE * item.object.scale.x,
    );

  // 物を持っている手の反対の手でつまんだら開く。それ以外は何もしない (道具を壊さない)。
  ctx.addSelectInterceptor((hand) => {
    if (menu || !hand.tracked || !headKnown) return false;
    if (ctx.items.heldBy(hand).length > 0) return false;
    const held = ctx.items.heldBy(ctx.app.input.other(hand));
    if (held.length === 0) return false;
    // 持っている物の近くでつまんだときは、両手持ちを優先する。
    if (nearHeldItem(hand, held)) return false;

    const axes = menuAxes(hand.grabPosition, head);
    menu = {
      hand,
      origin: hand.grabPosition.clone(),
      right: new THREE.Vector3(axes.right.x, axes.right.y, axes.right.z),
      up: new THREE.Vector3(axes.up.x, axes.up.y, axes.up.z),
      targets: held,
      direction: null,
    };
    _normal.set(axes.normal.x, axes.normal.y, axes.normal.z);
    _matrix.makeBasis(menu.right, menu.up, _normal);
    panel.mesh.quaternion.setFromRotationMatrix(_matrix);
    panel.mesh.position.copy(menu.origin);
    ctx.app.scene.add(panel.mesh);
    draw(null);
    hand.pulse(0.3, 20);
    return true;
  });

  ctx.onInput('selectend', (hand) => {
    if (!menu || menu.hand !== hand) return;
    const { direction, targets, origin } = menu;
    close();
    const action = actionFor(direction);
    if (!action) return;
    // 開いている間に消えた物は、すでに閉じているはずだが、念のため残っているものだけを対象にする。
    const alive = targets.filter((item) => ctx.items.all.includes(item));
    if (alive.length === 0) return;
    ctx.audio.chime(origin);
    action.run(ctx.items, alive);
  });

  // 対象の物が消えたら閉じる。
  ctx.onItems('removing', ({ item }) => {
    if (menu?.targets.includes(item)) close();
  });

  return {
    id: 'M2',
    label: '円形メニュー',
    category: 'menu',
    disable() {
      close();
      headKnown = false;
    },
    update(frame) {
      head.copy(frame.headPosition);
      headKnown = true;
      if (!menu) return;
      const { hand } = menu;
      // つまみを離したのに selectend を受けそこねた (手の持ち替えなど) ときは、何もせず閉じる。
      if (!hand.selecting || !hand.tracked) {
        close();
        return;
      }
      _delta.copy(hand.grabPosition).sub(menu.origin);
      const direction = pickDirection(_delta, menu.right, menu.up, SELECT_DISTANCE);
      if (direction === menu.direction) return;
      menu.direction = direction;
      draw(direction);
      hand.pulse(SWITCH_PULSE.intensity, SWITCH_PULSE.durationMs);
    },
  };
};

export default create;
