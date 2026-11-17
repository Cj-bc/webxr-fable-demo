import { App } from './app';
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
app.add(new Toys(app));
const hitTest = app.add(new HitTest(app));
app.add(new Placement(app, hitTest));
app.add(new Drawing(app));
app.add(new Portal(app, hitTest));
app.menu.addAction('全部消す', () => app.clearAll());
// 物理は最後に進める。各機能がこのフレームの入力を物体に反映してから計算するため。
app.add(app.physics);

app.onSessionStart = (session) => {
  setMessage('');
  showEnabledFeatures(session.enabledFeatures);
};

void setupEnterButton(() => {
  app.enterXR().catch((error: unknown) => {
    console.error(error);
    setMessage(`MR セッションを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`);
  });
});
