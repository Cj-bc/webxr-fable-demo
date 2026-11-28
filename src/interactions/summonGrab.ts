import { BoxHelper, Vector3 } from 'three';
import type { App, Feature, FrameContext } from '../app';
import type { HandState } from '../input';
import type { Item } from '../items';
import { NearGrab } from './grabMethods';
import { palmTargets } from './palmTargets';

interface Aim {
  item: Item;
  start: Vector3;
  direction: Vector3;
  time: number;
}

/** 手のひらを向けてから手前に引くと、物が手元まで来る。そこで普段どおり掴める。 */
export class SummonGrab extends NearGrab implements Feature {
  readonly name = 'summonGrab';
  private readonly aims = new Map<HandState, Aim>();
  private readonly flights = new Map<Item, HandState>();
  private readonly highlights = new Map<HandState, BoxHelper>();
  private readonly destination = new Vector3();

  constructor(private readonly app: App) {
    super();
  }

  update(ctx: FrameContext): void {
    const active = this.app.grabs.method === this;
    for (const hand of this.app.input.hands) {
      const canAim = active && hand.tracked && hand.isHand && !hand.selecting && !hand.squeezing
        && hand.fingerExtension > 0.8 && this.app.items.heldBy(hand).length === 0
        && ![...this.flights.values()].includes(hand);
      if (!canAim) {
        this.aims.delete(hand);
        this.show(hand);
        continue;
      }
      const aim = this.aims.get(hand);
      if (aim && ctx.time - aim.time < 0.65 && this.app.items.all.includes(aim.item)
          && !this.app.items.holdersOf(aim.item).length && !this.flights.has(aim.item)) {
        const travel = this.destination.subVectors(hand.grabPosition, aim.start);
        if (travel.dot(aim.direction) < -0.11 && travel.length() < 0.28) {
          this.flights.set(aim.item, hand);
          this.aims.delete(hand);
          this.show(hand);
          continue;
        }
        this.show(hand, aim.item);
        continue;
      }
      const item = palmTargets(this.app.items, hand).find((candidate) => !this.flights.has(candidate));
      if (item) {
        this.aims.set(hand, {
          item, start: hand.grabPosition.clone(), direction: hand.palmNormal.clone(), time: ctx.time,
        });
      } else this.aims.delete(hand);
      this.show(hand, item);
    }
    for (const [item, hand] of this.flights) {
      if (!hand.tracked || !this.app.items.all.includes(item) || this.app.items.holdersOf(item).length) {
        this.flights.delete(item);
        continue;
      }
      this.destination.copy(hand.grabPosition).addScaledVector(hand.palmNormal, 0.065);
      const step = this.destination.sub(item.object.position);
      const distance = step.length();
      if (distance <= 2.8 * ctx.dt) this.flights.delete(item);
      step.clampLength(0, 2.8 * ctx.dt).add(item.object.position);
      item.setPose(step, item.object.quaternion);
    }
  }

  private show(hand: HandState, item?: Item): void {
    let box = this.highlights.get(hand);
    if (!box && item) {
      box = new BoxHelper(item.object, 0x59e9ff);
      this.app.scene.add(box);
      this.highlights.set(hand, box);
    }
    if (!box) return;
    box.visible = !!item;
    if (item) box.setFromObject(item.object);
  }

  end(): void {
    this.aims.clear();
    this.flights.clear();
    for (const box of this.highlights.values()) {
      box.removeFromParent();
      box.dispose();
    }
    this.highlights.clear();
  }
}
