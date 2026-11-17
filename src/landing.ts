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
  const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!supported) {
    setMessage('このデバイスは immersive-ar (パススルー MR) セッションに対応していません。');
    return;
  }
  enterButton.disabled = false;
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
