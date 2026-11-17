import type { CameraInfo } from './features/handFrame';
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

/**
 * カメラの許可ボタン。許可のダイアログは MR セッション中には出せないので、開始前に押してもらう。
 * 取れた映像はページに表示し、どのカメラが使われているかを目で確かめられるようにする。
 * onRequest は、deviceId のカメラ (省略時はおまかせ) の映像を取り始める。使えなければ null を返す。
 */
export function setupCameraButton(onRequest: (deviceId?: string) => Promise<CameraInfo | null>): void {
  const button = document.querySelector<HTMLButtonElement>('#camera')!;
  const status = document.querySelector<HTMLSpanElement>('#camera-status')!;
  const preview = document.querySelector<HTMLDivElement>('#camera-preview')!;
  const select = document.querySelector<HTMLSelectElement>('#camera-select')!;

  const request = (deviceId?: string): void => {
    button.disabled = true;
    select.disabled = true;
    status.textContent = 'カメラの映像を待っています…';
    onRequest(deviceId)
      // 覚えていたカメラが無くなっていた場合は、おまかせで選び直す。
      .catch((error: unknown) => (deviceId ? onRequest() : Promise.reject(error)))
      .then(
        (info) => {
          if (!info) {
            status.textContent = 'このブラウザではカメラを使えません。写真は仮想物体だけになります。';
            return;
          }
          const { video, cameras } = info;
          status.textContent = `カメラを使えます (${video.videoWidth}×${video.videoHeight})。`;
          select.replaceChildren(...cameras.map((camera) => new Option(camera.label, camera.deviceId)));
          select.value = info.deviceId;
          preview.querySelector('video')?.remove();
          preview.append(video);
          preview.hidden = false;
        },
        (error: unknown) => {
          console.error(error);
          button.disabled = false;
          status.textContent = `カメラを使えませんでした: ${error instanceof Error ? error.message : String(error)}`;
        },
      )
      .finally(() => (select.disabled = false));
  };
  // Quest のブラウザは、既定ではアバターを映す仮想カメラを選ぶ。名前からは見分けられないので、
  // 一度選んでもらったカメラを覚えておき、次回からはそれを使う。
  button.addEventListener('click', () => request(localStorage.getItem(CAMERA_KEY) ?? undefined));
  select.addEventListener('change', () => {
    localStorage.setItem(CAMERA_KEY, select.value);
    request(select.value);
  });
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
