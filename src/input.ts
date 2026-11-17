import * as THREE from 'three';
import type { Feature, FrameContext } from './app';

export type Handedness = 'left' | 'right';
export type InputEvent = 'selectstart' | 'selectend' | 'squeezestart' | 'squeezeend';
type Listener = (hand: HandState) => void;

/** 速度の計算に使う、直近の位置の記録期間 (秒) */
const VELOCITY_WINDOW = 0.1;
/**
 * 素手で「握っている」とみなす、指の伸び具合 (付け根から先端の直線距離 / 指の長さ。まっすぐなら 1)。
 * 人差し指から小指までの 4 本すべてが START を下回ったら握り始め、どれかが END を超えたら離したとみなす。
 * つまむときは人差し指があまり曲がらないので、4 本とも見ることで、つまみと握りを区別する。
 */
const GRASP_START = 0.62;
const GRASP_END = 0.78;
const GRASP_FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

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
  /** 素手: 手全体で握っている / コントローラー: グリップボタンを握っている */
  squeezing = false;
  /** 素手のとき、人差し指から小指のうち、いちばん伸びている指の伸び具合 (まっすぐなら 1) */
  fingerExtension = 1;

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
  /** 手のひらが向いている方向 (手のひらから外へ出る向き) */
  readonly palmNormal = new THREE.Vector3(0, -1, 0);
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
      // 手の関節の空間は、-Y が手のひらから外へ出る向きと決められている。
      this.palmNormal.set(0, -1, 0).applyQuaternion(this.grabQuaternion);
      this.updateFingerExtension(frame, source.hand, refSpace);
    } else {
      const gripPose = source.gripSpace ? frame.getPose(source.gripSpace, refSpace) : null;
      const transform = (gripPose ?? rayPose).transform;
      copyPosition(this.grabPosition, transform.position);
      copyQuaternion(this.grabQuaternion, transform.orientation);
      this.tipPosition.copy(this.rayOrigin);
      // gripSpace は X 軸が手のひらに垂直。握ったとき、左手のひらは +X、右手のひらは -X を向く。
      this.palmNormal.set(this.handedness === 'left' ? 1 : -1, 0, 0).applyQuaternion(this.grabQuaternion);
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
    this.fingerExtension = 1;
    this.history.length = 0;
    this.velocity.set(0, 0, 0);
  }

  /** 関節が 1 つでも取れなければ、前の値を保つ。 */
  private updateFingerExtension(frame: XRFrame, hand: XRHand, refSpace: XRReferenceSpace): void {
    let extension = 0;
    for (const finger of GRASP_FINGERS) {
      const proximal = getJointPose(frame, hand, `${finger}-phalanx-proximal`, refSpace);
      const intermediate = getJointPose(frame, hand, `${finger}-phalanx-intermediate`, refSpace);
      const distal = getJointPose(frame, hand, `${finger}-phalanx-distal`, refSpace);
      const tip = getJointPose(frame, hand, `${finger}-tip`, refSpace);
      if (!proximal || !intermediate || !distal || !tip) return;
      const base = copyPosition(_a, proximal.transform.position);
      const middle = copyPosition(_b, intermediate.transform.position);
      const far = copyPosition(_c, distal.transform.position);
      const end = copyPosition(_d, tip.transform.position);
      const length = base.distanceTo(middle) + middle.distanceTo(far) + far.distanceTo(end);
      if (length < 1e-4) return;
      extension = Math.max(extension, base.distanceTo(end) / length);
    }
    this.fingerExtension = extension;
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
      // 素手には squeeze のイベントがないので、手全体で握る動きを指の曲がり具合から読んで、同じ通知にする。
      // 手を見失っている間は判定しない (握ったまま視界の外へ出ても、持っている物を落とさない)。
      if (hand.isHand && hand.tracked) {
        if (hand.squeezing) {
          if (hand.fingerExtension > GRASP_END) this.setSqueezing(hand, false);
        } else if (hand.fingerExtension < GRASP_START && !hand.selecting) {
          // つまんでいる手は、握りとしては扱わない。1 つの動きで 2 つの操作が起きないようにする。
          this.setSqueezing(hand, true);
        }
      }
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

export function getJointPose(
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
