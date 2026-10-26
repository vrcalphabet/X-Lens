import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'X-Lens',
  version: '0.1.0',
  description: 'X（旧Twitter）の画像に隠された、もう一枚の画像をレンズで覗けます。',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: 'X-Lens',
    default_popup: 'popup.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
    },
  },
  permissions: ['storage', 'contextMenus'],
  host_permissions: ['https://pbs.twimg.com/*'],
  background: {
    service_worker: 'src/background.js',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://x.com/*', 'https://twitter.com/*'],
      js: ['src/content.js'],
      run_at: 'document_idle',
    },
  ],
});
