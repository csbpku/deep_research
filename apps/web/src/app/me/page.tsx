// /me — "我的"汇总页 (P1-C)
//
// Server Component 入口：未登录 redirect 到 /signin。
// 三个区块：草稿 / 收藏 / 模板 / 设置；设置使用独立子组件承载 client 表单。
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { EmptyState } from '@/components/EmptyState';
import { hydrateBookmarks } from '@/lib/me/bookmarks';
import { MeWorkspace } from './MeWorkspace';

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/me');

  // 服务端直查 drafts / bookmarks / templates 三个小列表（每张表 ≤20）
  const [drafts, bookmarks, templates] = await Promise.all([
    prisma.research.findMany({
      where: { authorId: user.id, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { id: true, title: true, updatedAt: true },
    }),
    prisma.userBookmark.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.researchTemplate.findMany({
      where: { ownerId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    }),
  ]);

  const bookmarkViews = await hydrateBookmarks(bookmarks);

  return (
    <div className="mx-auto max-w-shell">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">我的</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          草稿、收藏、调研模板、个性化设置。
        </p>
      </header>
      {drafts.length === 0 && bookmarks.length === 0 && templates.length === 0 ? (
        <EmptyState
          title="这里还空着"
          description="你可以在 雷达 收藏内容，或在调研库 新建草稿 / 保存模板。"
        />
      ) : null}
      <MeWorkspace
        userEmail={user.email}
        initial={{
          drafts: drafts.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() })),
          bookmarks: bookmarkViews,
          templates: templates.map((t) => ({
            id: t.id,
            title: t.title,
            topic: t.topic,
            background: t.background,
            reportType: t.reportType,
            sourcePolicy: t.sourcePolicy,
            tags: t.tags,
            useCount: t.useCount,
            lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
          })),
        }}
      />
    </div>
  );
}
