import * as THREE from 'three';
import type { Item } from '../../items';
import type { InteractionFactory } from '../types';

/**
 * C2 壁や机へのスタンプ。
 * 持っている写真を、検出した平面 (壁・机・床) に押し当てると、その面に 1 枚貼られて残り、手には元の写真が残る。
 * 面の検出は Room (平面検出) を使う。メッシュのみの部屋では動かない。
 */

/** 押し当てたとみなす、写真の中心から面までの距離 (m)。手で持つと板の中心は面から数 cm 浮くので、少し広めにとる。 */
const STAMP_DISTANCE = 0.05;
/** 予告 (面上の枠) を出し始める、写真の中心から面までの距離 (m) */
const PREVIEW_DISTANCE = 0.25;
/** 写真の正面と面の法線のなす角の許容 (度)。これ以内なら「おおよそ面に沿っている」とみなす。 */
const MAX_TILT_DEGREES = 25;
const MIN_FACING = Math.cos((MAX_TILT_DEGREES * Math.PI) / 180);
/** 貼った写真を面から浮かせる距離 (m)。重ねると z-fighting と深度センサーの誤差で欠ける。 */
const STAMP_LIFT = 0.004;
/** 一度貼ったら、その場所からこの距離 (m) 離れるまで次は貼れない (連打防止) */
const REARM_DISTANCE = 0.15;
/** 面の輪郭より、この距離 (m) だけ外側まで「面の上」とみなす。壁の端に貼りやすくする。 */
const PLANE_MARGIN = 0.05;
/** 写真の大きさが分からないときの、仮の幅・高さ (m) */
const FALLBACK_SIZE = 0.2;
const PREVIEW_COLOR_FAR = 0xffffff;
const PREVIEW_COLOR_NEAR = 0x6fe09a;
const PREVIEW_OPACITY = 0.18;
const STAMP_PULSE = { intensity: 0.7, ms: 40 };

const _front = new THREE.Vector3();
const _align = new THREE.Quaternion();
const _lockOffset = new THREE.Vector3();

/** 写真の正面 (ローカルの +Z) のワールドでの向き。out に書いて返す。 */
function frontOf(quaternion: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, 1).applyQuaternion(quaternion);
}

/**
 * 写真が面に沿っているか。写真の正面が、面の法線 (写真のある側を向く) とおおよそ同じ向きなら true。
 * 写真を裏向きに押し当てたときは false にする (貼ると絵が鏡像に見えるため)。
 */
export function isAlignedToPlane(photoQuaternion: THREE.Quaternion, planeNormal: THREE.Vector3): boolean {
  return frontOf(photoQuaternion, _front).dot(planeNormal) >= MIN_FACING;
}

/** 写真の向きを、面にぴったり沿うよう最小の回転で補正した向き (面内の回転は保つ)。out に書いて返す。 */
export function alignedQuaternion(
  photoQuaternion: THREE.Quaternion,
  planeNormal: THREE.Vector3,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _align.setFromUnitVectors(frontOf(photoQuaternion, _front), planeNormal);
  return out.copy(photoQuaternion).premultiply(_align);
}

/** 写真の板の大きさ (m、持って拡大縮小した分を含む)。 */
function sizeOf(item: Item): { width: number; height: number } {
  const picture = item.object.children.find(
    (child): child is THREE.Mesh<THREE.PlaneGeometry> =>
      child instanceof THREE.Mesh && child.geometry instanceof THREE.PlaneGeometry,
  );
  const scale = item.object.scale.x;
  const parameters = picture?.geometry.parameters;
  return { width: (parameters?.width ?? FALLBACK_SIZE) * scale, height: (parameters?.height ?? FALLBACK_SIZE) * scale };
}

const create: InteractionFactory = (ctx) => {
  /** 貼った直後の写真と、貼った場所。写真がそこから REARM_DISTANCE 離れるまで貼れない。 */
  const locks = new Map<Item, THREE.Vector3>();
  let preview: THREE.Group | null = null;
  let previewFill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  let previewLine: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;

  const ensurePreview = (): THREE.Group => {
    if (preview) return preview;
    previewFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: PREVIEW_COLOR_FAR,
        transparent: true,
        opacity: PREVIEW_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const outline = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0),
      new THREE.Vector3(-0.5, 0.5, 0),
    ]);
    previewLine = new THREE.LineLoop(outline, new THREE.LineBasicMaterial({ color: PREVIEW_COLOR_FAR }));
    preview = new THREE.Group();
    preview.add(previewFill, previewLine);
    preview.renderOrder = 5;
    preview.visible = false;
    ctx.app.scene.add(preview);
    return preview;
  };

  const disposePreview = (): void => {
    if (!preview) return;
    ctx.app.scene.remove(preview);
    previewFill?.geometry.dispose();
    previewFill?.material.dispose();
    previewLine?.geometry.dispose();
    previewLine?.material.dispose();
    preview = null;
    previewFill = null;
    previewLine = null;
  };

  const heldPhotos = (): Item[] => {
    const photos = new Set<Item>();
    for (const hand of ctx.app.input.hands) {
      for (const item of ctx.items.heldBy(hand)) if (item.kind === 'photo') photos.add(item);
    }
    return [...photos];
  };

  /** 予告の枠を面の上に出す。near: 押し当てる距離まで来ている */
  const showPreview = (
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    size: { width: number; height: number },
    near: boolean,
  ): void => {
    const group = ensurePreview();
    group.position.copy(position);
    group.quaternion.copy(quaternion);
    group.scale.set(size.width, size.height, 1);
    const color = near ? PREVIEW_COLOR_NEAR : PREVIEW_COLOR_FAR;
    previewFill!.material.color.setHex(color);
    previewLine!.material.color.setHex(color);
    group.visible = true;
  };

  return {
    id: 'C2',
    label: 'スタンプ',
    category: 'duplicate',
    disable() {
      locks.clear();
      disposePreview();
    },
    update() {
      if (preview) preview.visible = false;
      const photos = heldPhotos();
      for (const lock of [...locks.keys()]) if (!ctx.items.all.includes(lock)) locks.delete(lock);

      let previewed = false;
      for (const photo of photos) {
        const position = photo.object.position;
        const lockAt = locks.get(photo);
        if (lockAt) {
          if (_lockOffset.copy(position).sub(lockAt).length() < REARM_DISTANCE) continue;
          locks.delete(photo);
        }
        const hit = ctx.room.planeNear(position, PREVIEW_DISTANCE, PLANE_MARGIN);
        if (!hit || !isAlignedToPlane(photo.object.quaternion, hit.normal)) continue;

        const pose = alignedQuaternion(photo.object.quaternion, hit.normal, new THREE.Quaternion());
        const stampAt = hit.point.clone().addScaledVector(hit.normal, STAMP_LIFT);
        const near = hit.distance <= STAMP_DISTANCE;
        if (!previewed) {
          showPreview(stampAt, pose, sizeOf(photo), near);
          previewed = true;
        }
        if (!near) continue;

        // 押し当てた。複製を面に置き、手には元の写真を残す。複製できなくても、連打しないよう鍵はかける。
        locks.set(photo, position.clone());
        const copy = ctx.items.duplicate(photo);
        if (!copy) continue;
        copy.setPose(stampAt, pose);
        ctx.audio.chime(stampAt);
        for (const hand of ctx.items.holdersOf(photo)) hand.pulse(STAMP_PULSE.intensity, STAMP_PULSE.ms);
      }
    },
  };
};

export default create;
