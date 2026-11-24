import type { CameraState, CameraStopReason } from './features/handFrame';
import { ALL_FEATURES } from './xrFeatures';

const enterButton = document.querySelector<HTMLButtonElement>('#enter')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const tableBody = document.querySelector<HTMLTableSectionElement>('#support tbody')!;
const statusCells = new Map<string, HTMLTableCellElement>();
/** 前回選んだカメラの deviceId を覚えておく localStorage のキー */
const CAMERA_KEY = 'mr-playroom/camera';

for (const feature of ALL_FEATURES) {
  const row = tableBody.insertRow();
  row.insertCell().innerHTML = `${feature.label}<br><code>${feature.id}</code>`;
  row.insertCell().textContent = feature.use;
  const status = row.insertCell();
  status.textContent = '未確認';
  statusCells.set(feature.id, status);
}

export function setMessage(text: string): void {
  message.textContent = text;
}

/** immersive-ar が使えるかを調べ、使えるときだけ開始ボタンを有効にする。 */
export async function setupEnterButton(onEnter: () => void): Promise<void> {
  enterButton.addEventListener('click', onEnter);
  if (!navigator.xr) {
    setMessage('このブラウザは WebXR に対応していません。Meta Quest のブラウザで、HTTPS で開いてください。');
    return;
  }
  // 確認に時間がかかる環境があるので、その間も何が起きているか分かるようにする。
  setMessage('MR に対応しているか確認しています…');
  const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!supported) {
    setMessage('このデバイスは immersive-ar (パススルー MR) セッションに対応していません。');
    return;
  }
  setMessage('');
  enterButton.disabled = false;
}

interface CameraControl {
  /** deviceId のカメラ (省略時はおまかせ) の映像を取り始める。結果は CameraState で返ってくる。 */
  start(deviceId?: string): void;
  /** 使用中のカメラを止め、待っている要求も取り消す */
  stop(): void;
}

const STOP_MESSAGES: Record<CameraStopReason, string> = {
  user: 'カメラを止めました。写真に現実の景色を入れるときは、もう一度開始してください。',
  'session-end': 'MR を終えたので、カメラを止めました。次の MR の前に、もう一度開始してください。',
  disabled: '「手で撮影」をオフにしたので、カメラを止めました。オンに戻すか、ここで開始すると再開します。',
  pagehide: 'ページを離れたので、カメラを止めました。',
  'track-ended': 'カメラの映像が途切れました (許可の取り消しなど)。使うときは、もう一度開始してください。',
};

function readSavedCamera(): string | undefined {
  try {
    return localStorage.getItem(CAMERA_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveCamera(deviceId: string): void {
  try {
    localStorage.setItem(CAMERA_KEY, deviceId);
  } catch {
    // 覚えられなくても、今回の選択には影響しない。
  }
}

/**
 * カメラの開始・停止ボタン。許可のダイアログは MR セッション中には出せないので、開始前に押してもらう。
 * 取れた映像はページに表示し、どのカメラが使われているかを目で確かめられるようにする。
 * Quest では、このプレビューは MR に入っても止めずに使い続け (写真の背景になる)、MR を終えたら止める。
 */
export function setupCameraButton(control: CameraControl): (state: CameraState) => void {
  const button = document.querySelector<HTMLButtonElement>('#camera')!;
  const status = document.querySelector<HTMLSpanElement>('#camera-status')!;
  const preview = document.querySelector<HTMLDivElement>('#camera-preview')!;
  const select = document.querySelector<HTMLSelectElement>('#camera-select')!;

  /** 最後に知らされた状態。ボタンが「止める」か「開始」かを決める */
  let current: CameraState['kind'] = 'stopped';

  const show = (state: CameraState): void => {
    current = state.kind;
    button.textContent = 'カメラを開始';
    switch (state.kind) {
      case 'requesting':
        button.textContent = '開始をキャンセル';
        status.textContent = 'カメラの映像を待っています…';
        break;
      case 'running': {
        const { video, cameras, deviceId } = state.info;
        button.textContent = 'カメラを止める';
        status.textContent = `カメラを使えます (${video.videoWidth}×${video.videoHeight})。`;
        select.replaceChildren(...cameras.map((camera) => new Option(camera.label, camera.deviceId)));
        select.value = deviceId;
        preview.append(video);
        break;
      }
      case 'stopped':
        status.textContent = STOP_MESSAGES[state.reason];
        break;
      case 'failed':
        status.textContent = `カメラを使えませんでした: ${state.message}`;
        break;
      case 'unsupported':
        status.textContent = 'このブラウザではカメラを使えません。写真は仮想物体だけになります。';
        break;
    }
    button.disabled = current === 'unsupported';
    select.disabled = current !== 'running';
    preview.hidden = current !== 'running';
  };

  button.addEventListener('click', () => {
    if (current === 'requesting' || current === 'running') {
      control.stop();
    } else {
      control.start(readSavedCamera());
    }
  });
  select.addEventListener('change', () => {
    saveCamera(select.value);
    control.start(select.value);
  });
  return show;
}

/** 撮った写真を一覧に足す。押すと保存できる。 */
export function addPhoto(url: string, name: string): void {
  document.querySelector<HTMLElement>('#gallery')!.hidden = false;
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  const image = document.createElement('img');
  image.src = url;
  image.alt = name;
  link.append(image);
  document.querySelector<HTMLDivElement>('#photos')!.append(link);
}

/** セッションが実際に有効化した機能を一覧に反映する。 */
export function showEnabledFeatures(enabled: readonly string[] | undefined): void {
  for (const [id, cell] of statusCells) {
    if (!enabled) {
      cell.textContent = '不明';
      cell.className = '';
      continue;
    }
    const ok = enabled.includes(id);
    cell.textContent = ok ? '有効' : '非対応';
    cell.className = ok ? 'ok' : 'ng';
  }
}
