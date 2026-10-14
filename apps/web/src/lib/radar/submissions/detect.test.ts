import { describe, expect, it } from 'vitest';
import { isLikelySafeUrl } from './detect';

describe('isLikelySafeUrl', () => {
  it.each([
    'http://localhost/x', 'http://127.0.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.5]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'http://[64:ff9b::7f00:1]/', 'http://100.64.0.1/', 'http://100.127.255.254/', 'http://169.254.169.254/latest',
    'http://192.168.1.1/', 'http://172.16.0.1/', 'http://2130706433/', 'http://intranet/', 'http://metadata/',
    'http://printer.local/', 'http://svc.internal/', 'http://foo.localhost/', 'http://user:pw@example.com/',
    'file:///etc/passwd', 'http://localhost./',
  ])('rejects %s', (url) => {
    expect(isLikelySafeUrl(url).ok).toBe(false);
  });

  it.each([
    'https://github.com/openai/codex', 'https://arxiv.org/abs/2401.00001', 'http://8.8.8.8/', 'http://100.63.0.1/',
    'http://[2606:4700:4700::1111]/', 'http://[::ffff:8.8.8.8]/', 'https://example.co.uk/a?b=1',
  ])('accepts %s', (url) => {
    expect(isLikelySafeUrl(url).ok).toBe(true);
  });
});
