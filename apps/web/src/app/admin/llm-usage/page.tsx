import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { getCurrentUser } from '@/lib/auth/session';
import LlmUsageConsole from './LlmUsageConsole';

export default async function AdminLlmUsagePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/admin/llm-usage');
  if (user.role !== 'admin') {
    return (
      <div className="mx-auto max-w-measure">
        <PageHeader title="Admin" description="Admin 控制台 · 仅管理员可见" />
        <EmptyState title="403 — 需要管理员权限" description="仅管理员可以查看模型调用与成本审计。" />
      </div>
    );
  }
  return (
    <main className="mx-auto max-w-shell px-4 py-8 sm:px-6">
      <PageHeader
        title="LLM 用量审计"
        description="模型调用、限额降级、token 与已知成本。"
        actions={
          <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin">
            返回 Admin
          </Link>
        }
      />
      <LlmUsageConsole />
    </main>
  );
}
