import { createHash } from 'node:crypto';

import type { SourceAnchor } from '@deep-research/shared/schemas';

/**
 * Validate a browser supplied text anchor against the exact body submitted in
 * the same request. A position without a matching body hash is never treated
 * as authoritative: page scripts and SPAs can change text between selection
 * and the request.
 */
export function validateReadingAnchor(body: string, anchor: SourceAnchor): string | null {
  if (anchor.startOffset === undefined || anchor.endOffset === undefined || !anchor.contentHash) {
    return '原文锚点缺少完整位置或内容指纹，请重新选择原文';
  }
  if (anchor.endOffset < anchor.startOffset || anchor.endOffset > body.length) {
    return '原文锚点位置已超出当前正文，请重新选择原文';
  }
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  if (bodyHash !== anchor.contentHash) {
    return '原文已变化，无法准确定位这段证据';
  }
  if (body.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote) {
    return '原文摘录与锚点位置不一致，请重新选择原文';
  }
  return null;
}

