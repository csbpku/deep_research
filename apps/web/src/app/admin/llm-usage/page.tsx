import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/EmptyState';
import { getCurrentUser } from '@/lib/auth/session';
import LlmUsageConsole from './LlmUsageConsole';

export default async function AdminLlmUsagePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/admin/llm-usage');
  if (user.role !== 'admin') {
    return (
      <div className="mx-auto max-w-measure">
        <h1 className="mb-4 text-xl font-semibold tracking-normal">LLM 用量</h1>
        <EmptyState title="403 — 需要管理员权限" description="仅管理员可以查看模型调用与成本审计。" />
      </div>
    );
  }
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">LLM 用量审计</h1>
          <p className="mt-1 text-sm text-muted-foreground">模型调用、限额降级、token 与已知成本。</p>
        </div>
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin">返回 Admin</Link>
      </div>
      <LlmUsageConsole />
    </main>
  );
}
