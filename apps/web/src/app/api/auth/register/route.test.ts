import { describe, expect, it } from 'vitest';
import { POST } from './route';

describe('POST /api/auth/register', () => {
  it('rejects public registration for every request', async () => {
    const response = await POST(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com',
          password: 'correct horse battery staple',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe('AUTH_REGISTRATION_DISABLED');
  });
});
