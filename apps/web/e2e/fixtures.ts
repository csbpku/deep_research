// Playwright fixtures for specs that require an authenticated admin session.
// Authentication goes through the real Auth.js Credentials provider, which is
// only registered while the web server runs with E2E=1.

import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'codex-e2e-admin@shopee.com';

export { expect };

export const test = base.extend({
  page: async ({ page, context }, use) => {
    await loginWithCredentials(context.request, {
      email: ADMIN_EMAIL,
      role: 'admin',
    });
    await use(page);
  },
});

/** Sign in through Auth.js and keep the resulting cookie in this context. */
export async function loginWithCredentials(
  request: APIRequestContext,
  user: { email: string; role: 'member' | 'admin' },
): Promise<void> {
  const csrfResponse = await request.get(`${BASE_URL}/api/auth/csrf`);
  if (!csrfResponse.ok()) {
    throw new Error(`E2E login: CSRF endpoint returned ${csrfResponse.status()}`);
  }
  const csrf = await csrfResponse.json() as { csrfToken?: string };
  if (!csrf.csrfToken) throw new Error('E2E login: CSRF token missing');

  const callback = await request.post(
    `${BASE_URL}/api/auth/callback/e2e-credentials`,
    {
      form: {
        csrfToken: csrf.csrfToken,
        email: user.email,
        role: user.role,
        callbackUrl: `${BASE_URL}/`,
      },
    },
  );
  if (!callback.ok()) {
    throw new Error(
      `E2E login failed: ${callback.status()} ${await callback.text()}`,
    );
  }

  const sessionResponse = await request.get(`${BASE_URL}/api/auth/session`);
  const session = await sessionResponse.json() as {
    user?: { email?: string; role?: string };
  };
  if (session.user?.email !== user.email || session.user.role !== user.role) {
    throw new Error('E2E login failed: authenticated session was not established');
  }
}

/** Wait for React hydration after a full navigation. */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}
