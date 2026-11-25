import assert from 'node:assert/strict';
import { menuAxes, pickDirection } from '../src/interactions/strategies/m2-radial-menu.ts';

const THRESHOLD = 0.06;

Deno.test('頭が +Z 側にあると、面の右は +X、上は +Y', () => {
  const axes = menuAxes({ x: 0, y: 1, z: 0 }, { x: 0, y: 1.6, z: 1 });
  assert.deepEqual(axes.right, { x: 1, y: 0, z: -0 });
  assert.deepEqual(axes.up, { x: 0, y: 1, z: 0 });
  assert.deepEqual(axes.normal, { x: 0, y: 0, z: 1 });
});

Deno.test('頭が -X 側にあると、面の右は +Z', () => {
  const axes = menuAxes({ x: 0, y: 1, z: 0 }, { x: -2, y: 1.6, z: 0 });
  assert.ok(Math.abs(axes.right.x) < 1e-9);
  assert.equal(axes.right.z, 1);
});

Deno.test('頭が真上にあっても軸は有限', () => {
  const axes = menuAxes({ x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 });
  assert.deepEqual(axes.normal, { x: 0, y: 0, z: 1 });
});

const axes = menuAxes({ x: 0, y: 1, z: 0 }, { x: 0, y: 1.6, z: 1 });
const pick = (x: number, y: number, z = 0) => pickDirection({ x, y, z }, axes.right, axes.up, THRESHOLD);

Deno.test('動かさなければ何も選ばれない', () => {
  assert.equal(pick(0, 0), null);
  assert.equal(pick(0.03, -0.03), null);
});

Deno.test('上下左右へ閾値以上動かすとその方向', () => {
  assert.equal(pick(0.1, 0), 'right');
  assert.equal(pick(-0.1, 0), 'left');
  assert.equal(pick(0, 0.1), 'up');
  assert.equal(pick(0, -0.1), 'down');
});

Deno.test('斜めは動きの大きい軸を選ぶ', () => {
  assert.equal(pick(0.08, 0.05), 'right');
  assert.equal(pick(0.05, 0.08), 'up');
});

Deno.test('面に垂直な手前・奥の動きは無視する', () => {
  assert.equal(pick(0, 0, 0.5), null);
  assert.equal(pick(0, 0.1, -0.5), 'up');
});

Deno.test('閾値の境界: 手前では null、ちょうどで選ばれる', () => {
  assert.equal(pick(THRESHOLD - 1e-6, 0), null);
  assert.equal(pick(THRESHOLD, 0), 'right');
});
