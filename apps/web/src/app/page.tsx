import Link from 'next/link';
import { ArrowRight, Library, Newspaper, Radar, Search, Workflow, type LucideIcon } from 'lucide-react';

import { RecentActivityStrip } from '@/components/home/RecentActivityStrip';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';

/**
 * 首页：工程师的"晨报 + 调研入口"。
 *
 * UI 重设计第二轮（基于 ui-ux-pro-max 评审 + frontend-design skill）：
 *   1. 顶部加"最近活动"事件条（RecentActivityStrip），从 /api/summaries、
 *      /api/radar、/api/ai-research/jobs 拉最近 1+3+1 条。
 *      —— 数据库规则 #1：工程师首次访问要有价值信号，不必先点子页。
 *   2. 下方保留 4 个能力入口卡（产品本身是什么）。
 *   3. 未登录时事件条自动不渲染（fetch 会 401，整块 hide）。
 *
 * Admin 入口仅在 role === 'admin' 时由 AppShell 侧栏显示（前端显隐）；
 * 直链 /admin 仍会被服务端 requireAdmin() 拒绝（验收 2）。
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="技术调研平台"
        description="从信号发现到深度调研，再到调研库的长期归档 —— 一条链路上的四个环节。"
      />

      <RecentActivityStrip />

      <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <EntryCard
          href="/summaries"
          icon={Newspaper}
          title="AI 雷达日报"
          desc="每日汇总各源高分信号，链接雷达详情并可讨论"
        />
        <EntryCard
          href="/radar"
          icon={Radar}
          title="技术雷达"
          desc="候选池：论文、仓库、文章的 AI 解读与七维打分"
        />
        <EntryCard
          href="/ai-research"
          icon={Workflow}
          title="AI 调研"
          desc="主题 → 抓取 → 压缩 → 分析 → 写作，端到端产出草稿"
        />
        <EntryCard
          href="/researches"
          icon={Search}
          title="调研库"
          desc="长文与精华：调研结论的长期归档与检索"
        />
      </section>
    </div>
  );
}

function EntryCard({
  href,
  title,
  desc,
  icon: Icon,
}: {
  href: string;
  title: string;
  desc: string;
  icon: LucideIcon;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-lg border border-border bg-card p-4 transition-colors duration-200 hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <ArrowRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
    </Link>
  );
}

export { EmptyState };