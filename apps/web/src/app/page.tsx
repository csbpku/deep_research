import Link from 'next/link';
import {
  FilePlus2,
  Rocket,
  type LucideIcon,
} from 'lucide-react';

import { RecentActivityStrip } from '@/components/home/RecentActivityStrip';
import { PageHeader } from '@/components/domain/PageHeader';
import { Button } from '@/components/ui/button';

/**
 * 首页：工程师的"今日研究概览"。
 *
 * UI 重设计第三轮：
 *   1. 顶部 PageHeader 保留稳定的产品标题，描述改为每日工作语境
 *   2. RecentActivityStrip：最新日报 + 按 Distilled 分数排序的今日高信号
 *   3. "开始研究"一行：2 个创作动作（AI 调研 / 新建调研）；
 *      新建调研页内再选择空白创建或文件导入；
 *      搜索和雷达浏览已有全局/侧栏入口，不在首页重复
 *   4. Admin 入口由 AppShell 侧栏控制（前端显隐）；直链 /admin 仍被服务端拦截
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="AI技术调研平台"
        description="从今天的高信号开始，把值得复用的结论沉淀下来。"
      />

      <RecentActivityStrip />

      <section
        aria-label="开始研究"
        className="mt-5 flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-3"
      >
        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:shrink-0">
          开始研究
        </p>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
          <QuickAction
            href="/ai-research"
            icon={Rocket}
            label="提交 AI 调研"
            desc="主题 → 抓取 → 写作，端到端"
            primary
          />
          <QuickAction
            href="/researches/new"
            icon={FilePlus2}
            label="新建调研"
            desc="空白创建或从文件导入"
          />
        </div>
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
      className="h-auto min-h-14 w-full justify-start gap-2 px-3 py-2"
    >
      <Link href={href} className="flex w-full items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span className="flex flex-col items-start text-left">
          <span className="text-sm font-medium leading-tight">{label}</span>
          <span
            className={`text-[11px] font-normal leading-tight ${
              primary ? 'text-primary-foreground/80' : 'text-muted-foreground'
            }`}
          >
            {desc}
          </span>
        </span>
      </Link>
    </Button>
  );
}
