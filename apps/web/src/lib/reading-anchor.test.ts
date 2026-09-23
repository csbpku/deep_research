import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { validateReadingAnchor } from './reading-anchor';

function anchorFor(body: string, quote: string) {
  const startOffset = body.indexOf(quote);
  return {
    quote,
    prefix: body.slice(Math.max(0, startOffset - 5), startOffset),
    suffix: body.slice(startOffset + quote.length, startOffset + quote.length + 5),
    startOffset,
    endOffset: startOffset + quote.length,
    contentHash: createHash('sha256').update(body).digest('hex'),
  };
}

describe('reading anchor validation', () => {
  it('accepts a matching quote, range, and body fingerprint', () => {
    const body = 'Introduction\n\nUse a bounded context for the answer.';
    expect(validateReadingAnchor(body, anchorFor(body, 'Use a bounded context for the answer.'))).toBeNull();
  });

  it('rejects a changed body instead of trusting the old position', () => {
    const body = 'Use a bounded context for the answer.';
    const anchor = anchorFor(body, body);
    expect(validateReadingAnchor('Use an unrelated context for the answer.', anchor)).toContain('已变化');
  });

  it('rejects a quote that does not match its claimed range', () => {
    const body = 'Use a bounded context for the answer.';
    const anchor = anchorFor(body, body);
    expect(validateReadingAnchor(body, { ...anchor, quote: 'different quote' })).toContain('不一致');
  });
});

