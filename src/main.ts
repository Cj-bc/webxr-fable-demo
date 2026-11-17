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
import { Toys } from './features/toys';
import { setMessage, setupEnterButton, showEnabledFeatures } from './landing';

const app = new App();
await app.physics.init();

app.add(new Lighting(app));
app.add(new Occlusion(app));
app.add(new Cursors(app));
app.add(new Room(app));
const toys = app.add(new Toys(app));
const hitTest = app.add(new HitTest(app));
const placement = app.add(new Placement(app, hitTest));
app.add(new Drawing(app));
const portal = app.add(new Portal(app, hitTest));

const audio = app.add(new Audio());
toys.onImpact = (position, speed, kind) => audio.impact(position, speed, kind);
app.menu.onPress = (position) => audio.click(position);
placement.onPlaced = (position) => audio.chime(position);
portal.onOpened = (position) => audio.chime(position);

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
