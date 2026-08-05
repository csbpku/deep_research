'use client';

// /me 设置：preferences 表单。
// 仅展示已真正接入 AI 调研表单的偏好；未生效的配置不暴露给用户。
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface Preferences {
  defaultReportType?: 'research_report' | 'summary_brief';
  defaultSourcePolicy?: 'prefer_user_sources' | 'only_user_sources' | 'web_only';
  timezone?: string;
  notifyPrefs?: { commentReply?: boolean; shareApproved?: boolean; topicDigest?: boolean };
}

const ALL = '__all__';

export function PreferencesForm({ userEmail }: { userEmail: string }) {
  const q = useQuery<{ preferences: Preferences }>({
    queryKey: ['me-preferences'],
    queryFn: async () => {
      const r = await fetch('/api/me/preferences', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const [prefs, setPrefs] = useState<Preferences>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setPrefs(q.data.preferences ?? {});
  }, [q.data]);

  const saveMut = useMutation({
    mutationFn: async (next: Preferences) => {
      const r = await fetch('/api/me/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? '保存失败');
      }
      return r.json() as Promise<{ preferences: Preferences }>;
    },
    onSuccess: (res) => {
      setPrefs(res.preferences);
      setSavedAt(new Date().toLocaleTimeString('zh-CN'));
    },
  });

  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;

  return (
    <div className="grid gap-3">
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-sm font-medium">账号</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{userEmail}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-sm font-medium">默认报告类型</p>
            <p className="mt-0.5 text-xs text-muted-foreground">新建 AI 调研时默认的报告格式。</p>
          </div>
          <Select
            value={prefs.defaultReportType ?? ALL}
            onValueChange={(v) =>
              setPrefs((p) => ({
                ...p,
                defaultReportType: v === ALL ? undefined : (v as Preferences['defaultReportType']),
              }))
            }
          >
            <SelectTrigger className="w-40" aria-label="默认报告类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>未设置</SelectItem>
              <SelectItem value="research_report">完整调研报告</SelectItem>
              <SelectItem value="summary_brief">摘要简报</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-sm font-medium">默认来源策略</p>
            <p className="mt-0.5 text-xs text-muted-foreground">影响 AI 调研抓取来源的范围。</p>
          </div>
          <Select
            value={prefs.defaultSourcePolicy ?? ALL}
            onValueChange={(v) =>
              setPrefs((p) => ({
                ...p,
                defaultSourcePolicy: v === ALL ? undefined : (v as Preferences['defaultSourcePolicy']),
              }))
            }
          >
            <SelectTrigger className="w-40" aria-label="默认来源策略">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>未设置</SelectItem>
              <SelectItem value="prefer_user_sources">优先指定资料，可补充搜索</SelectItem>
              <SelectItem value="only_user_sources">仅使用指定资料</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saveMut.isPending}
          onClick={() => saveMut.mutate(prefs)}
        >
          {saveMut.isPending ? '保存中…' : '保存设置'}
        </Button>
        {savedAt ? (
          <p className="flex items-center gap-1 text-xs text-status-succeeded-fg">
            <CheckCircle2 className="size-3" />
            {savedAt} 已保存
          </p>
        ) : null}
        {saveMut.error ? (
          <p className="text-xs text-destructive">{(saveMut.error as Error).message}</p>
        ) : null}
      </div>
    </div>
  );
}
