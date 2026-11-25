import type { Feature, FrameContext } from '../app';
import type { HandState, InputEvent } from '../input';
import type { GrabInterceptor, ItemEvents } from '../items';
import type { Interceptor } from '../tools';
import type {
  InteractionCategory,
  InteractionContext,
  InteractionFactory,
  InteractionServices,
  ItemInteraction,
} from './types';

/** strategies/ 以下の各ファイル。_ で始まるファイルは読み込まない (下書き用)。 */
const MODULES = import.meta.glob<{ default: InteractionFactory }>('./strategies/[!_]*.ts', { eager: true });

/** オンにしている操作の ID を、次回も覚えておくための localStorage のキー */
const STORAGE_KEY = 'mr-playroom:item-interactions';
const CATEGORY_ORDER: InteractionCategory[] = ['delete', 'duplicate', 'menu'];

interface Entry {
  interaction: ItemInteraction;
  /** メニューでオンにしている */
  enabled: boolean;
  /** enable を呼んでから disable を呼ぶまで (オン、かつ MR 中) */
  active: boolean;
  /** update か通知の処理で例外を出したので、MR を始め直すまで止めている */
  failed: boolean;
  input: Map<InputEvent, ((hand: HandState) => void)[]>;
  selectInterceptors: Interceptor[];
}

/**
 * 持っている物への操作 (削除・複製・メニュー) の試作を、メニューから 1 つずつオン / オフできるようにする。
 * 同時にいくつオンにしてもよいが、同じ動きを使う案どうしは取り合うことがある。
 */
export class ItemInteractions implements Feature {
  readonly name = 'itemInteractions';
  private readonly entries: Entry[] = [];
  private running = false;

  constructor(services: InteractionServices) {
    const { app } = services;
    const saved = loadEnabled();
    const factories = Object.entries(MODULES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, module]) => ({ path, factory: module.default }));

    for (const { path, factory } of factories) {
      const entry: Entry = {
        interaction: null as unknown as ItemInteraction,
        enabled: false,
        active: false,
        failed: false,
        input: new Map(),
        selectInterceptors: [],
      };
      const live = (): boolean => entry.active && !entry.failed;
      const guard = <A extends unknown[], R>(fn: (...args: A) => R, fallback: R) => (...args: A): R => {
        if (!live()) return fallback;
        try {
          return fn(...args);
        } catch (error) {
          this.fail(entry, error);
          return fallback;
        }
      };
      const ctx: InteractionContext = {
        ...services,
        items: app.items,
        onInput: (event, listener) => {
          const list = entry.input.get(event) ?? [];
          list.push(listener);
          entry.input.set(event, list);
        },
        onItems: <K extends keyof ItemEvents>(event: K, listener: (payload: ItemEvents[K]) => void) => {
          app.items.on(event, guard(listener, undefined));
        },
        addGrabInterceptor: (interceptor: GrabInterceptor) => {
          app.items.addGrabInterceptor(guard(interceptor, false));
        },
        addSelectInterceptor: (interceptor) => entry.selectInterceptors.push(interceptor),
      };
      try {
        entry.interaction = factory(ctx);
      } catch (error) {
        console.error(`[itemInteractions] ${path} を読み込めませんでした`, error);
        continue;
      }
      entry.enabled = saved.has(entry.interaction.id);
      this.entries.push(entry);

      // 入力は、登録した順に 1 つずつ有効な操作へ配る。
      for (const event of ['selectstart', 'selectend', 'squeezestart', 'squeezeend'] as const) {
        app.input.on(event, (hand) => {
          for (const listener of entry.input.get(event) ?? []) guard(listener, undefined)(hand);
        });
      }
    }
    this.entries.sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.interaction.category) - CATEGORY_ORDER.indexOf(b.interaction.category) ||
        a.interaction.id.localeCompare(b.interaction.id),
    );

    // メニュー・物をつかむ・道具より先に試す。
    app.tools.addInterceptor(
      (hand) =>
        this.entries.some(
          (entry) =>
            entry.active &&
            !entry.failed &&
            entry.selectInterceptors.some((interceptor) => {
              try {
                return interceptor(hand);
              } catch (error) {
                this.fail(entry, error);
                return false;
              }
            }),
        ),
      { first: true },
    );

    for (const entry of this.entries) {
      const { id, label } = entry.interaction;
      app.menu.addToggle(
        `${id} ${label}`,
        () => entry.enabled,
        (value) => this.setEnabled(entry, value),
        'experiment',
      );
    }
  }

  /** オンにしている操作の ID */
  get enabledIds(): string[] {
    return this.entries.filter((entry) => entry.enabled).map((entry) => entry.interaction.id);
  }

  start(): void {
    this.running = true;
    for (const entry of this.entries) {
      entry.failed = false;
      if (entry.enabled) this.activate(entry);
    }
  }

  end(): void {
    this.running = false;
    for (const entry of this.entries) this.deactivate(entry);
  }

  update(frame: FrameContext): void {
    for (const entry of this.entries) {
      if (!entry.active || entry.failed) continue;
      try {
        entry.interaction.update?.(frame);
      } catch (error) {
        this.fail(entry, error);
      }
    }
  }

  private setEnabled(entry: Entry, enabled: boolean): void {
    entry.enabled = enabled;
    if (enabled && this.running) this.activate(entry);
    if (!enabled) this.deactivate(entry);
    saveEnabled(this.enabledIds);
  }

  private activate(entry: Entry): void {
    if (entry.active) return;
    entry.active = true;
    try {
      entry.interaction.enable?.();
    } catch (error) {
      this.fail(entry, error);
    }
  }

  private deactivate(entry: Entry): void {
    if (!entry.active) return;
    entry.active = false;
    try {
      entry.interaction.disable?.();
    } catch (error) {
      console.error(`[itemInteractions] ${entry.interaction.id} の片付けに失敗しました`, error);
    }
  }

  /** 1 つの操作の失敗で、ほかの操作やアプリ全体を止めない。 */
  private fail(entry: Entry, error: unknown): void {
    if (entry.failed) return;
    entry.failed = true;
    console.error(`[itemInteractions] ${entry.interaction.id} が失敗したため、MR を始め直すまで止めます`, error);
    this.deactivate(entry);
    // 止めた操作は、オンのままにしておく (次の MR で再び試す)。
  }
}

function loadEnabled(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveEnabled(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 保存できなくても、このセッション中の切り替えは効く。
  }
}
