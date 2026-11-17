import { App } from './app';
import { Cursors } from './features/cursors';
import { Lighting } from './features/lighting';
import { Room } from './features/room';
import { setMessage, setupEnterButton, showEnabledFeatures } from './landing';

const app = new App();
await app.physics.init();

app.add(new Lighting(app));
app.add(new Cursors(app));
app.add(new Room(app));
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
