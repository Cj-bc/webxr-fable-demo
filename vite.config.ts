import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// WebXR は安全なコンテキスト (HTTPS か localhost) でしか使えない。
// Quest から LAN 経由で開けるように、自己署名証明書の HTTPS で全インターフェースに公開する。
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true },
  preview: { host: true },
  build: { target: 'es2022' },
});
