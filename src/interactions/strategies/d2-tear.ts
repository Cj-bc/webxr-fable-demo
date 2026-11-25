// D2 写真を破る: 両手で持った写真を、片手は手前・もう片手は奥へ素早く逆向きに動かすと、左右 2 枚に破れて落ちて消える。
import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

/** 両手を結ぶ線に垂直な、互いに逆向きの相対速度がこれ以上 (m/s)。両手で拡大縮小・回転する普通の動きは 0.5 m/s 未満に収まるので、その倍以上の素早さを要求する。 */
export const TEAR_RELATIVE_SPEED = 0.8;
/** 破るとき、各手がそれぞれ出していなければならない垂直方向の速さ (m/s)。片手だけを振っても (もう片手がほぼ止まったままでも) 破れない。 */
export const TEAR_EACH_HAND_SPEED = 0.25;
/** 線に沿った相対速度 (拡大縮小) が、垂直な相対速度のこの割合を超えたら、引き伸ばしと見なして破らない。 */
export const TEAR_MAX_ALONG_RATIO = 0.5;
/** 上の条件を満たし続ける時間 (秒)。手の速度は 1 フレームだけ跳ねることがあるので、少し続いたときだけ破る。 */
export const TEAR_SUSTAIN = 0.05;
/** 片手のつまみが外れてから、直前まで両手で持っていた写真を破る対象に残す時間 (秒)。素手は速く動かすと握りが外れやすいため。 */
export const TEAR_GRACE = 0.15;
/** 手の速度を測り直す時間幅 (秒)。HandState.velocity は 0.1 秒の平均で、素早い動きが小さく出るので、この案では短い幅でも測り、大きい方を使う。 */
const SHORT_VELOCITY_WINDOW = 0.04;
/**
 * 回転との区別。垂直・逆向きの動きは、写真をゆっくり回すときにも出る。
 * 破る動きは一気に立ち上がるので、この速さ (m/s) 以上、破る閾値未満の動きが SLOW_RAMP_LIMIT 秒を超えて続いたら
 * 「回している」と見なし、動きがこの速さを下回るまで破らない。
 */
const SLOW_RAMP_SPEED = 0.3;
const SLOW_RAMP_LIMIT = 0.5;
/** 破れそうなとき、写真に入る裂け目の最大の長さ (写真の高さに対する割合) */
const CRACK_MAX_RATIO = 0.9;
/** 破れてから消えるまでの時間 (秒) */
const FALL_DURATION = 0.9;
/** 破片が左右へ離れる速さ (m/s、写真の大きさに対する倍率前) */
const SPREAD_SPEED = 0.18;
/** 破片が落ちる加速度 (m/s^2)。実際の重力より弱めにして、ひらひら落ちる見た目にする */
const FALL_GRAVITY = 3;
/** 破片が回る速さ (rad/s)。左右で逆向きに回す */
const SPIN_SPEED = 1.4;

const _axis = new THREE.Vector3();
const _vl = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _dir = new THREE.Vector3();

export interface TearMetrics {
  /** 両手を結ぶ線に垂直な、相対速度の大きさ (m/s) */
  perp: number;
  /** 線に沿った相対速度の大きさ (m/s)。拡大縮小の速さ */
  along: number;
  /** 相対運動の向きに対して、右手は正方向・左手は負方向へ動いた速さのうち、小さい方。逆向きに動いていなければ負になる。 */
  eachMin: number;
}

/** 両手を結ぶ線に垂直な、互いに逆向きの動きの量を測る (純粋な計算)。手が重なっていて線が決まらなければ null。 */
export function measureTear(
  leftPos: THREE.Vector3,
  rightPos: THREE.Vector3,
  leftVel: THREE.Vector3,
  rightVel: THREE.Vector3,
): TearMetrics | null {
  _axis.subVectors(rightPos, leftPos);
  if (_axis.lengthSq() < 1e-6) return null;
  _axis.normalize();
  // 各手の速度から、線に沿った成分を引いて垂直成分にする
  _vl.copy(leftVel).addScaledVector(_axis, -leftVel.dot(_axis));
  _vr.copy(rightVel).addScaledVector(_axis, -rightVel.dot(_axis));
  _rel.subVectors(_vr, _vl);
  const perp = _rel.length();
  const along = Math.abs(_dir.subVectors(rightVel, leftVel).dot(_axis));
  if (perp < 1e-6) return { perp, along, eachMin: 0 };
  _dir.copy(_rel).divideScalar(perp);
  return { perp, along, eachMin: Math.min(_vr.dot(_dir), -_vl.dot(_dir)) };
}

/** 破る動きか。互いに逆向きで十分速く、線に沿った動き (拡大縮小) より支配的であること。 */
export function isTearingMotion(
  leftPos: THREE.Vector3,
  rightPos: THREE.Vector3,
  leftVel: THREE.Vector3,
  rightVel: THREE.Vector3,
): boolean {
  const m = measureTear(leftPos, rightPos, leftVel, rightVel);
  return !!m && m.perp >= TEAR_RELATIVE_SPEED && m.along <= m.perp * TEAR_MAX_ALONG_RATIO && m.eachMin >= TEAR_EACH_HAND_SPEED;
}

/** 破れそうな度合い (0 ～ 1)。破る閾値に対する垂直・逆向きの速さの割合で、線に沿った動きが勝っているときは 0。 */
export function tearProgress(m: TearMetrics | null): number {
  if (!m || m.eachMin <= 0 || m.along > m.perp * TEAR_MAX_ALONG_RATIO) return 0;
  return Math.min(m.perp / TEAR_RELATIVE_SPEED, 1);
}

/** 写真の半分 (左: -1 / 右: +1) の板。写真の中心を原点とするローカル座標のまま、UV もテクスチャの半分に合わせる。 */
function halfPlane(width: number, height: number, side: -1 | 1, uvStart: number, uvEnd: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width / 2, height);
  geometry.translate((side * width) / 4, 0, 0);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, uvStart + uv.getX(i) * (uvEnd - uvStart));
  }
  return geometry;
}

/** 破る判定の対象にしている写真と、それを両手で持っていた手 */
interface Candidate {
  item: Item;
  left: HandState;
  right: HandState;
  /** 最後に両手で持っていた時刻 */
  lastBoth: number;
  /** ゆっくりした垂直・逆向きの動きが続いている時間 */
  slowTime: number;
  /** 回していると見なして、破るのを止めている */
  locked: boolean;
}

interface Fragment {
  group: THREE.Group;
  side: -1 | 1;
  age: number;
  /** 下向きの速さ (m/s、写真のローカルではなくワールド) */
  fall: number;
  materials: THREE.MeshBasicMaterial[];
  textures: THREE.Texture[];
}

const create: InteractionFactory = (ctx) => {
  const fragments: Fragment[] = [];
  let sustained = 0;
  let clock = 0;
  let charge = 0;
  let pulseTimer = 0;
  let candidate: Candidate | null = null;
  const histories = new WeakMap<HandState, { time: number; position: THREE.Vector3 }[]>();
  let crack: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;

  /** 手の速度。HandState.velocity (0.1 秒の平均) と、直近の短い幅で測り直した速度のうち、大きい方を使う。 */
  const _short = new THREE.Vector3();
  const fasterVelocity = (hand: HandState, time: number): THREE.Vector3 => {
    let history = histories.get(hand);
    if (!history) histories.set(hand, (history = []));
    history.push({ time, position: hand.grabPosition.clone() });
    while (history.length > 2 && time - history[0].time > SHORT_VELOCITY_WINDOW) history.shift();
    const elapsed = time - history[0].time;
    if (history.length < 2 || elapsed < 1e-4) return hand.velocity;
    _short.copy(hand.grabPosition).sub(history[0].position).divideScalar(elapsed);
    return _short.lengthSq() > hand.velocity.lengthSq() ? _short.clone() : hand.velocity;
  };

  /** 写真の上端から下へ伸びる、破れかけの裂け目。progress が 0 なら隠す。 */
  const updateCrack = (photo: Item | null, progress: number): void => {
    if (!photo || progress < 0.05) {
      if (crack) crack.visible = false;
      return;
    }
    // 白い枠 (台紙) ごと裂くので、写真の絵ではなく台紙の大きさを基準にする
    const mount = photo.object.children[0] as THREE.Mesh<THREE.PlaneGeometry> | undefined;
    if (!mount) return;
    if (!crack) {
      crack = new THREE.Mesh(
        new THREE.PlaneGeometry(0.006, 1),
        // 裂け目は「穴」にする。MR のパススルーは、フレームバッファの alpha が 0 の所に映るので、
        // 写真の上に色を載せる代わりに、描く先の色と alpha を 0 に上書きする (src と dst の係数をどちらも 0 にする)。
        // 写真のテクスチャは触らないので、破るのをやめて裂け目を隠せば、元の見た目にそのまま戻る。
        new THREE.MeshBasicMaterial({
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.ZeroFactor,
          blendDst: THREE.ZeroFactor,
          blendSrcAlpha: THREE.ZeroFactor,
          blendDstAlpha: THREE.ZeroFactor,
        }),
      );
      // 透明な物の中では、写真より後に描く
      crack.renderOrder = 10;
      ctx.app.scene.add(crack);
    }
    const scale = photo.object.scale.x;
    const mountHeight = mount.geometry.parameters.height;
    const length = mountHeight * CRACK_MAX_RATIO * progress;
    crack.visible = true;
    crack.quaternion.copy(photo.object.quaternion);
    crack.scale.set(scale, length * scale, 1);
    // 写真ローカルで、台紙の上端から下へ length だけ伸ばす。写真の面から少し手前に浮かせる。
    crack.position
      .set(0, (mountHeight - length) / 2, 0.004)
      .multiplyScalar(scale)
      .applyQuaternion(photo.object.quaternion)
      .add(photo.object.position);
  };

  const dispose = (fragment: Fragment): void => {
    ctx.app.scene.remove(fragment.group);
    for (const child of fragment.group.children) (child as THREE.Mesh).geometry.dispose();
    for (const material of fragment.materials) material.dispose();
    for (const texture of fragment.textures) texture.dispose();
  };

  /** 写真と同じ位置・向き・大きさに、左右 2 枚の破片を出す。元の写真は呼び出し側が消す。 */
  const spawnFragments = (photo: Item): void => {
    const group = photo.object;
    const mount = group.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | undefined;
    const picture = group.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | undefined;
    const map = picture?.material.map;
    if (!mount || !picture) return;
    const { width, height } = picture.geometry.parameters;
    const mountWidth = mount.geometry.parameters.width;
    const mountHeight = mount.geometry.parameters.height;
    for (const side of [-1, 1] as const) {
      const fragment = new THREE.Group();
      const texture = map?.clone() ?? null;
      if (texture) texture.needsUpdate = true;
      const pictureMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        transparent: true,
      });
      const mountMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true });
      const mountMesh = new THREE.Mesh(halfPlane(mountWidth, mountHeight, side, 0, 1), mountMaterial);
      mountMesh.position.z = mount.position.z;
      const pictureMesh = new THREE.Mesh(
        halfPlane(width, height, side, side < 0 ? 0 : 0.5, side < 0 ? 0.5 : 1),
        pictureMaterial,
      );
      fragment.add(mountMesh, pictureMesh);
      fragment.position.copy(group.position);
      fragment.quaternion.copy(group.quaternion);
      fragment.scale.copy(group.scale);
      ctx.app.scene.add(fragment);
      fragments.push({
        group: fragment,
        side,
        age: 0,
        fall: 0,
        materials: [pictureMaterial, mountMaterial],
        textures: texture ? [texture] : [],
      });
    }
  };

  const tear = (photo: Item, hands: HandState[]): void => {
    const position = photo.object.position.clone();
    spawnFragments(photo);
    // 破る音は既存の音で代用する。紙を裂くような短い音を 2 つ、少しずらして鳴らす。
    ctx.audio.click(position);
    setTimeout(() => ctx.audio.click(position), 60);
    for (const hand of hands) hand.pulse(0.9, 80);
    ctx.items.remove(photo);
  };

  return {
    id: 'D2',
    label: '破る',
    category: 'delete',
    disable() {
      for (const fragment of fragments) dispose(fragment);
      fragments.length = 0;
      sustained = 0;
      charge = 0;
      candidate = null;
      if (crack) {
        ctx.app.scene.remove(crack);
        crack.geometry.dispose();
        crack.material.dispose();
        crack = null;
      }
    },
    update(frame: FrameContext) {
      // 破片のアニメーション
      for (let i = fragments.length - 1; i >= 0; i--) {
        const fragment = fragments[i];
        fragment.age += frame.dt;
        const t = fragment.age / FALL_DURATION;
        if (t >= 1) {
          dispose(fragment);
          fragments.splice(i, 1);
          continue;
        }
        const scale = fragment.group.scale.x;
        // 写真のローカル x 方向 (写真の横向き) へ離れる
        _dir.set(fragment.side, 0, 0).applyQuaternion(fragment.group.quaternion);
        fragment.fall += FALL_GRAVITY * frame.dt;
        fragment.group.position
          .addScaledVector(_dir, SPREAD_SPEED * scale * frame.dt)
          .addScaledVector(_dir.set(0, -1, 0), fragment.fall * frame.dt);
        fragment.group.rotateZ(-fragment.side * SPIN_SPEED * frame.dt);
        const opacity = 1 - t * t;
        for (const material of fragment.materials) material.opacity = opacity;
      }

      clock += frame.dt;
      // 両手で持った写真を、破る判定の対象にする。片手が外れても TEAR_GRACE の間は、直前まで持っていた写真を残す。
      const held = ctx.items.all.find((item) => item.kind === 'photo' && ctx.items.holdersOf(item).length === 2);
      if (held) {
        const hands = ctx.items.holdersOf(held);
        const left = hands.find((hand) => hand.handedness === 'left');
        const right = hands.find((hand) => hand.handedness === 'right');
        if (left && right) {
          if (candidate?.item !== held) {
            candidate = { item: held, left, right, lastBoth: clock, slowTime: 0, locked: false };
            sustained = 0;
          }
          candidate.left = left;
          candidate.right = right;
          candidate.lastBoth = clock;
        }
      }
      if (candidate && (!ctx.items.all.includes(candidate.item) || clock - candidate.lastBoth > TEAR_GRACE)) {
        candidate = null;
      }
      if (!candidate) {
        sustained = 0;
        charge = 0;
        updateCrack(null, 0);
        return;
      }
      const { item: photo, left, right } = candidate;
      if (!left.tracked || !right.tracked) {
        sustained = 0;
        return;
      }
      const lv = fasterVelocity(left, clock);
      const rv = fasterVelocity(right, clock);
      const metrics = measureTear(left.grabPosition, right.grabPosition, lv, rv);

      // ゆっくり回しているだけのときは破らない
      const perp = metrics && metrics.eachMin > 0 ? metrics.perp : 0;
      if (perp < SLOW_RAMP_SPEED) {
        candidate.slowTime = 0;
        candidate.locked = false;
      } else if (perp < TEAR_RELATIVE_SPEED) {
        candidate.slowTime += frame.dt;
        if (candidate.slowTime > SLOW_RAMP_LIMIT) candidate.locked = true;
      }

      // 破れそうな度合いを、裂け目で見せる (素手は振動が無いので、見た目が頼り)
      const target = candidate.locked ? 0 : tearProgress(metrics);
      charge += (target - charge) * Math.min(1, frame.dt * 15);
      updateCrack(photo, charge);
      pulseTimer -= frame.dt;
      if (charge > 0.5 && pulseTimer <= 0) {
        pulseTimer = 0.08;
        left.pulse(0.15 * charge, 30);
        right.pulse(0.15 * charge, 30);
      }

      if (
        !candidate.locked &&
        isTearingMotion(left.grabPosition, right.grabPosition, lv, rv)
      ) {
        sustained += frame.dt;
        if (sustained >= TEAR_SUSTAIN) {
          sustained = 0;
          candidate = null;
          charge = 0;
          updateCrack(null, 0);
          tear(photo, [left, right]);
        }
      } else {
        sustained = 0;
      }
    },
  };
};

export default create;
