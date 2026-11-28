import type { HandState } from '../input';
import type { GrabButton } from '../items';

export type GrabAttempt = (hand: HandState, button: GrabButton) => boolean;

export interface GrabMethod {
  tryBegin(hand: HandState, button: GrabButton, near: readonly GrabAttempt[]): boolean;
}

export class NearGrab implements GrabMethod {
  tryBegin(hand: HandState, button: GrabButton, near: readonly GrabAttempt[]): boolean {
    return near.some((attempt) => attempt(hand, button));
  }
}

export class GrabMethods {
  method: GrabMethod = new NearGrab();
  private readonly near: GrabAttempt[] = [];

  register(attempt: GrabAttempt): void {
    this.near.push(attempt);
  }

  tryBegin(hand: HandState, button: GrabButton): boolean {
    return this.method.tryBegin(hand, button, this.near);
  }
}
