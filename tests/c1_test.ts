import assert from 'node:assert/strict';
import { HOLD_WINDOW, judgePull, PULL_DISTANCE, PULL_SPEED } from '../src/interactions/strategies/c1-tear.ts';

Deno.test('速く十分離れたら引きちぎる', () => {
  assert.equal(judgePull(0.1, 0.2, 0.2 + PULL_DISTANCE + 0.01, PULL_SPEED + 0.1), 'tear');
});

Deno.test('ゆっくり広げる間は待ち、時間が来たら両手持ちにする', () => {
  assert.equal(judgePull(HOLD_WINDOW / 2, 0.2, 0.3, 0.2), 'wait');
  assert.equal(judgePull(HOLD_WINDOW, 0.2, 0.3, 0.2), 'two-hand');
});

Deno.test('距離が足りない、または速さが足りないと引きちぎらない', () => {
  assert.equal(judgePull(0.1, 0.2, 0.2 + PULL_DISTANCE / 2, PULL_SPEED * 2), 'wait');
  assert.equal(judgePull(0.1, 0.2, 0.2 + PULL_DISTANCE * 2, PULL_SPEED / 2), 'wait');
});

Deno.test('近づく動きでは引きちぎらない', () => {
  assert.equal(judgePull(HOLD_WINDOW, 0.3, 0.1, -2), 'two-hand');
});
