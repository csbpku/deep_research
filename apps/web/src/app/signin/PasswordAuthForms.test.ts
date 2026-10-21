import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

import { PasswordAuthForms } from './PasswordAuthForms';

describe('PasswordAuthForms', () => {
  it('keeps labeled, autofill-compatible sign-in fields and accessible mode tabs', () => {
    const html = render(h(PasswordAuthForms, {
      callbackUrl: '/researches',
      betaMode: false,
      emailVerification: false,
    }));

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="邮箱登录或注册"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="auth-signin-tab"');
    expect(html).toContain('for="email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('for="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('邮箱密码登录');
    expect(html).toContain('注册账号');
    expect(html).toContain('登录');
  });
});
