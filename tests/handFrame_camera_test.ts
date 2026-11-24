import assert from 'node:assert/strict';
import { Scene } from 'three';
import type { App } from '../src/app.ts';
import { type CameraState, HandFrame } from '../src/features/handFrame.ts';

function replaceProperty(target: object, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  return {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    },
  };
}

function createHandFrame() {
  return new HandFrame({
    scene: new Scene(),
    menu: { addToggle() {} },
    tools: { addInterceptor() {} },
    onClear() {},
    persistence: { register() {} },
  } as unknown as App);
}

Deno.test('startCamera keeps the acquired stream running when enumerateDevices rejects', async () => {
  const track = Object.assign(new EventTarget(), {
    stopped: false,
    stop() { this.stopped = true; },
    getSettings: () => ({ deviceId: 'camera-a' }),
  });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const calls: string[] = [];
  using _media = replaceProperty(navigator, 'mediaDevices', {
    async getUserMedia() {
      calls.push('getUserMedia');
      return stream;
    },
    async enumerateDevices() {
      calls.push('enumerateDevices');
      throw new DOMException('Device list unavailable', 'NotReadableError');
    },
  });
  const video = { srcObject: null, async play() {}, pause() {}, remove() {} };
  using _document = replaceProperty(globalThis, 'document', { createElement: () => video });
  using _window = replaceProperty(globalThis, 'window', new EventTarget());
  const frame = createHandFrame();
  const states: CameraState[] = [];
  frame.onCameraChange = (state) => states.push(state);
  try {
    await frame.startCamera();
    assert.deepEqual(calls, ['getUserMedia', 'enumerateDevices']);
    assert.deepEqual(states.map((s) => s.kind), ['requesting', 'running']);
    const running = states[1];
    assert(running.kind === 'running');
    assert.strictEqual(running.info.video.srcObject, stream);
    assert.equal(track.stopped, false);
  } finally {
    frame.stopCamera('user');
  }
});

Deno.test('startCamera resolves without acquisition when a requesting observer stops it', async () => {
  let acquisitions = 0;
  using _media = replaceProperty(navigator, 'mediaDevices', {
    getUserMedia() {
      acquisitions++;
      return new Promise(() => {});
    },
  });
  using _window = replaceProperty(globalThis, 'window', new EventTarget());
  const frame = createHandFrame();
  const states: CameraState[] = [];
  frame.onCameraChange = (state) => {
    states.push(state);
    if (state.kind === 'requesting') frame.stopCamera('user');
  };
  try {
    let resolved = false;
    const started = frame.startCamera().then(() => { resolved = true; });
    // 次のタスクまでに Promise の継続がすべて走る。許可ダイアログの応答は待たない。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(states, [{ kind: 'requesting' }, { kind: 'stopped', reason: 'user' }]);
    assert.deepEqual({ acquisitions, resolved }, { acquisitions: 0, resolved: true });
    await started;
  } finally {
    frame.stopCamera('user');
  }
});
