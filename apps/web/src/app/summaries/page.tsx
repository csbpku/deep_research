import { EmptyState } from '../../components/EmptyState.js';

export default function SummariesPage() {
  return (
    <div>
      <h1 style={{ fontSize: 22 }}>每日摘要</h1>
      <p style={{ color: '#475569' }}>Week 2 实现：抓取 ingestion + 列表/详情/日期切换/空状态。</p>
      <EmptyState
        title="占位"
        description="本页面在 Week 2 接入 RSS / arxiv / GitHub 至少两类稳定来源，统一规范化 URL/标题/发布时间/来源类型。"
      />
    </div>
  );
}