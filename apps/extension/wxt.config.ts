import { defineConfig } from 'wxt';

// The browser smoke harness may grant localhost access to its deterministic
// fake provider. Production builds keep host access optional and request it
// only after the user configures a model endpoint.
function liveProviderPermission() {
  const values = (process.env.READER_E2E_LIVE_ORIGIN || '')
    .split(/[,\s]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values.flatMap((value) => {
    try {
      const origin = new URL(value);
      if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return [];
      return [`${origin.origin}/*`];
    } catch {
      return [];
    }
  }))];
}

const e2eHostPermissions = process.env.READER_E2E_MATRIX === '1'
  ? ['http://*/*', 'https://*/*']
  : process.env.READER_E2E === '1'
    ? ['http://127.0.0.1/*', ...liveProviderPermission()]
    : [];
const platformBridgeMatches = [
  'https://techradar.top/*',
  'https://www.techradar.top/*',
  ...(process.env.READER_E2E === '1' ? ['http://localhost/*', 'http://127.0.0.1/*'] : []),
];

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: '__MSG_extensionName__',
    version: '0.2.30',
    default_locale: 'zh_CN',
    // Stable public key keeps the manually loaded Beta extension ID stable
    // across machines, so platform PKCE can use one production allowlist.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtxMIP3V5lxVc7vAYUePEYM/tvFsFHyymxv+aYmU+sClPIN/U0wOiQcyjf5kWAHHMicir7XQd5tk387537mQJY2bk8kPSkRU0ITHxKXWNsREkkOxzZD6dikADBF/JI6rETy8JGDEo9x83vbYkDebz5cLEVHxFGjQ+PyyxIxrHfeZHcI7ReTHW36FoVl4+1i4wWF5kthRbmfZw8NEstWeJ9ev0CZsPbRp04KNP65uKwMLms0CkDd76WOt1DoO93ZpI8cwME22x2PlW9V2C/cJBIDDz1DTP4fjrfq0oFBQPseaSc2Mf//3KDfWYKuz6zDyhEi/kb475tv0ugJpwjoQy3wIDAQAB',
    description: '__MSG_extensionDescription__',
    // `tabs` is metadata-only here: the side panel needs the active tab URL
    // to distinguish a protected Chrome page from a public HTTP(S) page
    // before it asks for that site's optional content permission.
    permissions: ['contextMenus', 'activeTab', 'alarms', 'scripting', 'storage', 'tabs', 'unlimitedStorage', 'sidePanel'],
    host_permissions: [...e2eHostPermissions, ...platformBridgeMatches],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_scripts: [{ matches: platformBridgeMatches, js: ['reader-platform-bridge.js'], run_at: 'document_start' }],
    // The platform page must be able to navigate back to the PKCE callback.
    web_accessible_resources: [{ resources: ['callback.html'], matches: ['http://*/*', 'https://*/*'] }],
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: { default_title: '__MSG_actionOpenReader__', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' } },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  },
});
