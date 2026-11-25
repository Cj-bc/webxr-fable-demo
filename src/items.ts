import type * as THREE from 'three';
import type { HandState } from './input';

/** 手で持てる物の種類 */
export type ItemKind = 'ball' | 'block' | 'photo' | 'stroke';
/** どの入力で持っているか。select: つまみ / トリガー、squeeze: 手全体で握る / グリップ */
export type GrabButton = 'select' | 'squeeze';

/**
 * 手で持てる物 1 つ。物を作った機能 (Toys / Drawing / HandFrame) が実装して Items に登録する。
 * 削除・複製などの操作は、物の種類によらずこの形で行う。
 */
export interface Item {
  readonly kind: ItemKind;
  /** シーンの直下にある物の本体。位置・向き・大きさ (scale.x) はワールド座標 */
  readonly object: THREE.Object3D;
  /**
   * 物を消す。持っている手からも外し、Items からも外す。保存してある画像なども消す。
   * 直接呼ばず、Items.remove を通す (通知を出すため)。
   */
  remove(): void;
  /**
   * 同じ見た目の物を、同じ位置・向き・大きさで新しく作り、登録して返す。作れなければ null。
   * 直接呼ばず、Items.duplicate を通す。
   */
  duplicate(): Item | null;
  /** 位置と向きを変える。物理のある物は剛体も合わせ、止まった状態にする。持っている最中は効かない。 */
  setPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  /** この手で持たせる。手がすでに何か持っている、などで持てなければ false */
  grab(hand: HandState, button: GrabButton): boolean;
}

export interface HoldEvent {
  hand: HandState;
  /** その手が持った / 離した物。線は重なっている線がまとめて動くので、複数になることがある。 */
  items: readonly Item[];
  button: GrabButton;
}

export interface ItemEvents {
  /** 手で持った直後 */
  grab: HoldEvent;
  /** 手を離した直後。物理のある物は、すでに手の速度で動き出している。 */
  release: HoldEvent;
  /** Items.remove で消す直前 (object はまだシーンにある) */
  removing: { item: Item };
  /** Items.duplicate で複製した直後 */
  duplicated: { source: Item; copy: Item };
}

/**
 * 持とうとしたときに、持つ代わりに別のことをする処理 (例: 持っている物をもう一方の手でつまむと複製)。
 * 処理したら true を返す。その入力は消費され、物は持たれず、道具も発動しない。
 */
export type GrabInterceptor = (hand: HandState, item: Item, button: GrabButton) => boolean;

type Listener<K extends keyof ItemEvents> = (event: ItemEvents[K]) => void;

/**
 * 手で持てる物の一覧と、持っている状態。
 * - 物を作る機能: register / unregister で登録し、持った・離したら notifyGrab / notifyRelease で知らせる。
 *   持つ前には interceptGrab を呼び、true なら持たずに入力を消費する。
 * - 削除・複製などの操作: 一覧・持っている物・通知を読み、remove / duplicate で物を変える。
 */
export class Items {
  private readonly items: Item[] = [];
  private readonly byObject = new Map<THREE.Object3D, Item>();
  private readonly held = new Map<HandState, Set<Item>>();
  private readonly interceptors: GrabInterceptor[] = [];
  private readonly listeners: { [K in keyof ItemEvents]: Listener<K>[] } = {
    grab: [],
    release: [],
    removing: [],
    duplicated: [],
  };

  get all(): readonly Item[] {
    return this.items;
  }

  /** シーンの物から、それを本体とする Item を引く */
  of(object: THREE.Object3D): Item | undefined {
    return this.byObject.get(object);
  }

  /** その手が持っている物。持っていなければ空 */
  heldBy(hand: HandState): Item[] {
    return [...(this.held.get(hand) ?? [])];
  }

  /** その物を持っている手 (0 ～ 2 本) */
  holdersOf(item: Item): HandState[] {
    return [...this.held].filter(([, items]) => items.has(item)).map(([hand]) => hand);
  }

  on<K extends keyof ItemEvents>(event: K, listener: Listener<K>): () => void {
    const list = this.listeners[event] as Listener<K>[];
    list.push(listener);
    return () => {
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    };
  }

  addGrabInterceptor(interceptor: GrabInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      const index = this.interceptors.indexOf(interceptor);
      if (index >= 0) this.interceptors.splice(index, 1);
    };
  }

  /** 物を消す。持っている手からも外れる。 */
  remove(item: Item): void {
    if (!this.items.includes(item)) return;
    this.emit('removing', { item });
    item.remove();
    // 実装が unregister を忘れても、一覧に残らないようにする。
    this.unregister(item);
  }

  /** 物を複製する。複製は元と同じ位置・向き・大きさに現れる。 */
  duplicate(item: Item): Item | null {
    if (!this.items.includes(item)) return null;
    const copy = item.duplicate();
    if (!copy) return null;
    if (!this.items.includes(copy)) this.register(copy);
    this.emit('duplicated', { source: item, copy });
    return copy;
  }

  // --- ここから下は、物を作る機能が呼ぶ ---

  register(item: Item): void {
    if (this.items.includes(item)) return;
    this.items.push(item);
    this.byObject.set(item.object, item);
  }

  unregister(item: Item): void {
    const index = this.items.indexOf(item);
    if (index < 0) return;
    this.items.splice(index, 1);
    this.byObject.delete(item.object);
    for (const [hand, items] of this.held) {
      items.delete(item);
      if (items.size === 0) this.held.delete(hand);
    }
  }

  /** 持とうとする直前に呼ぶ。true なら、持たずに入力を消費する。 */
  interceptGrab(hand: HandState, item: Item, button: GrabButton): boolean {
    for (const interceptor of this.interceptors) {
      try {
        if (interceptor(hand, item, button)) return true;
      } catch (error) {
        console.error('[items] 持つ前の処理に失敗しました', error);
      }
    }
    return false;
  }

  notifyGrab(hand: HandState, items: readonly Item[], button: GrabButton): void {
    const set = this.held.get(hand) ?? new Set<Item>();
    for (const item of items) set.add(item);
    if (set.size > 0) this.held.set(hand, set);
    this.emit('grab', { hand, items, button });
  }

  notifyRelease(hand: HandState, button: GrabButton): void {
    const items = this.heldBy(hand);
    this.held.delete(hand);
    if (items.length > 0) this.emit('release', { hand, items, button });
  }

  /** セッションの終了などで、持っている状態をすべて忘れる (通知は出さない) */
  clearHeld(): void {
    this.held.clear();
  }

  private emit<K extends keyof ItemEvents>(event: K, payload: ItemEvents[K]): void {
    for (const listener of [...this.listeners[event]] as Listener<K>[]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[items] ${event} の処理に失敗しました`, error);
      }
    }
  }
}
