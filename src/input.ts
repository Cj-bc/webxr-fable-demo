import * as THREE from 'three';
import type { Feature, FrameContext } from './app';

export type Handedness = 'left' | 'right';
export type InputEvent = 'selectstart' | 'selectend' | 'squeezestart' | 'squeezeend';
type Listener = (hand: HandState) => void;

/** 速度の計算に使う、直近の位置の記録期間 (秒) */
const VELOCITY_WINDOW = 0.1;

/**
 * 片手ぶんの入力状態。素手 (ハンドトラッキング) とコントローラーの違いを吸収する。
 * 座標はすべて local-floor 参照空間 (= ワールド座標)。
 */
export class HandState {
  source: XRInputSource | null = null;
  /** このフレームで姿勢が取れたか */
  tracked = false;
  /** 素手なら true、コントローラーなら false */
  isHand = false;
  /** 素手: つまんでいる / コントローラー: トリガーを引いている */
  selecting = false;
  /** コントローラーのグリップボタンを握っている (素手では発生しない) */
  squeezing = false;

  /** 指し示すレイ (targetRaySpace) */
  readonly rayOrigin = new THREE.Vector3();
  readonly rayDirection = new THREE.Vector3(0, 0, -1);
  readonly rayQuaternion = new THREE.Quaternion();
  /** 物をつかむ位置。素手: 親指と人差し指の先の中点 / コントローラー: gripSpace */
  readonly grabPosition = new THREE.Vector3();
  /** つかんだ物の向きの基準。素手: 手首 / コントローラー: gripSpace */
  readonly grabQuaternion = new THREE.Quaternion();
  /** ボタンを押す・線を描く先端。素手: 人差し指の先 / コントローラー: レイの原点 */
  readonly tipPosition = new THREE.Vector3();
  /** grabPosition の速度 (m/s)。投げるときに使う。 */
  readonly velocity = new THREE.Vector3();

  private readonly history: { time: number; position: THREE.Vector3 }[] = [];

  constructor(readonly handedness: Handedness) {}

  /** コントローラーを振動させる。素手や非対応の場合は何もしない。 */
  pulse(intensity: number, durationMs: number): void {
    const actuator = this.source?.gamepad?.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, durationMs)?.catch(() => {});
  }

  /** @internal */
  updatePose(ctx: FrameContext): void {
    const { frame, refSpace } = ctx;
    const source = this.source;
    this.tracked = false;
    if (!source) return;

    const rayPose = frame.getPose(source.targetRaySpace, refSpace);
    if (!rayPose) return;
    copyPosition(this.rayOrigin, rayPose.transform.position);
    copyQuaternion(this.rayQuaternion, rayPose.transform.orientation);
    this.rayDirection.set(0, 0, -1).applyQuaternion(this.rayQuaternion);

    this.isHand = Boolean(source.hand);
    if (source.hand) {
      // XRHand は関節名 → XRJointSpace の Map。関節ごとに姿勢と半径が取れる。
      const indexTip = getJointPose(frame, source.hand, 'index-finger-tip', refSpace);
      const thumbTip = getJointPose(frame, source.hand, 'thumb-tip', refSpace);
      const wrist = getJointPose(frame, source.hand, 'wrist', refSpace);
      if (!indexTip || !thumbTip || !wrist) return;
      copyPosition(this.tipPosition, indexTip.transform.position);
      copyPosition(this.grabPosition, thumbTip.transform.position).add(this.tipPosition).multiplyScalar(0.5);
      copyQuaternion(this.grabQuaternion, wrist.transform.orientation);
    } else {
      const gripPose = source.gripSpace ? frame.getPose(source.gripSpace, refSpace) : null;
      const transform = (gripPose ?? rayPose).transform;
      copyPosition(this.grabPosition, transform.position);
      copyQuaternion(this.grabQuaternion, transform.orientation);
      this.tipPosition.copy(this.rayOrigin);
    }
    this.tracked = true;
    this.updateVelocity(ctx.time);
  }

  /** @internal */
  reset(): void {
    this.source = null;
    this.tracked = false;
    this.selecting = false;
    this.squeezing = false;
    this.history.length = 0;
    this.velocity.set(0, 0, 0);
  }

  private updateVelocity(time: number): void {
    const history = this.history;
    history.push({ time, position: this.grabPosition.clone() });
    while (history.length > 2 && time - history[0].time > VELOCITY_WINDOW) history.shift();
    const oldest = history[0];
    const elapsed = time - oldest.time;
    if (elapsed > 1e-4) {
      this.velocity.copy(this.grabPosition).sub(oldest.position).divideScalar(elapsed);
    }
  }
}

/**
 * XRSession の inputSources とイベントを、左右の HandState にまとめる。
 * three.js の getController() を使わず XRInputSource を直接読んでいるのは、
 * WebXR の入力 API がどういう形をしているかをコード上で追えるようにするため。
 */
export class Input implements Feature {
  readonly name = 'input';
  readonly left = new HandState('left');
  readonly right = new HandState('right');
  readonly hands: readonly HandState[] = [this.left, this.right];

  private readonly listeners: Record<InputEvent, Listener[]> = {
    selectstart: [],
    selectend: [],
    squeezestart: [],
    squeezeend: [],
  };
  private session: XRSession | null = null;

  on(event: InputEvent, listener: Listener): void {
    this.listeners[event].push(listener);
  }

  /** もう一方の手 */
  other(hand: HandState): HandState {
    return hand === this.left ? this.right : this.left;
  }

  start(session: XRSession): void {
    this.session = session;
    session.addEventListener('selectstart', this.handleSelectStart);
    session.addEventListener('selectend', this.handleSelectEnd);
    session.addEventListener('squeezestart', this.handleSqueezeStart);
    session.addEventListener('squeezeend', this.handleSqueezeEnd);
  }

  end(): void {
    const session = this.session;
    if (session) {
      session.removeEventListener('selectstart', this.handleSelectStart);
      session.removeEventListener('selectend', this.handleSelectEnd);
      session.removeEventListener('squeezestart', this.handleSqueezeStart);
      session.removeEventListener('squeezeend', this.handleSqueezeEnd);
    }
    this.session = null;
    for (const hand of this.hands) hand.reset();
  }

  update(ctx: FrameContext): void {
    for (const hand of this.hands) {
      // 素手とコントローラーを持ち替えると、同じ handedness の別の XRInputSource に入れ替わる。
      let current: XRInputSource | null = null;
      for (const source of ctx.session.inputSources) {
        if (source.handedness === hand.handedness) current = source;
      }
      if (current !== hand.source) {
        // 入れ替わりで selectend が届かないことがあるので、押しっぱなしを残さない。
        if (hand.selecting) this.setSelecting(hand, false);
        if (hand.squeezing) this.setSqueezing(hand, false);
        hand.reset();
        hand.source = current;
      }
      hand.updatePose(ctx);
    }
  }

  private handFor(event: XRInputSourceEvent): HandState | null {
    const handedness = event.inputSource.handedness;
    if (handedness !== 'left' && handedness !== 'right') return null;
    const hand = handedness === 'left' ? this.left : this.right;
    // update より先にイベントが来ることがあるので、ここでも source を合わせておく。
    hand.source ??= event.inputSource;
    return hand;
  }

  private setSelecting(hand: HandState, selecting: boolean): void {
    if (hand.selecting === selecting) return;
    hand.selecting = selecting;
    this.emit(selecting ? 'selectstart' : 'selectend', hand);
  }

  private setSqueezing(hand: HandState, squeezing: boolean): void {
    if (hand.squeezing === squeezing) return;
    hand.squeezing = squeezing;
    this.emit(squeezing ? 'squeezestart' : 'squeezeend', hand);
  }

  private emit(event: InputEvent, hand: HandState): void {
    for (const listener of this.listeners[event]) {
      try {
        listener(hand);
      } catch (error) {
        console.error(`[input] ${event} の処理に失敗しました`, error);
      }
    }
  }

  private readonly handleSelectStart = (event: XRInputSourceEvent): void => {
    const hand = this.handFor(event);
    if (hand) this.setSelecting(hand, true);
  };

  private readonly handleSelectEnd = (event: XRInputSourceEvent): void => {
    const hand = this.handFor(event);
    if (hand) this.setSelecting(hand, false);
  };

  private readonly handleSqueezeStart = (event: XRInputSourceEvent): void => {
    const hand = this.handFor(event);
    if (hand) this.setSqueezing(hand, true);
  };

  private readonly handleSqueezeEnd = (event: XRInputSourceEvent): void => {
    const hand = this.handFor(event);
    if (hand) this.setSqueezing(hand, false);
  };
}

function getJointPose(
  frame: XRFrame,
  hand: XRHand,
  joint: XRHandJoint,
  refSpace: XRReferenceSpace,
): XRJointPose | undefined {
  const space = hand.get(joint);
  return space ? frame.getJointPose?.(space, refSpace) : undefined;
}

export function copyPosition(target: THREE.Vector3, source: DOMPointReadOnly): THREE.Vector3 {
  return target.set(source.x, source.y, source.z);
}

export function copyQuaternion(target: THREE.Quaternion, source: DOMPointReadOnly): THREE.Quaternion {
  return target.set(source.x, source.y, source.z, source.w);
}
