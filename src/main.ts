import { App } from './app';
import { Lighting } from './features/lighting';
import { setMessage, setupEnterButton, showEnabledFeatures } from './landing';

const app = new App();
app.add(new Lighting(app));

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
