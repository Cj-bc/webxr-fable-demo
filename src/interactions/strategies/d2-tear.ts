// D2 写真を破る: 両手で持った写真を、片手は手前・もう片手は奥へ素早く逆向きに動かすと、左右 2 枚に破れて落ちて消える。
import * as THREE from 'three';
import type { FrameContext } from '../../app';
import type { HandState } from '../../input';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

/** 両手を結ぶ線に垂直な、互いに逆向きの相対速度がこれ以上 (m/s)。両手で拡大縮小・回転する普通の動きは 0.5 m/s 未満に収まるので、その倍以上の素早さを要求する。 */
export const TEAR_RELATIVE_SPEED = 1.2;
/** 破るとき、各手がそれぞれ出していなければならない垂直方向の速さ (m/s)。片手だけを振っても (もう片手がほぼ止まったままでも) 破れない。 */
export const TEAR_EACH_HAND_SPEED = 0.35;
/** 線に沿った相対速度 (拡大縮小) が、垂直な相対速度のこの割合を超えたら、引き伸ばしと見なして破らない。 */
export const TEAR_MAX_ALONG_RATIO = 0.5;
/** 上の条件を満たし続ける時間 (秒)。手の速度は 1 フレームだけ跳ねることがあるので、少し続いたときだけ破る。 */
export const TEAR_SUSTAIN = 0.08;
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

/**
 * 両手の位置と速度から、破る動きか判定する (純粋な計算)。
 * 両手を結ぶ線に垂直な成分だけを取り出し、互いに逆向きで十分速く、線に沿った動きより支配的かを見る。
 */
export function isTearingMotion(
  leftPos: THREE.Vector3,
  rightPos: THREE.Vector3,
  leftVel: THREE.Vector3,
  rightVel: THREE.Vector3,
): boolean {
  _axis.subVectors(rightPos, leftPos);
  if (_axis.lengthSq() < 1e-6) return false;
  _axis.normalize();
  // 各手の速度から、線に沿った成分を引いて垂直成分にする
  _vl.copy(leftVel).addScaledVector(_axis, -leftVel.dot(_axis));
  _vr.copy(rightVel).addScaledVector(_axis, -rightVel.dot(_axis));
  _rel.subVectors(_vr, _vl);
  const perp = _rel.length();
  if (perp < TEAR_RELATIVE_SPEED) return false;
  const along = Math.abs(_dir.subVectors(rightVel, leftVel).dot(_axis));
  if (along > perp * TEAR_MAX_ALONG_RATIO) return false;
  _dir.copy(_rel).divideScalar(perp);
  // 相対運動の向きに対して、右手は正方向・左手は負方向へ、それぞれ十分動いている
  return _vr.dot(_dir) >= TEAR_EACH_HAND_SPEED && -_vl.dot(_dir) >= TEAR_EACH_HAND_SPEED;
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
  let sustainedItem: Item | null = null;

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
      sustainedItem = null;
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

      // 両手で持った写真が、破る動きをしているか
      const photo = ctx.items.all.find((item) => item.kind === 'photo' && ctx.items.holdersOf(item).length === 2);
      if (!photo) {
        sustained = 0;
        sustainedItem = null;
        return;
      }
      const hands = ctx.items.holdersOf(photo);
      const left = hands.find((hand) => hand.handedness === 'left');
      const right = hands.find((hand) => hand.handedness === 'right');
      if (!left || !right || !left.tracked || !right.tracked) {
        sustained = 0;
        return;
      }
      if (sustainedItem !== photo) {
        sustainedItem = photo;
        sustained = 0;
      }
      if (isTearingMotion(left.grabPosition, right.grabPosition, left.velocity, right.velocity)) {
        sustained += frame.dt;
        if (sustained >= TEAR_SUSTAIN) {
          sustained = 0;
          sustainedItem = null;
          tear(photo, hands);
        }
      } else {
        sustained = 0;
      }
    },
  };
};

export default create;
