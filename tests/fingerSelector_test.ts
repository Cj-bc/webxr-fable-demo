import assert from 'node:assert/strict';
import { Scene, Vector3 } from 'three';
import type { FrameContext } from '../src/app.ts';
import { FingerSelector } from '../src/features/fingerSelector.ts';
import { Input } from '../src/input.ts';
import { Tools } from '../src/tools.ts';

Deno.test('finger selection requires an open hand and absorbs the selection pinch', () => {
  const input = new Input();
  const hand = input.left;
  const tools = new Tools(input);
  const scene = new Scene();
  const selector = new FingerSelector(scene, hand, tools);
  for (const id of ['ball', 'block', 'place', 'draw', 'portal']) {
    tools.register({ id, label: id, hint: '', onSelectStart() {} });
  }

  const canvasContext = {
    clearRect() {}, beginPath() {}, roundRect() {}, fill() {}, fillText() {},
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: () => canvasContext }) },
  });

  try {
    const ctx = { headPosition: new Vector3(0, 1, 1) } as FrameContext;
    hand.tracked = hand.fingertipsTracked = true;
    hand.palmNormal.y = 1;
    const open = () => {
      hand.thumbTip.position.set(-0.05, 0, 0);
      hand.fingertips.forEach((tip, i) => {
        tip.position.set(i * 0.03, 0, 0);
        tip.extension = 1;
      });
    };
    open();

    selector.update(ctx);
    assert.equal(scene.children.length, 0);
    selector.setEnabled(true);

    // すでに触れている指では開始しない。
    hand.thumbTip.position.copy(hand.fingertips[0].position);
    selector.update(ctx);
    assert.equal(selector.interceptSelect(hand), false);
    assert.equal(tools.active?.id, 'ball');

    open();
    selector.update(ctx);
    assert.equal(scene.children.filter((child) => child.visible).length, 4);
    assert.equal(selector.interceptSelect(input.right), false);
    assert.equal(selector.interceptSelect(hand), true);

    hand.thumbTip.position.copy(hand.fingertips[0].position);
    hand.fingertips[0].extension = 0.6;
    hand.selecting = true;
    selector.update(ctx);
    assert.equal(tools.active?.id, 'block');
    assert.equal(selector.interceptSelect(hand), true);
    assert.equal(scene.children.some((child) => child.visible), false);
    selector.update(ctx);
    assert.equal(tools.active?.id, 'block');

    hand.selecting = false;
    open();
    selector.update(ctx);
    hand.thumbTip.position.copy(hand.fingertips[3].position);
    selector.update(ctx);
    assert.equal(tools.active?.id, 'portal');

    hand.fingertipsTracked = false;
    selector.update(ctx);
    assert.equal(selector.interceptSelect(hand), false);
    assert.equal(scene.children.some((child) => child.visible), false);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
