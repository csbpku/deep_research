import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@deep-research/shared/errors';

import {
  friendlyError,
  friendlyMessage,
  retryOnceAi,
} from './friendly';
import { ApiHttpError } from './api-error';

describe('friendlyError', () => {
  it('maps AI_ENGINE_UNAVAILABLE to a friendly zh message', () => {
    const err = new ApiHttpError(
      { code: ERROR_CODES.AI_ENGINE_UNAVAILABLE, message: 'AI 调研服务暂时不可用，请稍后重试' },
      503,
      'fallback',
    );
    expect(friendlyMessage(err)).toContain('AI 调研服务');
  });

  it('maps raw Error network failure to friendly zh', () => {
    expect(friendlyMessage(new Error('Failed to fetch'))).toMatch(/暂时不可用|网络异常/);
  });

  it('falls back when error is unrecognised', () => {
    expect(friendlyMessage(null, '加载失败')).toBe('加载失败');
    expect(friendlyMessage({ code: ERROR_CODES.AUTH_NOT_AUTHENTICATED })).toMatch(/登录/);
  });

  it('keeps code-driven messages stable', () => {
    expect(
      friendlyMessage({ code: ERROR_CODES.AI_QUOTA_EXCEEDED })
    ).toMatch(/配额/);
    expect(
      friendlyMessage({ code: ERROR_CODES.IMPORT_FILE_TOO_LARGE })
    ).toMatch(/文件过大/);
  });
});

describe('retryOnceAi', () => {
  it('retries on AI_ENGINE_UNAVAILABLE (5xx-like)', () => {
    const err = new ApiHttpError(
      { code: ERROR_CODES.AI_ENGINE_UNAVAILABLE },
      503,
      'x',
    );
    expect(retryOnceAi(0, err)).toBe(true);
  });
  it('does not retry on VALIDATION_FAILED 4xx', () => {
    const err = new ApiHttpError(
      { code: ERROR_CODES.VALIDATION_FAILED, message: '参数错' },
      400,
      'x',
    );
    expect(retryOnceAi(0, err)).toBe(false);
  });
  it('does not retry a second time', () => {
    const err = new Error('Failed to fetch');
    expect(retryOnceAi(1, err)).toBe(false);
  });
  it('retries unknown Error (likely network)', () => {
    expect(retryOnceAi(0, new Error('whatever'))).toBe(true);
  });
});
