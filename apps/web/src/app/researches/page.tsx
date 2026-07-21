import { EmptyState } from '../../components/EmptyState.js';

export default function ResearchesPage() {
  return (
    <div>
      <h1 style={{ fontSize: 22 }}>沉淀</h1>
      <p style={{ color: '#475569' }}>Week 3 实现 CRUD；Week 4 实现导入预览与全文搜索。</p>
      <EmptyState
        title="占位"
        description="草稿仅 owner 可见；发布后团队可见。creationMethod 区分 manual / ai_research / file_import。"
      />
    </div>
  );
}