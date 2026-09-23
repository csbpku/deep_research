import { describe, expect, it } from 'vitest';

import {
  AnnotationSchema,
  DetailReadCompletedInput,
  ReadingAnswerInputSchema,
  ImageTextRegionSchema,
  ProviderConfigSchema,
  ReadingResultSchema,
  ReadingSaveInputSchema,
  ReadingSessionSyncInputSchema,
  ReadingTranslateInputSchema,
  RecordTimeSavedInput,
  ResearchBriefSchema,
  ResearchScopeSchema,
  SavedInsightSchema,
  TranslationJobSchema,
} from './schemas';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('metric input schemas', () => {
  it('accepts a completed detail read at both thresholds', () => {
    expect(DetailReadCompletedInput.safeParse({
      entityType: 'research',
      entityId: UUID,
      foregroundSeconds: 30,
      scrollPercent: 50,
      idempotencyKey: UUID,
    }).success).toBe(true);
  });

  it('rejects detail reads below either threshold', () => {
    expect(DetailReadCompletedInput.safeParse({
      entityType: 'summary',
      entityId: UUID,
      foregroundSeconds: 29,
      scrollPercent: 50,
      idempotencyKey: UUID,
    }).success).toBe(false);
    expect(DetailReadCompletedInput.safeParse({
      entityType: 'summary',
      entityId: UUID,
      foregroundSeconds: 30,
      scrollPercent: 49,
      idempotencyKey: UUID,
    }).success).toBe(false);
  });

  it('bounds time-saved feedback to 0-240 minutes', () => {
    expect(RecordTimeSavedInput.safeParse({ jobId: UUID, minutes: 0, idempotencyKey: UUID }).success)
      .toBe(true);
    expect(RecordTimeSavedInput.safeParse({ jobId: UUID, minutes: 240, idempotencyKey: UUID }).success)
      .toBe(true);
    expect(RecordTimeSavedInput.safeParse({ jobId: UUID, minutes: 241, idempotencyKey: UUID }).success)
      .toBe(false);
  });
});

describe('research scope schema', () => {
  it('defaults to an explicit unrestricted scope', () => {
    expect(ResearchScopeSchema.parse({})).toEqual({
      timeRange: { preset: 'any' },
      regions: [],
      technologyVersions: [],
      retrievalNotes: '',
    });
  });

  it('requires both dates for a custom range and keeps dates ordered', () => {
    expect(ResearchScopeSchema.safeParse({ timeRange: { preset: 'custom', from: '2026-09-02' } }).success).toBe(false);
    expect(ResearchScopeSchema.safeParse({ timeRange: { preset: 'custom', from: '2026-09-03', to: '2026-09-02' } }).success).toBe(false);
    expect(ResearchScopeSchema.safeParse({
      timeRange: { preset: 'custom', from: '2026-09-01', to: '2026-09-30' },
      regions: ['中国'],
      technologyVersions: ['React 19'],
      retrievalNotes: '只看官方资料',
    }).success).toBe(true);
  });

  it('keeps the scope inside a research brief', () => {
    const result = ResearchBriefSchema.safeParse({
      objective: 'decide',
      question: '选择一个测试框架',
      scope: { timeRange: { preset: '30d' }, regions: ['全球'], technologyVersions: ['Node 22'] },
    });
    expect(result.success).toBe(true);
  });
});

describe('browser reading schemas', () => {
  const context = {
    url: 'https://example.com/article',
    title: 'A technical article',
    body: 'The original page context.',
    selection: { quote: 'original page', prefix: 'The ', suffix: ' context.' },
  };

  it('requires a prompt for follow-up questions', () => {
    expect(ReadingAnswerInputSchema.safeParse({ action: 'ask', context }).success).toBe(false);
    expect(ReadingAnswerInputSchema.safeParse({ action: 'ask', context, prompt: 'Why?' }).success).toBe(true);
    expect(ReadingAnswerInputSchema.safeParse({ action: 'explain', context }).success).toBe(true);
  });

  it('does not let a selection-scoped request silently expand to the page', () => {
    expect(ReadingAnswerInputSchema.safeParse({
      action: 'explain',
      context: { url: context.url, title: context.title, body: context.body, scope: 'selection' },
    }).success).toBe(false);
    expect(ReadingAnswerInputSchema.safeParse({
      action: 'explain',
      context: { ...context, scope: 'page' },
    }).success).toBe(true);
  });

  it('bounds translation batches and save payloads', () => {
    expect(ReadingTranslateInputSchema.safeParse({
      url: context.url,
      blocks: [{ id: 'p-1', text: 'A paragraph that needs translation.' }],
    }).success).toBe(true);
    expect(ReadingSaveInputSchema.safeParse({
      url: context.url,
      title: context.title,
      quote: context.selection.quote,
      anchor: context.selection,
      idempotencyKey: UUID,
    }).success).toBe(true);
    expect(ReadingSaveInputSchema.safeParse({
      url: context.url,
      title: context.title,
      quote: 'x'.repeat(12_001),
    }).success).toBe(false);
    expect(ReadingTranslateInputSchema.safeParse({
      url: 'ftp://example.com/article',
      blocks: [{ id: 'p-1', text: 'A paragraph that needs translation.' }],
    }).success).toBe(false);
    expect(ReadingSaveInputSchema.safeParse({
      url: context.url,
      title: context.title,
      quote: context.selection.quote,
      anchor: { ...context.selection, startOffset: 4, endOffset: 2 },
    }).success).toBe(false);
  });

  it('keeps reading result citations tied to HTTP sources', () => {
    expect(ReadingResultSchema.safeParse({
      operation: 'explain',
      original: 'A paragraph',
      suggestion: '解释',
      citations: [{ quote: 'A paragraph', url: context.url, anchor: null }],
    }).success).toBe(true);
    expect(ReadingResultSchema.safeParse({
      operation: 'explain',
      original: 'A paragraph',
      suggestion: '解释',
      citations: [{ quote: 'A paragraph', url: 'file:///tmp/page' }],
    }).success).toBe(false);
  });

  it('bounds local-first provider, image and saved insight records', () => {
    expect(ProviderConfigSchema.safeParse({
      baseUrl: 'https://api.example.com/v1', model: 'text-model', visionModel: 'vision-model', language: 'zh-CN',
    }).success).toBe(true);
    expect(ImageTextRegionSchema.safeParse({ text: 'API', translation: '接口', x: 1, y: 2, width: 30, height: 12 }).success).toBe(true);
    expect(TranslationJobSchema.safeParse({ id: 'image-1', documentUrl: context.url, kind: 'image', status: 'queued' }).success).toBe(true);
    expect(SavedInsightSchema.safeParse({
      id: 'insight-1',
      document: { url: context.url, title: context.title, version: null },
      quote: context.selection.quote,
      note: '',
      createdAt: new Date().toISOString(),
    }).success).toBe(true);
  });

  it('requires annotations to retain a bounded source anchor', () => {
    const now = new Date().toISOString();
    expect(AnnotationSchema.safeParse({
      id: 'annotation-1',
      document: { url: context.url, title: context.title, version: 'sha256:test' },
      anchor: { quote: context.selection.quote, prefix: 'The ', suffix: ' context.' },
      note: 'Check this assumption later.',
      createdAt: now,
      updatedAt: now,
    }).success).toBe(true);
    expect(AnnotationSchema.safeParse({
      id: 'annotation-2',
      document: { url: 'file:///tmp/page', title: context.title },
      anchor: { quote: 'text' },
      createdAt: now,
    }).success).toBe(false);
    expect(AnnotationSchema.safeParse({
      id: 'annotation-3',
      document: { url: context.url, title: context.title },
      anchor: { quote: 'text', startOffset: 9, endOffset: 2 },
      createdAt: now,
    }).success).toBe(false);
  });

  it('keeps explicit session sync bounded and excludes page text', () => {
    expect(ReadingSessionSyncInputSchema.safeParse({
      clientId: UUID,
      idempotencyKey: UUID,
      document: { url: context.url, title: context.title, version: 'sha256:test' },
      state: {
        radarSummaryId: UUID,
        selection: { quote: context.selection.quote, prefix: '', suffix: '' },
        answer: 'A reusable conclusion',
        discussion: [{ role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Because.' }],
        discussionScope: 'selection',
        scrollY: 120,
        scrollHeight: 1600,
      },
    }).success).toBe(true);
    expect(ReadingSessionSyncInputSchema.safeParse({
      clientId: UUID,
      idempotencyKey: UUID,
      document: { url: context.url, title: context.title },
      state: { radarSummaryId: 'not-a-uuid' },
    }).success).toBe(false);
    expect(ReadingSessionSyncInputSchema.safeParse({
      clientId: UUID,
      idempotencyKey: UUID,
      document: { url: context.url, title: context.title },
      state: { discussion: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })) },
    }).success).toBe(false);
  });
});
