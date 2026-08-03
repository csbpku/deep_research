import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';

const COPY: Record<string, { title: string; description: string }> = {
  favorites: { title: '我的收藏', description: '收藏的调研、雷达条目和精华，方便后续回看。' },
  topics: { title: '我的主题关注', description: '订阅关注的主题；命中后会在日报里优先排序。' },
  settings: { title: '个人设置', description: '个人偏好（主题、通知与可见性），仅作用于当前账户。' },
};

export default function MeTopicsPage() {
  const copy = COPY['topics'];
  return (
    <div className="mx-auto max-w-shell">
      <PageHeader title={copy.title} description={copy.description} />
      <EmptyState title="P1 阶段实现" description="占位页已接通 UserMenu；后续 P1 阶段会上线完整功能。" />
    </div>
  );
}
