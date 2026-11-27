import type { HandState, Input } from './input';

/** メニューで切り替える「道具」。つまみ / トリガーで何が起きるかを決める。 */
export interface Tool {
  id: string;
  label: string;
  /** メニューに出す 1 行の操作説明 */
  hint: string;
  /** つまみ / トリガーを、近くの写真や線を持つこと (Holding) より優先する */
  overridesHold?: boolean;
  onSelectStart(hand: HandState): void;
  onSelectEnd?(hand: HandState): void;
}

/** select を道具より先に横取りする処理。処理したら true を返す。 */
export type Interceptor = (hand: HandState) => boolean;

/** 選択 UI が共有する道具の一覧と選択状態。 */
export interface ToolSelection {
  readonly list: readonly Tool[];
  readonly active: Tool | null;
  setActive(tool: Tool): void;
  onChange(listener: () => void): void;
}

/** 道具を選ぶ UI。既定の select 入力を使う場合は、道具への入力より先に処理する。 */
export interface ToolSelector {
  interceptSelect(hand: HandState): boolean;
}

/**
 * select (つまみ / トリガー) の行き先を決める。
 * 登録順に interceptor を試し (メニューを押す、近くの物をつかむ)、
 * 誰も処理しなければ選択中の道具に渡す。
 */
export class Tools implements ToolSelection {
  readonly list: Tool[] = [];
  active: Tool | null = null;
  private readonly changeListeners: (() => void)[] = [];

  private readonly interceptors: Interceptor[] = [];
  /** selectstart を受けた道具。途中で道具を切り替えても selectend を同じ道具に返す。 */
  private readonly started = new Map<HandState, Tool>();

  constructor(input: Input) {
    input.on('selectstart', (hand) => {
      // 手を握ると、親指が人差し指に触れてつまみと判定されることがある。握っている手のつまみは無視する。
      if (hand.isHand && hand.squeezing) return;
      if (this.interceptors.some((intercept) => intercept(hand))) return;
      const tool = this.active;
      if (!tool) return;
      this.started.set(hand, tool);
      tool.onSelectStart(hand);
    });
    input.on('selectend', (hand) => {
      const tool = this.started.get(hand);
      this.started.delete(hand);
      tool?.onSelectEnd?.(hand);
    });
  }

  register(tool: Tool): void {
    this.list.push(tool);
    this.active ??= tool;
    for (const listener of this.changeListeners) listener();
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  addSelector(selector: ToolSelector): void {
    this.addInterceptor((hand) => selector.interceptSelect(hand));
  }

  /** first: 先に登録された interceptor (メニューを押す、近くの物をつかむ) より先に試す */
  addInterceptor(interceptor: Interceptor, { first = false } = {}): void {
    if (first) this.interceptors.unshift(interceptor);
    else this.interceptors.push(interceptor);
  }

  setActive(tool: Tool): void {
    this.active = tool;
    for (const listener of this.changeListeners) listener();
  }
}
