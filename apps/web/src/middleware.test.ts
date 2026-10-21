import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, middleware } from './middleware';

afterEach(() => vi.unstubAllEnvs());

describe('development review boundary', () => {
  it('is scoped only to the development review path', () => {
    expect(config.matcher).toEqual(['/mui-demo/:path*']);
  });

  it('returns an actual uncacheable 404 in production before streaming', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = middleware();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Not found');
  });

  it('allows the real review page to render during development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(middleware().headers.get('x-middleware-next')).toBe('1');
  });
});
