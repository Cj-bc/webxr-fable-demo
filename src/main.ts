import { App } from './app';
import { Audio } from './features/audio';
import { Cursors } from './features/cursors';
import { DepthColliders } from './features/depthColliders';
import { DepthView } from './features/depthView';
import { Drawing } from './features/drawing';
import { HandColliders } from './features/handColliders';
import { HandFrame } from './features/handFrame';
import { HitTest } from './features/hitTest';
import { Lighting } from './features/lighting';
import { Occlusion } from './features/occlusion';
import { Placement } from './features/placement';
import { Portal } from './features/portal';
import { Room } from './features/room';
import { StatusPanel } from './features/statusPanel';
import { Toys } from './features/toys';
import type { HandState } from './input';
import { ItemInteractions } from './interactions/manager';
import { addPhoto, setMessage, setupCameraButton, setupEnterButton, showEnabledFeatures } from './landing';

const app = new App();
await app.physics.init();

const lighting = app.add(new Lighting(app));
const occlusion = app.add(new Occlusion(app));
app.add(new Cursors(app));
const room = app.add(new Room(app));
app.add(new HandColliders(app, room));
const depthColliders = app.add(new DepthColliders(app, room));
const depthView = app.add(new DepthView(app));
const toys = app.add(new Toys(app));
const hitTest = app.add(new HitTest(app));
const placement = app.add(new Placement(app, hitTest));
const drawing = app.add(new Drawing(app));
const portal = app.add(new Portal(app, hitTest));
const handFrame = app.add(new HandFrame(app));

const audio = app.add(new Audio());
toys.onImpact = (position, speed, kind) => audio.impact(position, speed, kind);
app.menu.onPress = (position) => audio.click(position);
placement.onPlaced = (position) => audio.chime(position);
portal.onOpened = (position) => audio.chime(position);
handFrame.onCapture = (position) => audio.click(position);
handFrame.onPhoto = (photo) => addPhoto(photo.url, photo.name);
// 持っている物への操作 (削除・複製など) の試作。src/interactions/strategies/ の案をメニューで切り替える。
app.add(new ItemInteractions({ app, audio, room, hitTest, portal, toys }));
// カメラの状態は HandFrame が持ち、ページは知らされた状態を表示するだけにする。
handFrame.onCameraChange = setupCameraButton({
  start: (deviceId) => void handFrame.startCamera(deviceId),
  stop: () => handFrame.stopCamera('user'),
});

const status = app.add(new StatusPanel(app));
const describeHand = (hand: HandState): string => (!hand.tracked ? 'なし' : hand.isHand ? '素手' : 'コントローラー');
status.setDetail('local-floor', () => `目の高さ ${app.camera.position.y.toFixed(2)} m`);
status.setDetail('hand-tracking', () => `左: ${describeHand(app.input.left)} / 右: ${describeHand(app.input.right)}`);
status.setDetail('plane-detection', () => `${room.planeCount} 面`);
status.setDetail('mesh-detection', () => `${room.meshCount} 個`);
status.setDetail('hit-test', () => (hitTest.usingFallback ? '使えないため y=0 の床で代用' : '配置・ポータルの照準'));
status.setDetail('anchors', () => {
  const failures = placement.persistFailures > 0 ? `、保存失敗 ${placement.persistFailures}` : '';
  return `${placement.anchoredCount} 個 (うち保存 ${placement.persistentCount}${failures})`;
});
// 失敗の理由が長くなるので、行ではなく、パネルの幅いっぱいの注記に出す。
status.setNote(() => app.persistence.status);
status.setDetail('depth-sensing', () => {
  if (!occlusion.active) return '深度データなし';
  const state = !occlusion.enabled ? '受信中 (遮蔽オフ)' : occlusion.soft ? '遮蔽中 (ぼかし)' : '遮蔽中 (くっきり)';
  const view = depthView.enabled ? ' / 深度だけ表示中' : '';
  return (depthColliders.enabled ? `${state} / 当たり判定 ${depthColliders.count} 面` : state) + view;
});
status.setDetail('light-estimation', () => (lighting.estimating ? '推定値を照明に反映中' : '固定の照明'));
status.setFooter(
  () =>
    `おもちゃ ${toys.count} / 配置 ${placement.count} / 線 ${drawing.count} / ポータル ${portal.count}` +
    ` / 写真 ${handFrame.photos.length} (${
      handFrame.cameraLive ? 'カメラ映像あり' : handFrame.cameraReady ? 'カメラ映像が止まっている' : 'カメラなし'
    })`,
);

app.menu.addAction('全部消す', () => app.clearAll());
// 物理は最後に進める。各機能がこのフレームの入力を物体に反映してから計算するため。
app.add(app.physics);

app.onSessionStart = (session) => {
  setMessage('');
  showEnabledFeatures(session.enabledFeatures);
};

void setupEnterButton(() => {
  audio.unlock();
  app.enterXR().catch((error: unknown) => {
    console.error(error);
    setMessage(`MR セッションを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`);
  });
});
