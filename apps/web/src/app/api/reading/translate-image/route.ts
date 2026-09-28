import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { ERROR_CODES } from '@deep-research/shared/errors';
import { ReadingImageTranslateInputSchema } from '@deep-research/shared/schemas';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { getWebEnv } from '../../../../lib/env';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { requireReadingUser } from '../../../../lib/reading-auth';

type EngineVisionResponse = {
  suggestion: string | null;
  truncated?: boolean;
  finishReason?: string | null;
  metrics?: Record<string, unknown>;
};

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingImageTranslateInputSchema);
  if (input instanceof NextResponse) return input;

  const match = input.imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '仅支持 PNG、JPEG 或 WebP 图片',
      requestId,
    });
  }
  const [, imageMediaType, encoded] = match;
  const imageBytes = Buffer.from(encoded, 'base64');
  if (imageBytes.length === 0 || imageBytes.length > 6 * 1024 * 1024
    || imageBytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '图片数据无效或超过 6 MB',
      requestId,
    });
  }

  const upstream = await fetchAiEngine<EngineVisionResponse>({
    url: `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/reading/translate-image`,
    method: 'POST',
    timeoutMs: 120_000,
    retry: false,
    signal: req.signal,
    requestId,
    context: 'reading.translate-image',
    body: {
      requester_id: user.id,
      image_media_type: imageMediaType,
      image_base64: encoded,
      image_alt: input.alt,
      topic: input.title,
      language: input.language,
      retry: input.retry,
    },
  });
  if (!upstream.ok) {
    return toApiErrorResponse({
      code: upstream.code ?? ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: upstream.message,
      requestId: upstream.requestId,
    });
  }
  if (!upstream.body.suggestion?.trim()) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: '视觉模型没有返回图片翻译结果',
      requestId,
    });
  }

  return NextResponse.json({
    choices: [{
      message: { content: upstream.body.suggestion },
      finish_reason: upstream.body.finishReason || (upstream.body.truncated ? 'length' : 'stop'),
    }],
    metrics: upstream.body.metrics ?? {},
    requestId,
  });
});
