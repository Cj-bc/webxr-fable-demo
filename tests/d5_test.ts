import assert from 'node:assert/strict';
import { sinkPose, stepDwell } from '../src/interactions/strategies/d5-sink.ts';

Deno.test('D5: 床に触れている間だけ進み、外れたらやり直す', () => {
  let p = 0;
  for (let i = 0; i < 10; i++) p = stepDwell(p, true, 0.1);
  assert.ok(p > 0 && p < 1);
  assert.equal(stepDwell(p, false, 0.1), 0);
  assert.equal(stepDwell(0.99, true, 1), 1);
});

Deno.test('D5: 沈むほど深く小さくなる', () => {
  assert.deepEqual(sinkPose(0), { depth: 0, scale: 1 });
  const end = sinkPose(1);
  assert.equal(end.depth, 1);
  assert.ok(end.scale < 0.5);
  assert.ok(sinkPose(0.5).depth < sinkPose(0.8).depth);
});