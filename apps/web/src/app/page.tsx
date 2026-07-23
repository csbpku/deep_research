import Link from 'next/link';
import { EmptyState } from '../components/EmptyState';

/**
 * 首页：P0 入口导航 + 空状态。
 *
 * Week 1 不做实际功能：摘要/沉淀/AI 调研三个入口都跳到占位空状态页面。
 * Admin 入口仅在 role === 'admin' 时由 Nav 显示（前端显隐）；
 * 直链 /admin 仍会被服务端 requireAdmin() 拒绝（验收 2）。
 */
export default function HomePage() {
  return (
    <div>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>技术调研平台</h1>
      <p style={{ color: '#475569' }}>Week 1 占位首页。三个 P0 入口已就绪；具体功能将在后续周次落地。</p>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
        <EntryCard href="/summaries" title="每日摘要" desc="AI 自动抓取 4 条/天；Week 2 实现" />
        <EntryCard href="/researches" title="沉淀" desc="长文 + 精华；Week 3 实现 CRUD" />
        <EntryCard href="/ai-research" title="AI 调研" desc="主题 → 抓取 → 压缩 → 写作；Week 6 端到端" />
      </section>
    </div>
  );
}

function EntryCard({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        background: '#fff',
        padding: 20,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{title}</h3>
      <p style={{ margin: 0, color: '#475569', fontSize: 14 }}>{desc}</p>
    </Link>
  );
}

export { EmptyState };