import { Vector3 } from 'three';
import type { HandState } from '../input';
import type { Items } from '../items';

/** 手のひらの正面にある物。手に持たれていない物を角度の近い順に返す。 */
export function palmTargets(items: Items, hand: HandState) {
  const offset = new Vector3();
  return items.all.flatMap((item) => {
    if (items.holdersOf(item).length) return [];
    offset.subVectors(item.object.position, hand.grabPosition);
    const distance = offset.length();
    if (distance < 0.3 || distance > 6) return [];
    const alignment = offset.dot(hand.palmNormal) / distance;
    return alignment >= 0.91 ? [{ item, alignment, distance }] : [];
  }).sort((a, b) => b.alignment - a.alignment || a.distance - b.distance).map(({ item }) => item);
}
