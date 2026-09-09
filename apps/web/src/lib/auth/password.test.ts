import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password credentials', () => {
  it('hashes and verifies a password without storing the plaintext', async () => {
    const password = 'correct horse battery staple';
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', encoded)).resolves.toBe(false);
  });

  it('uses a fresh salt for every hash', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).not.toBe(second);
  });

  it('rejects malformed and out-of-policy hashes', async () => {
    await expect(verifyPassword('short', null)).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery staple', 'not-a-hash')).resolves.toBe(false);
    await expect(
      verifyPassword(
        'correct horse battery staple',
        'scrypt$999999$8$1$c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).resolves.toBe(false);
  });

  it('rejects passwords outside the configured policy when hashing', async () => {
    await expect(hashPassword('too short')).rejects.toThrow(/between 12 and 256/);
  });
});
