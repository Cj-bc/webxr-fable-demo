import type { HandState, Input } from './input';

/** メニューで切り替える「道具」。つまみ / トリガーで何が起きるかを決める。 */
export interface Tool {
  id: string;
  label: string;
  /** メニューに出す 1 行の操作説明 */
  hint: string;
  onSelectStart(hand: HandState): void;
  onSelectEnd?(hand: HandState): void;
}

/** select を道具より先に横取りする処理。処理したら true を返す。 */
export type Interceptor = (hand: HandState) => boolean;

/**
 * select (つまみ / トリガー) の行き先を決める。
 * 登録順に interceptor を試し (メニューを押す、近くの物をつかむ)、
 * 誰も処理しなければ選択中の道具に渡す。
 */
export class Tools {
  readonly list: Tool[] = [];
  active: Tool | null = null;
  onChange: (() => void) | null = null;

  private readonly interceptors: Interceptor[] = [];
  /** selectstart を受けた道具。途中で道具を切り替えても selectend を同じ道具に返す。 */
  private readonly started = new Map<HandState, Tool>();

  constructor(input: Input) {
    input.on('selectstart', (hand) => {
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
    this.onChange?.();
  }

  addInterceptor(interceptor: Interceptor): void {
    this.interceptors.push(interceptor);
  }

  setActive(tool: Tool): void {
    this.active = tool;
    this.onChange?.();
  }
}
