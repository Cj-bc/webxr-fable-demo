import * as THREE from 'three';
import type { App, Feature, FrameContext } from '../app';
import { copyPosition, getJointPose, type HandState } from '../input';
import { deleteBlob, getBlob, putBlob } from '../blobStore';
import { withoutOcclusion } from './occlusion';
import type { SavedPose } from './persistence';

/** 人差し指が伸びているとみなす、まっすぐさ (付け根から先端の直線距離 / 指の長さ)。枠を作るとき / 保つとき */
const INDEX_STRAIGHT_FORM = 0.88;
const INDEX_STRAIGHT_HOLD = 0.75;
/**
 * 親指の先から人差し指の付け根側の節までの距離 (人差し指の長さに対する比)。
 * OPEN を超えたら開いている、FOLD を下回ったら倒したとみなす。
 */
const THUMB_OPEN = 0.6;
const THUMB_FOLD = 0.4;
/** 指が枠の内側を向いているとみなす、対角線の向きとの内積の下限 */
const INWARD_MIN = 0.25;
/**
 * 指が視線に対して横に寝ているとみなす、視線の向きとの内積 (絶対値) の上限。枠を作るとき / 保つとき。
 * 道具を使うときは人差し指が前 (視線の向き) を指すので、ここで枠と区別する。
 */
const ACROSS_VIEW_FORM = 0.5;
const ACROSS_VIEW_HOLD = 0.7;
/** 両手の人差し指どうし・親指どうしが逆を向いているとみなす、内積の上限。枠を作るとき / 保つとき */
const OPPOSED_FORM = -0.5;
const OPPOSED_HOLD = -0.2;
/** 枠の形をこの秒数だけ保つと、枠が出る。手を動かす途中で一瞬その形になっただけでは出さない。 */
const FORM_DELAY = 0.35;
/**
 * 枠を、両手の角が作る四角形より各辺この長さだけ内側に縮める (m)。指が写真に写り込まないようにする。
 * 指の太さに加えて、カメラが目とは違う位置から手を見ているぶんのずれも見込んでいる。
 */
const FINGER_INSET = 0.03;
/** 枠の一辺の長さの範囲 (m) */
const MIN_SIDE = 0.04;
const MAX_SIDE = 0.7;
/** 枠ができてから、撮れるようになるまでの秒数。枠を作る動きの途中で撮れてしまわないようにする。 */
const ARM_DELAY = 0.3;
/** 次に撮れるようになるまでの秒数 */
const COOLDOWN = 0.8;
/** 写真の長辺のピクセル数 */
const CAPTURE_SIZE = 1280;
/** 空間に残す写真の枚数。超えたら古いものから消す (保存用の一覧には残る)。 */
const MAX_WORLD_PHOTOS = 8;
const BORDER = 0.004;
const FLASH_DURATION = 0.25;
/**
 * パススルーカメラの水平画角 (度)。ブラウザからはカメラの内部パラメータが取れないので、仮の値。
 * 写真の中の現実の景色が、枠から見えた範囲より広く写るなら大きく、狭く写るなら小さくする。
 */
const CAMERA_FOV_HORIZONTAL = 73;
/**
 * パススルーカメラが、頭の正面に対して下を向いている角度 (度)。これも仮の値。
 * 写真の中の現実の景色が、枠から見えた範囲より下にずれるなら大きく、上にずれるなら小さくする。
 */
const CAMERA_PITCH_DOWN = 12;
/** 頭の向き → カメラの向き の回転 */
const CAMERA_TILT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -THREE.MathUtils.degToRad(CAMERA_PITCH_DOWN),
);
/** カメラの映像がない所の色 (sRGB) */
const BACKDROP = new THREE.Color(0x10141c);

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * 仮想物体の描画結果 (リニア、アルファ乗算済み) を、カメラの映像の上に重ねて sRGB で出力する。
 * カメラの映像は、枠の中の各画素が向いている方向を、カメラから見た方向に直して引く。
 * 景色は十分遠くにあるものとして、頭とカメラの位置の差は無視している。
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D virtualMap;
uniform sampler2D videoMap;
uniform bool hasVideo;
uniform mat3 toVideo;
uniform vec2 captureTan;
uniform vec2 videoTan;
uniform vec3 backdrop;
varying vec2 vNdc;

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 real = toLinear(backdrop);
  if (hasVideo) {
    vec3 direction = toVideo * vec3(vNdc * captureTan, -1.0);
    vec2 uv = direction.xy / (max(-direction.z, 1e-4) * videoTan) * 0.5 + 0.5;
    if (direction.z < 0.0 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
      real = toLinear(texture2D(videoMap, uv).rgb);
    }
  }
  vec4 overlay = texture2D(virtualMap, vNdc * 0.5 + 0.5);
  gl_FragColor = vec4(toSrgb(overlay.rgb + real * (1.0 - overlay.a)), 1.0);
}`;

/** 枠を作る片手の形 */
interface FrameHand {
  /** 親指と人差し指の付け根の間。枠の角になる。 */
  corner: THREE.Vector3;
  indexDirection: THREE.Vector3;
  thumbDirection: THREE.Vector3;
  indexStraightness: number;
  thumbGap: number;
  /** 親指を倒している (THUMB_OPEN / THUMB_FOLD の間では前の状態を保つ) */
  folded: boolean;
}

export interface Photo {
  url: string;
  name: string;
}

/** 空間に浮かべてある写真 */
interface WorldPhoto {
  /** 保存してある画像の識別子 */
  id: string;
  group: THREE.Group;
  /** 撮った枠の大きさ (m)。表示の大きさは、これに group の拡大率を掛けたもの。 */
  width: number;
  height: number;
}

interface SavedPhoto {
  id: string;
  width: number;
  height: number;
  pose: SavedPose;
}

export interface CameraInfo {
  /** 映像を再生している要素。ページに置けば、何が映っているか確かめられる。 */
  video: HTMLVideoElement;
  cameras: { deviceId: string; label: string }[];
  /** 使用中のカメラ */
  deviceId: string;
}

/**
 * カメラを止めた理由。
 * user: ページのボタンで止めた / session-end: MR を終えた / disabled: 「手で撮影」をオフにした /
 * pagehide: ページを離れた / track-ended: 許可の取り消しなどで、映像のトラックが外から止められた
 */
export type CameraStopReason = 'user' | 'session-end' | 'disabled' | 'pagehide' | 'track-ended';

/** カメラの状態。変わるたびに onCameraChange で知らせる。 */
export type CameraState =
  | { kind: 'requesting' }
  | { kind: 'running'; info: CameraInfo }
  | { kind: 'stopped'; reason: CameraStopReason }
  | { kind: 'failed'; message: string }
  | { kind: 'unsupported' };

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _thumbBase = new THREE.Vector3();
const _thumbTip = new THREE.Vector3();
const _indexDistal = new THREE.Vector3();
const _indexTip = new THREE.Vector3();
const _diagonal = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _clearColor = new THREE.Color();

function newFrameHand(): FrameHand {
  return {
    corner: new THREE.Vector3(),
    indexDirection: new THREE.Vector3(),
    thumbDirection: new THREE.Vector3(),
    indexStraightness: 0,
    thumbGap: 0,
    folded: false,
  };
}

/** 点 p から線分 ab までの距離 */
function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _d.subVectors(b, a);
  const t = THREE.MathUtils.clamp(_c.subVectors(p, a).dot(_d) / Math.max(_d.lengthSq(), 1e-8), 0, 1);
  return _c.copy(a).addScaledVector(_d, t).distanceTo(p);
}

/**
 * 両手の親指と人差し指で四角を作ると枠が出て、どちらかの親指を倒すと、枠の中に見えている景色を写真に撮る。
 *
 * 手の形は hand-tracking の関節の位置から判定する。片手ごとに「人差し指が伸び、親指が開いている (L 字)」
 * ことを調べ、両手の L 字の角を対角とする四角形を、頭から見て正面を向く向きに作る。
 *
 * 撮った写真は空間に残り、つまんで持ち運べる (Holding)。
 *
 * 写真は、頭の位置から枠を通して見た範囲を、仮想物体だけレンダーターゲットに描いて作る。
 * WebXR のフレームバッファにはパススルー映像が入っていない (合成は OS 側で行われる) ので、
 * 現実の景色は getUserMedia で取ったパススルーカメラの映像から、同じ範囲を切り出して下に敷く。
 * カメラを許可していない場合は、仮想物体だけの写真になる。
 * カメラは MR の前に開始して MR 中も使い続け、MR の終了・「手で撮影」のオフ・ページを離れたときに止める。
 */
export class HandFrame implements Feature {
  readonly name = 'handFrame';
  /** 撮った写真。セッションを終えたあと、ページから保存できる。 */
  readonly photos: Photo[] = [];
  /** 撮った瞬間の通知 (効果音など) */
  onCapture: ((position: THREE.Vector3) => void) | null = null;
  /** 写真が画像ファイルになったときの通知 */
  onPhoto: ((photo: Photo) => void) | null = null;
  /** カメラの状態が変わったときの通知。ページの表示はこれだけを見て合わせる。 */
  onCameraChange: ((state: CameraState) => void) | null = null;

  private _enabled = true;
  private cameraRequest: AbortController | null = null;
  private stream: MediaStream | null = null;
  /** 使用中、または要求中のカメラ。おまかせなら undefined */
  private cameraDeviceId: string | undefined;
  /** 「手で撮影」のオフで止めたカメラ。オンに戻したら、これで再開する。再開するものがなければ null */
  private resumeDeviceId: string | undefined | null = null;

  private readonly left = newFrameHand();
  private readonly right = newFrameHand();
  private active = false;
  /** 枠の形になり始めた時刻。なっていなければ負 */
  private formingSince = -1;
  private activeSince = 0;
  private lastCapture = -Infinity;
  private flashUntil = 0;

  /** 枠の中心・向き・大きさ */
  private readonly center = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private width = 0;
  private height = 0;

  private readonly frame = new THREE.Group();
  private readonly bars: THREE.Mesh[] = [];
  private readonly flash: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly worldPhotos: WorldPhoto[] = [];
  /** 「全部消す」の回数と、復元を始めたときのその値。復元の途中で消されたことを見分ける。 */
  private clearGeneration = 0;
  private restoreGeneration = 0;

  private readonly captureCamera = new THREE.PerspectiveCamera();
  // 仮想物体はリニアで描かれるので、暗部が潰れないよう 8 ビットより精度のある形式で受ける。
  private readonly virtualTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    stencilBuffer: true,
  });
  private readonly outputTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly compositeMaterial = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: COMPOSITE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      virtualMap: { value: this.virtualTarget.texture },
      videoMap: { value: null as THREE.Texture | null },
      hasVideo: { value: false },
      toVideo: { value: new THREE.Matrix3() },
      captureTan: { value: new THREE.Vector2(1, 1) },
      videoTan: { value: new THREE.Vector2(1, 1) },
      backdrop: { value: new THREE.Vector3(BACKDROP.r, BACKDROP.g, BACKDROP.b) },
    },
  });
  private readonly compositeScene = new THREE.Scene();

  private video: HTMLVideoElement | null = null;
  private videoTexture: THREE.VideoTexture | null = null;
  private time = 0;
  private lastVideoTime = 0;
  private videoAdvancedAt = -Infinity;

  constructor(private readonly app: App) {
    // Color は内部でリニアに直されるので、シェーダーに渡す sRGB の値を取り直す。
    BACKDROP.getRGB(_clearColor, THREE.SRGBColorSpace);
    this.compositeMaterial.uniforms.backdrop.value.set(_clearColor.r, _clearColor.g, _clearColor.b);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);

    // 枠は手に重なる位置にあるので、深度を無視して常に見せる。
    const barMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, side: THREE.DoubleSide });
    const barGeometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.Mesh(barGeometry, barMaterial);
      bar.renderOrder = 90;
      this.bars.push(bar);
      this.frame.add(bar);
    }
    this.flash = new THREE.Mesh(
      barGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    this.flash.renderOrder = 89;
    this.flash.visible = false;
    this.frame.add(this.flash);
    this.frame.visible = false;
    app.scene.add(this.frame);

    app.menu.addToggle(
      '手で撮影',
      () => this.enabled,
      (value) => (this.enabled = value),
    );
    // 枠を作っている間は、親指の動きがつまみと判定されても道具を発動させない。
    app.tools.addInterceptor(() => this.active);
    app.onClear(() => this.clearWorldPhotos());
    // bfcache に入るときも含め、ページを離れたらカメラを手放す。
    window.addEventListener('pagehide', () => this.stopCamera('pagehide'));
    // 位置と大きさは他の物と一緒に保存し、画像は大きいので別に (IndexedDB) 持つ。
    app.persistence.register<SavedPhoto[]>('photos', {
      save: () =>
        this.worldPhotos.map(({ id, group, width, height }) => ({
          id,
          width,
          height,
          pose: app.persistence.poseOf(group),
        })),
      restore: (saved) => {
        this.restoreGeneration = this.clearGeneration;
        return this.restoreWorldPhotos(saved);
      },
    });
  }

  /** カメラの映像が取れていて、写真に現実の景色が入るか */
  get cameraReady(): boolean {
    const video = this.video;
    return video !== null && video.readyState >= 2 && video.videoWidth > 0;
  }

  /** カメラの映像が、いまも更新され続けているか。MR セッション中に止まる環境を見分けるためのもの。 */
  get cameraLive(): boolean {
    return this.cameraReady && this.time - this.videoAdvancedAt < 1;
  }

  /** 「手で撮影」が有効か。オフにすると、カメラも止める。 */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (!value) this.stopCamera('disabled');
    else if (this.resumeDeviceId !== null) void this.startCamera(this.resumeDeviceId);
  }

  /**
   * カメラの映像を取り始める。許可のダイアログが出るので、MR を始める前に、
   * ユーザー操作 (ボタンのクリック) の中で呼ぶ。結果は onCameraChange で知らせ、この Promise は失敗しない。
   * deviceId を省くと、背面 (パススルー) のカメラらしいものを選ぶ。覚えていたカメラが無ければ、おまかせで選び直す。
   * 使っているカメラ・待っている要求は、新しい要求に置き換える。
   */
  async startCamera(deviceId?: string): Promise<void> {
    // カメラを開始するのは撮るつもりがあるからなので、前回「手で撮影」をオフにしたまま終えていても、オンに戻す。
    this._enabled = true;
    this.resumeDeviceId = null;
    // 前のカメラは置き換えるつもりで呼ばれているので、止まった通知は出さない。
    this.abandonCamera();
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      this.onCameraChange?.({ kind: 'unsupported' });
      return;
    }
    const request = new AbortController();
    this.cameraRequest = request;
    this.cameraDeviceId = deviceId;
    this.onCameraChange?.({ kind: 'requesting' });
    try {
      const stopped = new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      // 許可ダイアログや play() の完了を待たずに、停止操作を完了できるようにする。
      await Promise.race([this.openCamera(media, request.signal, deviceId), stopped]);
    } catch (error) {
      if (request.signal.aborted) return;
      this.abandonCamera();
      console.error(error);
      this.onCameraChange?.({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async openCamera(media: MediaDevices, signal: AbortSignal, deviceId?: string): Promise<void> {
    const size = { width: { ideal: 1280 }, height: { ideal: 960 } };
    const acquire = async (id?: string): Promise<MediaStream> => {
      const video = id ? { ...size, deviceId: { exact: id } } : { ...size, facingMode: 'environment' };
      const stream = await media.getUserMedia({ video });
      // getUserMedia 自体は中断できない。停止後に届いたトラックは、その要求だけで片付ける。
      if (signal.aborted) {
        stopStream(stream);
        signal.throwIfAborted();
      }
      // 列挙や再生を待つ間も、stopCamera からすぐにトラックを止められるようにする。
      this.stream = stream;
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (this.stream === stream) this.stopCamera('track-ended');
        }, { signal });
      }
      return stream;
    };

    let stream: MediaStream;
    try {
      stream = await acquire(deviceId);
    } catch (error) {
      signal.throwIfAborted();
      // 覚えていたデバイスが使えないときだけ自動選択に戻す。許可の拒否では再要求しない。
      const deviceUnavailable = error instanceof DOMException &&
        (error.name === 'NotFoundError' || error.name === 'OverconstrainedError');
      if (!deviceId || !deviceUnavailable) throw error;
      deviceId = undefined;
      stream = await acquire();
    }
    signal.throwIfAborted();
    const devices = await media.enumerateDevices();
    signal.throwIfAborted();
    const cameras = devices.filter((device) => device.kind === 'videoinput')
      .map((device, i) => ({ deviceId: device.deviceId, label: device.label || `カメラ ${i + 1}` }));
    let current = stream.getVideoTracks()[0]?.getSettings().deviceId ?? '';
    if (!deviceId) {
      // Quest の既定カメラはアバターを映すことがある。写真の画角と傾きを合わせた背面の camera 2 を優先する。
      const back = cameras.find((camera) => /camera 2\b.*back/i.test(camera.label)) ??
        cameras.find((camera) => /back|rear|environment|passthrough/i.test(camera.label));
      if (back && back.deviceId !== current) {
        stopStream(stream);
        this.stream = null;
        stream = await acquire(back.deviceId);
        current = back.deviceId;
      }
    }
    signal.throwIfAborted();
    const video = document.createElement('video');
    this.video = video;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    signal.throwIfAborted();
    const texture = new THREE.VideoTexture(video);
    // 色の変換は合成のシェーダーで自前で行うので、映像の値をそのまま読む。
    texture.colorSpace = THREE.NoColorSpace;
    this.videoTexture = texture;
    this.compositeMaterial.uniforms.videoMap.value = texture;
    this.cameraDeviceId = current;
    this.onCameraChange?.({ kind: 'running', info: { video, cameras, deviceId: current } });
  }

  /**
   * 使用中のカメラを止め、待っている要求も取り消す。止めるものがあれば onCameraChange で知らせる。
   * 「手で撮影」のオフで止めたときだけ、オンに戻したら再開できるよう覚えておく。
   */
  stopCamera(reason: CameraStopReason): void {
    const using = this.cameraRequest !== null;
    const resumable = this.resumeDeviceId !== null;
    this.abandonCamera();
    this.resumeDeviceId = reason === 'disabled' && using ? this.cameraDeviceId : null;
    if (using || resumable) this.onCameraChange?.({ kind: 'stopped', reason });
  }

  /** 使用中のカメラを止め、待っている要求を取り消す。通知はしない。 */
  private abandonCamera(): void {
    this.cameraRequest?.abort();
    this.cameraRequest = null;
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.remove();
    }
    this.videoTexture?.dispose();
    this.video = null;
    this.videoTexture = null;
    this.compositeMaterial.uniforms.videoMap.value = null;
  }

  private trackVideo(time: number): void {
    this.time = time;
    const videoTime = this.video?.currentTime ?? 0;
    if (videoTime !== this.lastVideoTime) {
      this.lastVideoTime = videoTime;
      this.videoAdvancedAt = time;
    }
  }

  start(): void {
    this.active = false;
    this.formingSince = -1;
    this.left.folded = false;
    this.right.folded = false;
  }

  end(): void {
    this.active = false;
    this.frame.visible = false;
    // MR の外では写真を撮らないので、カメラを手放す。次の MR の前に、ページから開始し直してもらう。
    this.stopCamera('session-end');
    // 次のセッションでは座標が変わるので、表示は片付ける。保存してあれば、そこから戻る。
    for (const photo of this.worldPhotos) this.removeWorldPhoto(photo, true);
    this.worldPhotos.length = 0;
  }

  update(ctx: FrameContext): void {
    const wasActive = this.active;
    const leftFolded = this.left.folded;
    const rightFolded = this.right.folded;
    const input = this.app.input;
    const readable =
      this.enabled && this.readHand(ctx, input.left, this.left) && this.readHand(ctx, input.right, this.right);
    const shaped = readable && this.checkShape(ctx.headPosition);
    if (!shaped) {
      this.active = false;
      this.formingSince = -1;
      this.left.folded = false;
      this.right.folded = false;
    } else if (!this.active) {
      if (this.formingSince < 0) this.formingSince = ctx.time;
      if (ctx.time - this.formingSince >= FORM_DELAY) {
        this.active = true;
        this.activeSince = ctx.time;
      }
    }
    this.trackVideo(ctx.time);

    if (this.active) {
      // 親指を倒すと手の形が変わって枠の角がずれるので、倒している間は枠を動かさない。
      if (!this.left.folded && !this.right.folded) this.updateRect(ctx.headPosition, ctx.headQuaternion);
      const pressed = (this.left.folded && !leftFolded) || (this.right.folded && !rightFolded);
      if (
        pressed &&
        wasActive &&
        ctx.time - this.activeSince > ARM_DELAY &&
        ctx.time - this.lastCapture > COOLDOWN
      ) {
        this.lastCapture = ctx.time;
        this.flashUntil = ctx.time + FLASH_DURATION;
        this.capture(ctx);
        input.left.pulse(0.8, 40);
        input.right.pulse(0.8, 40);
        this.onCapture?.(this.center);
      }
    }
    this.updateFrame(ctx.time);
  }

  /** 関節の位置から、片手の形を読む。素手でない、または関節が取れなければ false。 */
  private readHand(ctx: FrameContext, hand: HandState, out: FrameHand): boolean {
    const xrHand = hand.source?.hand;
    if (!hand.tracked || !xrHand) return false;
    const { frame, refSpace } = ctx;
    const thumbBase = getJointPose(frame, xrHand, 'thumb-phalanx-proximal', refSpace);
    const thumbTip = getJointPose(frame, xrHand, 'thumb-tip', refSpace);
    const proximal = getJointPose(frame, xrHand, 'index-finger-phalanx-proximal', refSpace);
    const intermediate = getJointPose(frame, xrHand, 'index-finger-phalanx-intermediate', refSpace);
    const distal = getJointPose(frame, xrHand, 'index-finger-phalanx-distal', refSpace);
    const tip = getJointPose(frame, xrHand, 'index-finger-tip', refSpace);
    if (!thumbBase || !thumbTip || !proximal || !intermediate || !distal || !tip) return false;

    copyPosition(_thumbBase, thumbBase.transform.position);
    copyPosition(_thumbTip, thumbTip.transform.position);
    const indexBase = copyPosition(_a, proximal.transform.position);
    const indexMiddle = copyPosition(_b, intermediate.transform.position);
    const indexDistal = copyPosition(_indexDistal, distal.transform.position);
    const indexTip = copyPosition(_indexTip, tip.transform.position);
    // 手の大きさによらず判定できるよう、人差し指の長さを基準にする。
    const indexLength =
      indexBase.distanceTo(indexMiddle) + indexMiddle.distanceTo(indexDistal) + indexDistal.distanceTo(indexTip);
    if (indexLength < 1e-4) return false;
    out.indexStraightness = indexBase.distanceTo(indexTip) / indexLength;
    out.thumbGap = distanceToSegment(_thumbTip, indexBase, indexMiddle) / indexLength;
    if (out.thumbGap > THUMB_OPEN) out.folded = false;
    else if (out.thumbGap < THUMB_FOLD) out.folded = true;

    out.corner.addVectors(_thumbBase, indexBase).multiplyScalar(0.5);
    out.indexDirection.subVectors(indexTip, indexBase).normalize();
    out.thumbDirection.subVectors(_thumbTip, _thumbBase).normalize();
    return true;
  }

  /** 両手が枠の形になっているか。すでに枠が出ているときは、条件をゆるめて保つ。 */
  private checkShape(head: THREE.Vector3): boolean {
    const { left, right } = this;
    _diagonal.subVectors(right.corner, left.corner);
    const distance = _diagonal.length();
    if (distance < MIN_SIDE || distance > MAX_SIDE * 1.5) return false;
    // 手が頭に近すぎる / 遠すぎるときは、枠として扱わない。
    const reach = _c.addVectors(left.corner, right.corner).multiplyScalar(0.5).distanceTo(head);
    if (reach < 0.1 || reach > 1) return false;

    _diagonal.divideScalar(distance);
    const view = _normal.copy(_c).sub(head).normalize();
    const leftAcross = Math.abs(left.indexDirection.dot(view));
    const rightAcross = Math.abs(right.indexDirection.dot(view));
    const indexOpposed = left.indexDirection.dot(right.indexDirection);

    if (this.active) {
      // 撮るために親指を倒している間も枠を保つので、親指の形は見ない。ただし両方倒したら枠をやめる。
      // 人差し指が前を指す、曲がる、同じ向きに揃う、のどれかで枠は消える。
      return (
        left.indexStraightness > INDEX_STRAIGHT_HOLD &&
        right.indexStraightness > INDEX_STRAIGHT_HOLD &&
        leftAcross < ACROSS_VIEW_HOLD &&
        rightAcross < ACROSS_VIEW_HOLD &&
        indexOpposed < OPPOSED_HOLD &&
        left.indexDirection.dot(_diagonal) > 0 &&
        right.indexDirection.dot(_diagonal) < 0 &&
        !(left.folded && right.folded)
      );
    }
    if (left.indexStraightness < INDEX_STRAIGHT_FORM || right.indexStraightness < INDEX_STRAIGHT_FORM) return false;
    if (left.folded || right.folded || left.thumbGap < THUMB_OPEN || right.thumbGap < THUMB_OPEN) return false;
    // 指が視線に対して横に寝ていること。レイで何かを指している手は、ここで外れる。
    if (leftAcross > ACROSS_VIEW_FORM || rightAcross > ACROSS_VIEW_FORM) return false;
    if (Math.abs(left.thumbDirection.dot(view)) > ACROSS_VIEW_HOLD) return false;
    if (Math.abs(right.thumbDirection.dot(view)) > ACROSS_VIEW_HOLD) return false;
    // 両手の L 字が、互い違いに向かい合っていること。人差し指どうし、親指どうしが逆を向き、
    // それぞれの指が相手の手の角へ向かう成分を持つ。両手をただ広げて並べた形は、ここで外れる。
    if (indexOpposed > OPPOSED_FORM) return false;
    if (left.thumbDirection.dot(right.thumbDirection) > OPPOSED_HOLD) return false;
    if (left.indexDirection.dot(_diagonal) < INWARD_MIN || left.thumbDirection.dot(_diagonal) < INWARD_MIN) return false;
    if (right.indexDirection.dot(_diagonal) > -INWARD_MIN || right.thumbDirection.dot(_diagonal) > -INWARD_MIN) {
      return false;
    }
    return true;
  }

  /** 両手の角を対角とする四角形を、頭のほうを向く平面の上に作る。 */
  private updateRect(head: THREE.Vector3, headQuaternion: THREE.Quaternion): void {
    this.center.addVectors(this.left.corner, this.right.corner).multiplyScalar(0.5);
    _normal.subVectors(head, this.center).normalize();
    // 写真が傾かないよう、上辺は水平にする。真上や真下を向いているときだけ、頭の向きに合わせる。
    if (Math.abs(_normal.y) < 0.95) _up.set(0, 1, 0);
    else _up.set(0, 1, 0).applyQuaternion(headQuaternion);
    _up.addScaledVector(_normal, -_up.dot(_normal)).normalize();
    _right.crossVectors(_up, _normal);
    this.quaternion.setFromRotationMatrix(_matrix.makeBasis(_right, _up, _normal));
    _diagonal.subVectors(this.right.corner, this.left.corner);
    this.width = THREE.MathUtils.clamp(Math.abs(_diagonal.dot(_right)) - FINGER_INSET * 2, MIN_SIDE, MAX_SIDE);
    this.height = THREE.MathUtils.clamp(Math.abs(_diagonal.dot(_up)) - FINGER_INSET * 2, MIN_SIDE, MAX_SIDE);
  }

  private updateFrame(time: number): void {
    const flashing = time < this.flashUntil;
    this.frame.visible = this.active || flashing;
    if (!this.frame.visible) return;
    const { width, height } = this;
    this.frame.position.copy(this.center);
    this.frame.quaternion.copy(this.quaternion);
    const [top, bottom, left, right] = this.bars;
    top.position.set(0, height / 2, 0);
    bottom.position.set(0, -height / 2, 0);
    top.scale.set(width + BORDER, BORDER, 1);
    bottom.scale.copy(top.scale);
    left.position.set(-width / 2, 0, 0);
    right.position.set(width / 2, 0, 0);
    left.scale.set(BORDER, height + BORDER, 1);
    right.scale.copy(left.scale);
    this.flash.visible = flashing;
    this.flash.scale.set(width, height, 1);
    this.flash.material.opacity = flashing ? (0.7 * (this.flashUntil - time)) / FLASH_DURATION : 0;
  }

  /** 頭の位置から枠を通して見た範囲を、写真にする。 */
  private capture(ctx: FrameContext): void {
    const { renderer, scene } = this.app;
    const { width, height } = this;
    const distance = Math.max(ctx.headPosition.distanceTo(this.center), 0.05);
    const scale = CAPTURE_SIZE / Math.max(width, height);
    const pixelWidth = Math.max(Math.round(width * scale), 2);
    const pixelHeight = Math.max(Math.round(height * scale), 2);

    // 枠は頭の正面を向けて作ってあるので、視線の軸に対して左右・上下が対称な、普通の透視投影になる。
    const camera = this.captureCamera;
    camera.position.copy(ctx.headPosition);
    camera.quaternion.copy(this.quaternion);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / 2 / distance));
    camera.aspect = width / height;
    // 枠より手前にあるもの (手のカーソルなど) は写さない。
    camera.near = distance;
    camera.far = 50;
    camera.updateProjectionMatrix();

    const uniforms = this.compositeMaterial.uniforms;
    uniforms.captureTan.value.set(width / 2 / distance, height / 2 / distance);
    const video = this.video;
    const hasVideo = this.cameraReady && video !== null && this.videoTexture !== null;
    uniforms.hasVideo.value = hasVideo;
    if (hasVideo) {
      // XR セッション中は映像の更新通知が来ないことがあるので、撮る直前に必ず取り込み直す。
      this.videoTexture!.needsUpdate = true;
      const tanHorizontal = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_HORIZONTAL / 2));
      uniforms.videoTan.value.set(tanHorizontal, (tanHorizontal * video.videoHeight) / video.videoWidth);
      // カメラは頭に固定されているものとして、枠の向き → カメラの向き の回転を求める。
      _quaternion.copy(ctx.headQuaternion).multiply(CAMERA_TILT).invert().multiply(this.quaternion);
      uniforms.toVideo.value.setFromMatrix4(_matrix.makeRotationFromQuaternion(_quaternion));
    }

    this.virtualTarget.setSize(pixelWidth, pixelHeight);
    this.outputTarget.setSize(pixelWidth, pixelHeight);
    const pixels = new Uint8Array(pixelWidth * pixelHeight * 4);

    // XR セッション中の renderer は、XR のカメラで XR のフレームバッファへ描く。
    // その設定を一時的に外して、自前のカメラでレンダーターゲットへ描く。
    const previousTarget = renderer.getRenderTarget();
    const previousXr = renderer.xr.enabled;
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clearColor);
    const frameVisible = this.frame.visible;
    this.frame.visible = false;
    // 前に撮った写真は写さない。同じ場所で続けて撮ると、前の写真が景色を覆ってしまう。
    for (const photo of this.worldPhotos) photo.group.visible = false;
    try {
      renderer.xr.enabled = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.virtualTarget);
      withoutOcclusion(() => renderer.render(scene, camera));
      renderer.setRenderTarget(this.outputTarget);
      renderer.render(this.compositeScene, camera);
      renderer.readRenderTargetPixels(this.outputTarget, 0, 0, pixelWidth, pixelHeight, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(_clearColor, previousAlpha);
      renderer.xr.enabled = previousXr;
      this.frame.visible = frameVisible;
      for (const photo of this.worldPhotos) photo.group.visible = true;
    }

    // 読み出した画素は下の行から並んでいるので、上下を入れ替えてキャンバスに置く。
    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(pixelWidth, pixelHeight);
    const rowBytes = pixelWidth * 4;
    for (let y = 0; y < pixelHeight; y++) {
      const source = (pixelHeight - 1 - y) * rowBytes;
      image.data.set(pixels.subarray(source, source + rowBytes), y * rowBytes);
    }
    context.putImageData(image, 0, 0);

    const worldPhoto = this.addWorldPhoto(canvas);
    const name = `mr-playroom-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        if (this.worldPhotos.includes(worldPhoto)) {
          putBlob(worldPhoto.id, blob).catch((error: unknown) => {
            console.warn('[handFrame] 写真の画像を保存できませんでした。次回は復元されません', error);
          });
        }
        const photo: Photo = { url: URL.createObjectURL(blob), name };
        this.photos.push(photo);
        this.onPhoto?.(photo);
      },
      'image/jpeg',
      0.92,
    );
  }

  /** 撮った写真を、撮った場所に浮かべて残す。 */
  private addWorldPhoto(canvas: HTMLCanvasElement): WorldPhoto {
    const texture = new THREE.CanvasTexture(canvas);
    const worldPhoto = this.createWorldPhoto(crypto.randomUUID(), texture, this.width, this.height);
    const photo = worldPhoto.group;
    // 枠のあった場所に、枠と同じ大きさで置く。撮った景色にそのまま重なる。
    // 同じ場所で続けて撮るときは、撮る間だけ前の写真を隠すので、景色は塞がない。
    photo.quaternion.copy(this.quaternion);
    photo.position.copy(this.center);
    while (this.worldPhotos.length > MAX_WORLD_PHOTOS) this.removeWorldPhoto(this.worldPhotos.shift()!);
    return worldPhoto;
  }

  /** 写真の板を作ってシーンに足す。位置・向き・大きさは呼び出し側が決める。width と height は撮った枠の大きさ (m)。 */
  private createWorldPhoto(id: string, texture: THREE.Texture, width: number, height: number): WorldPhoto {
    texture.colorSpace = THREE.SRGBColorSpace;
    const photo = new THREE.Group();
    const picture = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
    );
    const mount = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.012, height + 0.012),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    );
    mount.position.z = -0.001;
    photo.add(mount, picture);
    this.app.scene.add(photo);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    this.app.holding.add({
      object: photo,
      // 枠を作っている手が、枠の位置にある写真をつまんでしまわないようにする。
      canHold: () => !this.active,
      distanceTo: (point) => {
        const local = photo.worldToLocal(_a.copy(point));
        const x = Math.max(Math.abs(local.x) - halfWidth, 0);
        const y = Math.max(Math.abs(local.y) - halfHeight, 0);
        return Math.hypot(x, y, local.z) * photo.scale.x;
      },
    });
    const worldPhoto: WorldPhoto = { id, group: photo, width, height };
    this.worldPhotos.push(worldPhoto);
    return worldPhoto;
  }

  /** 保存してあった写真を、画像を読み直して作り直す。 */
  private async restoreWorldPhotos(saved: SavedPhoto[]): Promise<void> {
    const session = this.app.session;
    for (const { id, width, height, pose } of saved) {
      const blob = await getBlob(id);
      // 撮った直後にページを閉じると、画像の保存が間に合っていないことがある。
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      try {
        const texture = await new THREE.TextureLoader().loadAsync(url);
        // 読み込みを待つ間に、セッションが終わったり「全部消す」が押されたりしていたら、作らない。
        if (this.app.session !== session || this.restoreGeneration !== this.clearGeneration) {
          texture.dispose();
          return;
        }
        this.app.persistence.place(this.createWorldPhoto(id, texture, width, height).group, pose);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  private clearWorldPhotos(): void {
    this.clearGeneration++;
    for (const photo of this.worldPhotos) this.removeWorldPhoto(photo);
    this.worldPhotos.length = 0;
  }

  /** keepImage: 保存してある画像を残す (セッションの終了で、表示だけ片付けるとき) */
  private removeWorldPhoto({ id, group: photo }: WorldPhoto, keepImage = false): void {
    if (!keepImage) void deleteBlob(id).catch(() => {});
    this.app.scene.remove(photo);
    this.app.holding.remove(photo);
    for (const child of photo.children) {
      const mesh = child as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
  }
}
