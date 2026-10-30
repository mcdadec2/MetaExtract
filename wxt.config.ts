import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact()] }),
  manifest: {
    name: 'MetaExtract',
    description:
      'Save the video playing on any page as a single file with a JSON metadata sidecar.',
    permissions: [
      'webRequest',
      'downloads',
      'storage',
      'unlimitedStorage',
      'offscreen',
      'declarativeNetRequestWithHostAccess',
      'sidePanel',
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'MetaExtract' },
  },
});
