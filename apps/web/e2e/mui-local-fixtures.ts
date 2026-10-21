import { expect, type APIRequestContext } from '@playwright/test';

/** Explicit opt-in: these accounts exist only in scripts/seed-mui-browser.ts. */
export function isolatedMuiOrigin() {
  const origin = process.env.E2E_BASE_URL;
  if (process.env.MUI_ISOLATED_BROWSER !== '1' || !origin) throw new Error('Requires an explicitly selected isolated MUI server');
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.port || url.port === '3000') {
    throw new Error('Never run MUI fixture authentication against the ordinary development service');
  }
  return url.origin;
}

export async function loginMuiFixture(request: APIRequestContext, identity: 'member' | 'other' | 'admin' | 'disabled' = 'member') {
  const origin = isolatedMuiOrigin();
  const csrfResponse = await request.get(`${origin}/api/auth/csrf`);
  expect(csrfResponse.ok()).toBe(true);
  const { csrfToken } = await csrfResponse.json();
  const response = await request.post(`${origin}/api/auth/callback/password`, { form: {
    csrfToken, email: `mui-${identity}@e2e.local`, password: 'MUI-local-fixture-only-2026', callbackUrl: `${origin}/topics`,
  } });
  expect(response.ok()).toBe(true);
  const session = await (await request.get(`${origin}/api/auth/session`)).json();
  if (identity === 'disabled') expect(session?.user).toBeUndefined();
  else {
    expect(session.user?.email).toBe(`mui-${identity}@e2e.local`);
    expect(session.user?.role).toBe(identity === 'admin' ? 'admin' : 'member');
  }
}
