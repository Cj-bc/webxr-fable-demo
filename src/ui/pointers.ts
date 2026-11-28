import type { Vector3 } from 'three';
import type { HandState } from '../input';
import type { PanelPoint } from './canvasPanel';

export type PointerQuery =
  | { kind: 'poke'; position: Vector3 }
  | { kind: 'ray'; origin: Vector3; direction: Vector3 };

export interface PointerHit {
  distance: number;
  panelPoint?: PanelPoint;
  position?: Vector3;
  normal?: Vector3;
}

export interface PointerEvent {
  kind: 'down' | 'move' | 'up' | 'cancel';
  id: string;
  hand: HandState;
  query: PointerQuery;
  hit: PointerHit | null;
}

export interface PointerTarget {
  hitTest(query: PointerQuery, hand: HandState): PointerHit | null;
  onPointer(event: PointerEvent): void;
}

export interface PointerMethod {
  readonly id: string;
  update(hand: HandState, dispatcher: PointerDispatcher): void;
  select?(hand: HandState, dispatcher: PointerDispatcher): boolean;
  reset(): void;
}

export class PointerDispatcher {
  private readonly targets = new Set<PointerTarget>();
  private readonly captures = new Map<string, { target: PointerTarget; event: PointerEvent }>();

  register(target: PointerTarget): () => void {
    this.targets.add(target);
    return () => {
      this.targets.delete(target);
      for (const [id, capture] of this.captures) {
        if (capture.target === target) this.cancel(id);
      }
    };
  }

  find(query: PointerQuery, hand: HandState) {
    let nearest: { target: PointerTarget; hit: PointerHit } | null = null;
    for (const target of this.targets) {
      const hit = target.hitTest(query, hand);
      if (hit && (!nearest || Math.abs(hit.distance) < Math.abs(nearest.hit.distance))) {
        nearest = { target, hit };
      }
    }
    return nearest;
  }

  send(event: PointerEvent, target?: PointerTarget): void {
    if (event.kind === 'down' && target) {
      this.cancel(event.id);
      this.captures.set(event.id, { target, event });
      target.onPointer(event);
      return;
    }
    const capture = this.captures.get(event.id);
    if (!capture) return;
    if (event.kind === 'up' || event.kind === 'cancel') this.captures.delete(event.id);
    else capture.event = event;
    capture.target.onPointer(event);
  }

  cancel(id: string): void {
    const capture = this.captures.get(id);
    if (capture) this.send({ ...capture.event, kind: 'cancel', hit: null });
  }

  cancelMethod(id: string): void {
    for (const key of this.captures.keys()) {
      if (key.startsWith(id + ':')) this.cancel(key);
    }
  }

  move(id: string, hand: HandState, query: PointerQuery, kind: 'move' | 'up'): void {
    const capture = this.captures.get(id);
    if (!capture) return;
    this.send({ id, hand, query, kind, hit: capture.target.hitTest(query, hand) });
  }
}

export class PokePointer implements PointerMethod {
  readonly id = 'poke';
  private readonly armed = new Map<HandState, boolean>();
  private readonly pressed = new Set<HandState>();

  update(hand: HandState, dispatcher: PointerDispatcher): void {
    const id = this.id + ':' + hand.handedness;
    if (!hand.tracked) {
      dispatcher.cancel(id);
      this.armed.delete(hand);
      this.pressed.delete(hand);
      return;
    }
    const query = { kind: 'poke', position: hand.tipPosition } as const;
    const result = dispatcher.find(query, hand);
    const distance = result?.hit.distance;
    if (this.pressed.has(hand)) {
      const released = distance === undefined || distance > 0.02;
      dispatcher.move(id, hand, query, released ? 'up' : 'move');
      if (!released) return;
      this.pressed.delete(hand);
    }
    if (distance === undefined || distance > 0.02) {
      this.armed.set(hand, true);
    } else if (result && distance < 0.005 && distance > -0.04 && this.armed.get(hand)) {
      this.armed.set(hand, false);
      this.pressed.add(hand);
      dispatcher.send({ kind: 'down', id, hand, query, hit: result.hit }, result.target);
    }
  }

  reset(): void {
    this.armed.clear();
    this.pressed.clear();
  }
}

export class RayPointer implements PointerMethod {
  readonly id = 'ray';

  private query(hand: HandState): PointerQuery {
    return { kind: 'ray', origin: hand.rayOrigin, direction: hand.rayDirection };
  }

  select(hand: HandState, dispatcher: PointerDispatcher): boolean {
    if (!hand.tracked) return false;
    const query = this.query(hand);
    const result = dispatcher.find(query, hand);
    if (!result || result.hit.distance > 2) return false;
    dispatcher.send({ kind: 'down', id: this.id + ':' + hand.handedness, hand, query, hit: result.hit }, result.target);
    return true;
  }

  update(hand: HandState, dispatcher: PointerDispatcher): void {
    const id = this.id + ':' + hand.handedness;
    if (!hand.tracked) dispatcher.cancel(id);
    else dispatcher.move(id, hand, this.query(hand), hand.selecting ? 'move' : 'up');
  }

  reset(): void {}
}
