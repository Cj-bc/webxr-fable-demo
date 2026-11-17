import { ALL_FEATURES } from './xrFeatures';

const enterButton = document.querySelector<HTMLButtonElement>('#enter')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const tableBody = document.querySelector<HTMLTableSectionElement>('#support tbody')!;
const statusCells = new Map<string, HTMLTableCellElement>();

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
 * onRequest は、映像が取れたら true を返す。
 */
export function setupCameraButton(onRequest: () => Promise<boolean>): void {
  const button = document.querySelector<HTMLButtonElement>('#camera')!;
  const status = document.querySelector<HTMLSpanElement>('#camera-status')!;
  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = 'カメラの許可を待っています…';
    onRequest().then(
      (ok) => {
        status.textContent = ok
          ? 'カメラを使えます。手で撮る写真に現実の景色が入ります。'
          : 'このブラウザではカメラを使えません。写真は仮想物体だけになります。';
      },
      (error: unknown) => {
        console.error(error);
        button.disabled = false;
        status.textContent = `カメラを使えませんでした: ${error instanceof Error ? error.message : String(error)}`;
      },
    );
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
