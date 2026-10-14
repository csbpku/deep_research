import { expect, it } from 'vitest';
import { maskEmail } from './mask-email';

it('masks the local part but keeps the domain', () => {
  expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  expect(maskEmail('nope')).toBe('***');
});
