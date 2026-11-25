import type { App, FrameContext } from '../app';
import type { Audio } from '../features/audio';
import type { HitTest } from '../features/hitTest';
import type { Portal } from '../features/portal';
import type { Room } from '../features/room';
import type { Toys } from '../features/toys';
import type { HandState, InputEvent } from '../input';
import type { GrabInterceptor, ItemEvents, Items } from '../items';
import type { Interceptor } from '../tools';

/** 操作の分類。メニューの並び順と、ideas.md の分類 (D / C / M) に対応する。 */
export type InteractionCategory = 'delete' | 'duplicate' | 'menu';

/** 操作の実装から使える、ほかの機能 */
export interface InteractionServices {
  app: App;
  audio: Audio;
  room: Room;
  hitTest: HitTest;
  portal: Portal;
  toys: Toys;
}

/**
 * 操作の実装に渡すもの。
 * 入力や物の通知は、必ずここの on... / add... で受け取る。有効な間 (メニューでオンにしていて、MR 中) だけ呼ばれる。
 * app.input.on などに直接登録すると、オフにしても止まらないので使わない。
 */
export interface InteractionContext extends InteractionServices {
  readonly items: Items;
  /** つまみ / 握るの開始・終了 */
  onInput(event: InputEvent, listener: (hand: HandState) => void): void;
  /** 物を持った・離した・消した・複製した */
  onItems<K extends keyof ItemEvents>(event: K, listener: (event: ItemEvents[K]) => void): void;
  /** 近くの物を持とうとしたときに、持つ代わりに別のことをする。処理したら true */
  addGrabInterceptor(interceptor: GrabInterceptor): void;
  /**
   * つまみ / トリガーを、メニュー・物をつかむ・道具より先に横取りする。処理したら true。
   * 何もない所でつまんだときにも呼ばれるので、関係ない入力では false を返すこと。
   */
  addSelectInterceptor(interceptor: Interceptor): void;
}

/**
 * 持っている物を削除・複製する、ひとつの操作方法 (ideas.md の 1 案)。
 * `src/interactions/strategies/` に 1 ファイル 1 案で置き、InteractionFactory を default export すると、
 * 自動で読み込まれ、メニューの「持った物の操作 (試作)」にオン / オフのボタンが出る。
 */
export interface ItemInteraction {
  /** ideas.md の ID。例: 'D1' */
  readonly id: string;
  /** メニューのボタンに出す短い名前 (全角 6 文字程度まで)。ボタンには `${id} ${label}` と出る。 */
  readonly label: string;
  readonly category: InteractionCategory;
  /** 有効になったとき (オンにしたとき、またはオンのまま MR を始めたとき) */
  enable?(): void;
  /** 無効になったとき (オフにしたとき、または MR を終えたとき)。出している物や途中の状態を片付ける。 */
  disable?(): void;
  /** 有効な間、毎フレーム呼ばれる。物の削除・複製は ctx.items.remove / duplicate を通す。 */
  update?(frame: FrameContext): void;
}

export type InteractionFactory = (ctx: InteractionContext) => ItemInteraction;
