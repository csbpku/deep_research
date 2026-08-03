import Link from 'next/link';
import {
  Radar as RadarIcon,
  Rocket,
  Search as SearchIcon,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import { RecentActivityStrip } from '@/components/home/RecentActivityStrip';
import { PageHeader } from '@/components/domain/PageHeader';
import { Button } from '@/components/ui/button';

/**
 * 首页：工程师的"晨报 + 调研入口"。
 *
 * UI 重设计第三轮：
 *   1. 顶部 PageHeader 一句话点题
 *   2. RecentActivityStrip：拿最近的日报 / 候选 / AI 任务作为状态信号
 *   3. "快速开始"一行：3 个动作（提交 AI 调研 / 浏览技术雷达 / 打开搜索），
 *      不再堆 4 张卡 —— 调研库、AI 雷达日报等入口全部经侧栏导航
 *   4. Admin 入口由 AppShell 侧栏控制（前端显隐）；直链 /admin 仍被服务端拦截
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="技术调研平台"
        description="从信号发现到深度调研，再到调研库的长期归档 —— 一条链路上的四个环节。"
      />

      <RecentActivityStrip />

      <section
        aria-label="快速开始"
        className="mt-5 flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-3"
      >
        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:shrink-0">
          快速开始
        </p>
        <QuickAction
          href="/ai-research"
          icon={Rocket}
          label="提交 AI 调研"
          desc="主题 → 抓取 → 写作，端到端"
          primary
        />
        <QuickAction
          href="/radar"
          icon={RadarIcon}
          label="浏览技术雷达"
          desc="候选池与每日评分"
        />
        <QuickAction
          href="/search"
          icon={SearchIcon}
          label="打开搜索"
          desc="跨雷达 / 摘要 / 长文检索"
        />
      </section>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  desc,
  primary = false,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  desc: string;
  primary?: boolean;
}) {
  return (
    <Button
      asChild
      variant={primary ? 'default' : 'outline'}
      size="sm"
      className="h-auto justify-start gap-2 px-3 py-2"
    >
      <Link href={href} className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span className="flex flex-col items-start text-left">
          <span className="text-sm font-medium leading-tight">{label}</span>
          <span className="text-[11px] font-normal leading-tight text-muted-foreground">
            {desc}
          </span>
        </span>
      </Link>
    </Button>
  );
}
