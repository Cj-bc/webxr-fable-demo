import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert';
import { crushAmount, reachedMin } from '../src/interactions/strategies/d1-shrink.ts';

Deno.test('D1: 最小の大きさに届くまでは潰していない', () => {
  // 大きさ 1、最小 0.25: 距離が 1/4 になるまでは 0
  assertEquals(crushAmount(0.4, 0.2, 1, 0.25), 0);
  assertEquals(crushAmount(0.4, 0.1, 1, 0.25), 0);
});

Deno.test('D1: 最小より先に縮めた分だけ量が増える', () => {
  assertAlmostEquals(crushAmount(0.4, 0.05, 1, 0.25), 0.5);
  assertAlmostEquals(crushAmount(0.4, 0.02, 1, 0.4), 0.875, 1e-9);
});

Deno.test('D1: 開始時の大きさが小さければ、すぐ潰す側になる', () => {
  assertAlmostEquals(crushAmount(0.2, 0.1, 0.3, 0.4), 0.625);
});

Deno.test('D1: 最小に達したかの判定と戻りの余裕', () => {
  assertEquals(reachedMin(0.4, 0.1, 1, 0.25), true);
  assertEquals(reachedMin(0.4, 0.104, 1, 0.25), false);
  assertEquals(reachedMin(0.4, 0.104, 1, 0.25, true), true);
});
