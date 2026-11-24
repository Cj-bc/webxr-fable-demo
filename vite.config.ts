import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// `server.fs.deny` を指定すると、Vite の既定値とは結合されずに置き換わる。
// そのため既定値を自分で書き写して残す。以下は vite@8.3.8 の既定値そのまま。
// Vite を更新したときは、既定値が増減していないかを確認し、この配列を合わせること。
const viteDefaultFsDeny = [
  '.env',
  '.env.*',
  '*.{crt,pem,key,p12,pfx,cer,der}',
  '.npmrc',
  '.yarnrc.yml',
  '**/.git/**',
];

// LAN に公開する開発サーバーから配信させたくない、エージェント・開発ツール用のファイル。
// パターンに `/` を含めると Vite はそのまま glob として使う (含めないと `**/` が前置される)。
const devToolFsDeny = [
  '**/.entire/**',
  '**/.claude/**',
  '**/.codex/**',
  '**/.agents/**',
  '**/AGENTS.md',
  '**/CLAUDE.md',
];

// WebXR は安全なコンテキスト (HTTPS か localhost) でしか使えない。
// Quest から LAN 経由で開けるように、自己署名証明書の HTTPS で全インターフェースに公開する。
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    fs: { deny: [...viteDefaultFsDeny, ...devToolFsDeny] },
  },
  preview: { host: true },
  build: { target: 'es2022' },
});
