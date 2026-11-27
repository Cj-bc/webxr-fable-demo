import type { ISelector } from './selector';
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

/** 登録された道具の一覧と選択状態。 */
export class ToolSelector implements ISelector<Tool> {
  private readonly registered: Tool[] = [];
  private selected: Tool | null = null;
  private readonly changeListeners: (() => void)[] = [];

  get list(): readonly Tool[] {
    return this.registered;
  }

  get active(): Tool | null {
    return this.selected;
  }

  register(tool: Tool): void {
    this.registered.push(tool);
    this.selected ??= tool;
    for (const listener of this.changeListeners) listener();
  }

  setActive(tool: Tool): void {
    if (!this.registered.includes(tool)) return;
    this.selected = tool;
    for (const listener of this.changeListeners) listener();
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }
}

/** XR の select 入力を道具より先に処理する UI。 */
export interface SelectInputHandler {
  interceptSelect(hand: HandState): boolean;
}

/**
 * select (つまみ / トリガー) の行き先を決める。
 * 登録順に interceptor を試し (メニューを押す、近くの物をつかむ)、
 * 誰も処理しなければ選択中の道具に渡す。
 */
export class Tools extends ToolSelector {
  private readonly interceptors: Interceptor[] = [];
  /** selectstart を受けた道具。途中で道具を切り替えても selectend を同じ道具に返す。 */
  private readonly started = new Map<HandState, Tool>();

  constructor(input: Input) {
    super();
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

  addSelector(selector: SelectInputHandler): void {
    this.addInterceptor((hand) => selector.interceptSelect(hand));
  }

  /** first: 先に登録された interceptor (メニューを押す、近くの物をつかむ) より先に試す */
  addInterceptor(interceptor: Interceptor, { first = false } = {}): void {
    if (first) this.interceptors.unshift(interceptor);
    else this.interceptors.push(interceptor);
  }
}
