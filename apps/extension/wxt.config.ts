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

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'Deep Research Reader',
    version: '0.2.6',
    // Stable public key keeps the manually loaded Beta extension ID stable
    // across machines, so platform PKCE can use one production allowlist.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtxMIP3V5lxVc7vAYUePEYM/tvFsFHyymxv+aYmU+sClPIN/U0wOiQcyjf5kWAHHMicir7XQd5tk387537mQJY2bk8kPSkRU0ITHxKXWNsREkkOxzZD6dikADBF/JI6rETy8JGDEo9x83vbYkDebz5cLEVHxFGjQ+PyyxIxrHfeZHcI7ReTHW36FoVl4+1i4wWF5kthRbmfZw8NEstWeJ9ev0CZsPbRp04KNP65uKwMLms0CkDd76WOt1DoO93ZpI8cwME22x2PlW9V2C/cJBIDDz1DTP4fjrfq0oFBQPseaSc2Mf//3KDfWYKuz6zDyhEi/kb475tv0ugJpwjoQy3wIDAQAB',
    description: '独立的开发者 AI 阅读助手：全文、图片翻译、技术解读、追问和本地知识积累。',
    // `tabs` is metadata-only here: the side panel needs the active tab URL
    // to distinguish a protected Chrome page from a public HTTP(S) page
    // before it asks for that site's optional content permission.
    permissions: ['activeTab', 'alarms', 'scripting', 'storage', 'tabs', 'unlimitedStorage', 'sidePanel'],
    host_permissions: e2eHostPermissions,
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    // The platform page must be able to navigate back to the PKCE callback.
    web_accessible_resources: [{ resources: ['callback.html'], matches: ['http://*/*', 'https://*/*'] }],
    action: { default_title: '打开 Deep Research Reader' },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  },
});
