import assert from 'node:assert/strict';
import { ShakeDetector } from '../src/interactions/strategies/c4-shake-split.ts';

/** 周波数 hz・振幅 amp (m) で x 方向に振ったときの速度を 60Hz で流し、最初に分裂した時刻を返す。 */
function shake(detector: ShakeDetector, hz: number, amp: number, seconds: number, start = 0): number | null {
  for (let t = 0; t < seconds; t += 1 / 60) {
    const v = amp * 2 * Math.PI * hz * Math.cos(2 * Math.PI * hz * t);
    if (detector.push(start + t, v, 0, 0)) return start + t;
  }
  return null;
}

Deno.test('小刻みに振り続けると分裂する', () => {
  const at = shake(new ShakeDetector(), 4, 0.05, 2);
  assert.notEqual(at, null);
  assert.ok(at! <= 1.2);
});

Deno.test('投げる前の振りかぶり (1 回の往復) では分裂しない', () => {
  // 0.5 秒かけて後ろへ引き、0.2 秒で前へ振り出す。
  const d = new ShakeDetector();
  let fired = false;
  for (let t = 0; t < 1; t += 1 / 60) {
    const v = t < 0.5 ? -1.5 : t < 0.7 ? 4 : 0;
    fired ||= d.push(t, v, 0, 0);
  }
  assert.equal(fired, false);
});

Deno.test('遅い往復は数えない', () => {
  assert.equal(shake(new ShakeDetector(), 4, 0.01, 3), null);
});

Deno.test('ゆっくりした往復 (1 秒に 1 回) は時間窓に収まらず分裂しない', () => {
  assert.equal(shake(new ShakeDetector(), 1, 0.3, 6), null);
});

Deno.test('reset のあとは数え直す', () => {
  const d = new ShakeDetector();
  assert.notEqual(shake(d, 4, 0.05, 2), null);
  d.reset();
  assert.equal(d.progress, 0);
});

Deno.test('途中の進み具合を返す', () => {
  const d = new ShakeDetector();
  shake(d, 4, 0.05, 0.4);
  assert.ok(d.progress > 0 && d.progress < 1);
});
