import assert from 'node:assert/strict';
import { ToolSelector } from '../src/tools.ts';

Deno.test('tool selection tracks registered tools and notifies listeners', () => {
  const selector = new ToolSelector();
  const changes: (string | null)[] = [];
  selector.onChange(() => changes.push(selector.active?.id ?? null));
  const ball = { id: 'ball', label: 'Ball', hint: '', onSelectStart() {} };
  const block = { id: 'block', label: 'Block', hint: '', onSelectStart() {} };

  assert.deepEqual(selector.list, []);
  assert.equal(selector.active, null);

  selector.register(ball);
  selector.register(block);
  assert.deepEqual(selector.list, [ball, block]);
  assert.equal(selector.active, ball);

  selector.setActive(block);
  selector.setActive({ ...ball });
  assert.equal(selector.active, block);
  assert.deepEqual(changes, ['ball', 'ball', 'block']);
});
