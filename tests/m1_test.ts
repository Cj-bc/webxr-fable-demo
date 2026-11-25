import { assertEquals } from 'jsr:@std/assert';
import { buttonAt, isPalmUp, layoutButtons } from '../src/interactions/strategies/m1-held-menu.ts';

Deno.test('isPalmUp はヒステリシスを持つ', () => {
  const mid = Math.cos((57 * Math.PI) / 180); // 出す閾値 (50 度) と隠す閾値 (65 度) の間
  assertEquals(isPalmUp(mid, false), false);
  assertEquals(isPalmUp(mid, true), true);
  assertEquals(isPalmUp(1, false), true);
  assertEquals(isPalmUp(0, true), false);
});

Deno.test('buttonAt はボタンの中だけを返す', () => {
  const buttons = layoutButtons(2, 400);
  assertEquals(buttonAt(buttons, buttons[0].x + 5, buttons[0].y + 5), 0);
  assertEquals(buttonAt(buttons, buttons[1].x + 5, buttons[1].y + 5), 1);
  assertEquals(buttonAt(buttons, 1, 1), -1);
  assertEquals(buttonAt(buttons, buttons[0].x + 5, buttons[0].y + buttons[0].height + 2), -1);
});
