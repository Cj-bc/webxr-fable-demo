import { assertEquals } from 'jsr:@std/assert';
import { newPinchState, stepPinch } from '../src/interactions/strategies/d1-shrink.ts';

const DT = 1 / 72;

/** 間隔の列 (m) を 1 フレームずつ流し、各フレームの結果を返す */
function run(distances: number[]) {
  const state = newPinchState();
  return distances.map((d) => stepPinch(state, d, DT));
}
const repeat = (value: number, seconds: number) => Array<number>(Math.ceil(seconds / DT)).fill(value);

// 実機の再現: 素手で持ち始め 20 cm から 6 cm まで寄せても、予告も削除も起きなかった。
Deno.test('D1: 持ち始め 20 cm から 6 cm まで寄せたら、すぐ予告が出て、保てば消える', () => {
  const results = run([0.2, 0.15, 0.1, 0.08, 0.06]);
  assertEquals(results[3].warn > 0, true);
  assertEquals(results[4].warn > 0, true);
  const hold = run([0.2, ...repeat(0.06, 1)]);
  assertEquals(hold.some((r) => r.done), true);
});

Deno.test('D1: 6 cm を保つ時間が足りなければ消えない', () => {
  assertEquals(run([0.2, ...repeat(0.06, 0.5)]).some((r) => r.done), false);
});

Deno.test('D1: 予告中に間隔を広げれば取りやめ、保つ時間もやり直しになる', () => {
  const results = run([0.2, ...repeat(0.06, 0.6), 0.12, ...repeat(0.06, 0.6)]);
  assertEquals(results.some((r) => r.done), false);
  // 広げたフレームでは予告が出ない
  assertEquals(results[1 + Math.ceil(0.6 / DT)].warn, 0);
});

Deno.test('D1: 認識の揺れで 1 フレーム 8 cm に広がっても保つ時間は続く', () => {
  const results = run([0.2, ...repeat(0.06, 0.5), 0.08, ...repeat(0.06, 0.5)]);
  assertEquals(results.some((r) => r.done), true);
});

Deno.test('D1: 近い状態で持ち始めた場合は、いったん広げるまで発動しない', () => {
  assertEquals(run(repeat(0.06, 2)).every((r) => r.warn === 0 && !r.done), true);
  assertEquals(run([0.06, 0.2, ...repeat(0.06, 1)]).some((r) => r.done), true);
});

Deno.test('D1: 10 cm 以上では予告も削除もない', () => {
  assertEquals(run([0.2, ...repeat(0.1, 3)]).every((r) => r.warn === 0 && !r.done), true);
});
