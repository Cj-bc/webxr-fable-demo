import * as THREE from 'three';
import type { Item, Items } from '../items';

/** メニュー系の操作 (M1 ～ M3) が並べる、持っている物への操作 */
export interface ItemAction {
  id: 'delete' | 'duplicate';
  label: string;
  /** targets: 対象の物 (ふつうは items.heldBy(hand))。結果の物 (複製なら複製、削除なら空) を返す。 */
  run(items: Items, targets: readonly Item[]): Item[];
}

/** メニューから複製したときに、複製を元からずらす距離 (m) */
const DUPLICATE_OFFSET = 0.12;
const _position = new THREE.Vector3();

export const DELETE_ACTION: ItemAction = {
  id: 'delete',
  label: '消す',
  run(items, targets) {
    for (const item of targets) items.remove(item);
    return [];
  },
};

/** 複製を元の少し上に置く。持っている物でも、複製は持たれていない状態で現れる。 */
export const DUPLICATE_ACTION: ItemAction = {
  id: 'duplicate',
  label: '複製',
  run(items, targets) {
    const copies: Item[] = [];
    for (const item of targets) {
      const copy = items.duplicate(item);
      if (!copy) continue;
      _position.copy(copy.object.position);
      _position.y += DUPLICATE_OFFSET;
      copy.setPose(_position, copy.object.quaternion);
      copies.push(copy);
    }
    return copies;
  },
};

export const ITEM_ACTIONS: readonly ItemAction[] = [DELETE_ACTION, DUPLICATE_ACTION];
