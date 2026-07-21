import { EmptyState } from '../../components/EmptyState.js';

export default function AiResearchPage() {
  return (
    <div>
      <h1 style={{ fontSize: 22 }}>AI 调研</h1>
      <p style={{ color: '#475569' }}>
        Week 6 实现端到端：主题提交 → 抓取 → 压缩 → 写作 → 私有草稿 → 编辑发布。
      </p>
      <EmptyState
        title="占位"
        description="团队 20 次/日 + 个人 5 次/日硬预算；source policy: prefer_user_sources / only_user_sources。"
      />
    </div>
  );
}