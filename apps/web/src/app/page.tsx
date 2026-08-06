import Link from 'next/link';
import { Rocket } from 'lucide-react';

import { FollowedTopicsStrip } from '@/components/home/FollowedTopicsStrip';
import { LastSubmittedBanner } from '@/components/home/LastSubmittedBanner';
import { RecentActivityStrip } from '@/components/home/RecentActivityStrip';
import { RecentResearchStrip } from '@/components/home/RecentResearchStrip';
import { PageHeader } from '@/components/domain/PageHeader';
import { Button } from '@/components/ui/button';
import { getCurrentUser } from '@/lib/auth/session';

/**
 * 首页：工程师的"今日研究概览"。
 *
 * UI 重设计：
 *   1. PageHeader 保留产品标题 + 描述,右侧"提交 AI 调研"作为唯一主动作
 *   2. RecentActivityStrip：最新日报 + 按 Distilled 分数排序的今日高信号；
 *      团队区拆为"进行中的调研"（登录用户）和"待审核"（仅 admin）两块
 *   3. 登录态展开"调研库精选" + "我关注的主题"
 *   4. Admin 入口由 AppShell 侧栏控制（前端显隐）；直链 /admin 仍被服务端拦截
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  const loggedIn = !!user;
  const isAdmin = user?.role === 'admin';

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="AI技术调研平台"
        description="从今天的高信号开始，把值得复用的结论沉淀下来。"
        actions={
          <Button asChild size="sm">
            <Link href="/ai-research">
              <Rocket />
              提交 AI 调研
            </Link>
          </Button>
        }
      />

      <div className="mt-4">
        <LastSubmittedBanner />
      </div>

      <RecentActivityStrip loggedIn={loggedIn} isAdmin={isAdmin} />

      {loggedIn ? (
        <>
          <RecentResearchStrip />
          <FollowedTopicsStrip />
        </>
      ) : null}
    </div>
  );
}
