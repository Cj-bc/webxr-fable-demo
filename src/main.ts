import { App } from './app';
import { Audio } from './features/audio';
import { Cursors } from './features/cursors';
import { Drawing } from './features/drawing';
import { HitTest } from './features/hitTest';
import { Lighting } from './features/lighting';
import { Occlusion } from './features/occlusion';
import { Placement } from './features/placement';
import { Portal } from './features/portal';
import { Room } from './features/room';
import { StatusPanel } from './features/statusPanel';
import { Toys } from './features/toys';
import type { HandState } from './input';
import { setMessage, setupEnterButton, showEnabledFeatures } from './landing';

const app = new App();
await app.physics.init();

const lighting = app.add(new Lighting(app));
const occlusion = app.add(new Occlusion(app));
app.add(new Cursors(app));
const room = app.add(new Room(app));
const toys = app.add(new Toys(app));
const hitTest = app.add(new HitTest(app));
const placement = app.add(new Placement(app, hitTest));
const drawing = app.add(new Drawing(app));
const portal = app.add(new Portal(app, hitTest));

const audio = app.add(new Audio());
toys.onImpact = (position, speed, kind) => audio.impact(position, speed, kind);
app.menu.onPress = (position) => audio.click(position);
placement.onPlaced = (position) => audio.chime(position);
portal.onOpened = (position) => audio.chime(position);

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
status.setDetail('depth-sensing', () =>
  !occlusion.active
    ? '深度データなし'
    : !occlusion.enabled
      ? '受信中 (遮蔽オフ)'
      : occlusion.soft
        ? '遮蔽中 (ぼかし)'
        : '遮蔽中 (くっきり)',
);
status.setDetail('light-estimation', () => (lighting.estimating ? '推定値を照明に反映中' : '固定の照明'));
status.setFooter(
  () => `おもちゃ ${toys.count} / 配置 ${placement.count} / 線 ${drawing.count} / ポータル ${portal.count}`,
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
