'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Check, Lightbulb, Loader2, RotateCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import type { KnowledgeSourceKind } from '@/lib/knowledge-card';
import { cn } from '@/lib/utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface Preview {
  title: string;
  body: string;
  conclusion: string;
  tags: string[];
}

export function KnowledgeCardComposer({
  sourceKind,
  messageId,
}: {
  sourceKind: KnowledgeSourceKind;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [tags, setTags] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const deriveInFlight = useRef(false);

  if (!UUID_RE.test(messageId)) return null;

  async function derive() {
    if (deriveInFlight.current) return;
    deriveInFlight.current = true;
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/knowledge/derive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceKind, messageId }),
      });
      if (!response.ok) {
        throw new Error(friendlyMessage(await toApiHttpError(response, '提炼失败'), '提炼失败，请稍后重试。'));
      }
      const payload = await response.json() as { preview?: Preview };
      if (!payload.preview?.title || !payload.preview.body) throw new Error('没有生成有效的知识卡片预览');
      setPreview(payload.preview);
      setTitle(payload.preview.title);
      setBody(payload.preview.body);
      setConclusion(payload.preview.conclusion ?? '');
      setTags(payload.preview.tags.join('、'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提炼失败，请稍后重试。');
    } finally {
      deriveInFlight.current = false;
      setLoading(false);
    }
  }

  async function save() {
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle || !normalizedBody || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceKind,
          messageId,
          title: normalizedTitle,
          body: normalizedBody,
          conclusion: conclusion.trim(),
          tags: tags.split(/[,，、]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 10),
        }),
      });
      if (!response.ok) {
        throw new Error(friendlyMessage(await toApiHttpError(response, '保存失败'), '保存失败，请稍后重试。'));
      }
      const payload = await response.json() as { knowledge?: { id?: string } };
      if (!payload.knowledge?.id) throw new Error('保存结果无效，请稍后查看研究库');
      setSavedId(payload.knowledge.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2" data-knowledge-card-composer="true">
      {savedId ? (
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-status-success-fg">
          <Check className="size-3.5" />
          已保存知识卡片
          <Link href={`/researches/${savedId}`} className="font-medium text-primary hover:underline">查看</Link>
        </p>
      ) : (
        <>
          {!open ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => void derive()}>
              <Lightbulb className="size-3.5" />
              提炼为知识卡片
            </Button>
          ) : null}
          {open ? (
            <div className="rounded-md border border-method-ai/25 bg-method-ai/5 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold">知识卡片预览</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">保存前可以修改，确认后才会写入研究库。</p>
                </div>
                <button
                  type="button"
                  aria-label="关闭知识卡片预览"
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                  onClick={() => { setOpen(false); setError(null); }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {loading ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  <Loader2 className="size-3.5 animate-spin" />
                  正在提炼…
                </div>
              ) : preview ? (
                <div className="mt-3 grid gap-2">
                  <label className="grid gap-1 text-[11px] font-medium">
                    标题
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} className="h-8 bg-background text-xs" />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium">
                    核心结论
                    <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={50_000} rows={4} className="min-h-[96px] bg-background text-xs leading-5" />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium">
                    一句话结论
                    <Input value={conclusion} onChange={(event) => setConclusion(event.target.value)} maxLength={2_000} className="h-8 bg-background text-xs" />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium">
                    标签
                    <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用顿号或逗号分隔" maxLength={400} className="h-8 bg-background text-xs" />
                  </label>
                  {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
                  <div className="flex flex-wrap justify-end gap-2 pt-1">
                    <Button type="button" variant="ghost" size="xs" onClick={() => { setOpen(false); setPreview(null); setError(null); }} disabled={saving}>取消</Button>
                    <Button type="button" size="xs" onClick={() => void save()} disabled={!title.trim() || !body.trim() || saving}>
                      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      {saving ? '保存中…' : '保存知识卡片'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  <p
                    role={error ? 'alert' : 'status'}
                    className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
                  >
                    {error ?? '正在准备预览…'}
                  </p>
                  {error ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => void derive()} disabled={loading}>
                        {loading ? <Loader2 className="animate-spin" /> : <RotateCw />}
                        重试提炼
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => { setOpen(false); setError(null); }}
                        disabled={loading}
                      >
                        关闭
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
