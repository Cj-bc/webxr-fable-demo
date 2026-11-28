import { Vector3 } from 'three';
import type { HandState } from '../input';
import type { Items } from '../items';

/** 視点から両指先に伸ばしたレイを両端とする円錐。指先より奥だけを調べる。 */
export function fingerGapTargets(items: Items, eye: Vector3, hand: HandState) {
  const index = new Vector3().subVectors(hand.tipPosition, eye);
  const thumb = new Vector3().subVectors(hand.thumbTip.position, eye);
  const near = Math.max(index.length(), thumb.length());
  const axis = index.normalize().add(thumb.normalize()).normalize();
  const edge = axis.dot(index);
  if (edge <= 0 || edge >= 0.99995) return [];
  const offset = new Vector3();
  return items.all.flatMap((item) => {
    if (items.holdersOf(item).length) return [];
    offset.subVectors(item.object.position, eye);
    const distance = offset.length();
    const alignment = axis.dot(offset) / distance;
    return distance > near && distance <= 6 && alignment >= edge
      ? [{ item, alignment, distance }] : [];
  }).sort((a, b) => b.alignment - a.alignment || a.distance - b.distance).map(({ item }) => item);
}
