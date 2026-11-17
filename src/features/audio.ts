import * as THREE from 'three';
import type { Feature, FrameContext } from '../app';

interface Tone {
  /** 開始と終了の周波数 (Hz)。この間をなめらかに変化させる。 */
  from: number;
  to: number;
  duration: number;
  volume: number;
  type?: OscillatorType;
  /** 鳴り始めを遅らせる秒数 */
  delay?: number;
}

const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * 空間音響 (Web Audio API)。音源の位置と頭の姿勢を渡すと、その方向と距離から聞こえる。
 * WebXR の機能ではないが、頭の姿勢をそのまま AudioListener に渡すだけで MR と組み合わせられる。
 * 音は音声ファイルを使わず、オシレーターで合成している。
 */
export class Audio implements Feature {
  readonly name = 'audio';
  private context: AudioContext | null = null;

  /** ブラウザはユーザー操作なしに音を鳴らせないので、開始ボタンのクリックの中で呼ぶ。 */
  unlock(): void {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  update(ctx: FrameContext): void {
    const listener = this.context?.listener;
    if (!listener) return;
    const { x, y, z } = ctx.headPosition;
    _forward.set(0, 0, -1).applyQuaternion(ctx.headQuaternion);
    _up.set(0, 1, 0).applyQuaternion(ctx.headQuaternion);
    if (listener.positionX) {
      listener.positionX.value = x;
      listener.positionY.value = y;
      listener.positionZ.value = z;
      listener.forwardX.value = _forward.x;
      listener.forwardY.value = _forward.y;
      listener.forwardZ.value = _forward.z;
      listener.upX.value = _up.x;
      listener.upY.value = _up.y;
      listener.upZ.value = _up.z;
    } else {
      // 古い実装向け
      listener.setPosition(x, y, z);
      listener.setOrientation(_forward.x, _forward.y, _forward.z, _up.x, _up.y, _up.z);
    }
  }

  /** 物がぶつかった音。速いほど大きい。 */
  impact(position: THREE.Vector3, speed: number, kind: 'ball' | 'block'): void {
    const volume = THREE.MathUtils.clamp(speed / 5, 0.05, 1);
    if (kind === 'ball') this.play(position, { from: 220, to: 90, duration: 0.14, volume });
    else this.play(position, { from: 130, to: 60, duration: 0.09, volume, type: 'triangle' });
  }

  /** メニューのボタンを押した音 */
  click(position: THREE.Vector3): void {
    this.play(position, { from: 900, to: 700, duration: 0.05, volume: 0.25 });
  }

  /** 物を置いた / ポータルを開いた音 */
  chime(position: THREE.Vector3): void {
    this.play(position, { from: 660, to: 660, duration: 0.18, volume: 0.3 });
    this.play(position, { from: 990, to: 990, duration: 0.3, volume: 0.3, delay: 0.09 });
  }

  private play(position: THREE.Vector3, tone: Tone): void {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    const start = context.currentTime + (tone.delay ?? 0);
    const stop = start + tone.duration;

    const oscillator = new OscillatorNode(context, { type: tone.type ?? 'sine', frequency: tone.from });
    oscillator.frequency.exponentialRampToValueAtTime(tone.to, stop);
    const gain = new GainNode(context, { gain: 0 });
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(tone.volume, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);
    // HRTF は、頭の形による聞こえ方の違いを再現して、ヘッドホンでも方向が分かるようにする方式。
    const panner = new PannerNode(context, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 0.6,
      rolloffFactor: 1.2,
      positionX: position.x,
      positionY: position.y,
      positionZ: position.z,
    });
    oscillator.connect(gain).connect(panner).connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(stop + 0.02);
  }
}
