import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { Info } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, type StatusKind } from './StatusBadge';
import { SectionCard } from './SectionCard';
import { StatCard } from './StatCard';
import { TagChip, TagList } from './TagChip';
import { domainAppearance, domainPalettes } from './appearance';
import { readingTierColor } from './ScoreBar';

const labels: [StatusKind, string, string][] = [
  ['job', 'queued', '排队中'], ['job', 'running', '进行中'], ['job', 'partial', '部分完成'],
  ['job', 'succeeded', '已完成'], ['job', 'failed', '失败'], ['job', 'cancelled', '已取消'],
  ['radar', 'candidate', '雷达内容'], ['radar', 'pending_review', '待审核'],
  ['radar', 'published', '历史精选'], ['radar', 'rejected', '已屏蔽'], ['radar', 'archived', '已归档'],
  ['research', 'draft', '草稿'], ['research', 'published', '已发布'], ['research', 'archived', '已归档'],
  ['method', 'manual', '手写'], ['method', 'ai_research', 'AI 调研'],
  ['method', 'file_import', '文件导入'], ['method', 'confluence_import', 'Confluence'],
  ['featured', 'true', '精华'], ['researchType', 'research', '研究报告'], ['researchType', 'knowledge', '知识卡片'],
  ['topicTier', 'hot', '热门'], ['topicTier', 'warming', '升温中'], ['topicTier', 'emerging', '新出现'],
  ['issue', 'info', '信息'], ['issue', 'warn', '提示'], ['issue', 'error', '异常'], ['issue', 'success', '已处理'],
  ['searchType', 'radar', '雷达'], ['searchType', 'summary', '摘要'],
  ['searchType', 'research', '研究报告'], ['searchType', 'knowledge', '知识卡片'], ['searchType', 'all', '全部'],
];

describe('Material domain components', () => {
  it.each([
    ['deep_read', 'var(--dr-color-tier-deep-read)'],
    ['collection', 'var(--dr-color-tier-deep-read)'],
    ['skim', 'var(--dr-color-tier-skim)'],
    ['noise', 'var(--dr-color-tier-noise)'],
    ['unknown', 'var(--dr-color-text-secondary)'],
  ])('maps reading tier %s to shared semantic color', (tier, color) => {
    expect(readingTierColor(tier)).toBe(color);
  });

  it.each(labels)('preserves %s/%s label %s', (kind, value, label) => {
    const html = render(h(StatusBadge, { kind, value }));
    expect(html).toContain(`data-status-kind="${kind}"`);
    expect(html).toContain(`data-status-value="${value}"`);
    expect(html).toContain(label);
    expect(html).toContain('MuiChip-root');
    expect(html).not.toMatch(/(?:bg|text)-(?:status|radar|tier)-/);
  });

  it('keeps empty/featured visibility rules, overrides and unknown values', () => {
    expect(render(h(StatusBadge, { kind: 'featured', value: 'false' }))).toBe('');
    expect(render(h(StatusBadge, { kind: 'job', value: 'failed', label: '' }))).toBe('');
    expect(render(h(StatusBadge, { kind: 'featured', value: 'false', label: '保留' }))).toContain('保留');
    expect(render(h(StatusBadge, { kind: 'featured', value: 'false', icon: h(Info) }))).toContain('<svg');
    const html = render(h(StatusBadge, { kind: 'job', value: '<unknown>', label: '用户可读状态', title: '完整状态', 'aria-label': '任务状态', className: 'consumer-layout', style: { marginTop: 8 } }));
    expect(html).toContain('用户可读状态');
    expect(html).toContain('title="完整状态"');
    expect(html).toContain('aria-label="任务状态"');
    expect(html).toContain('consumer-layout');
    expect(html).toContain('margin-top:8px');
    expect(render(h(StatusBadge, { kind: 'job', value: '<unknown>' }))).toContain('&lt;unknown&gt;');
    expect(render(h(StatusBadge, { kind: 'job', value: 'toString' }))).toContain('toString');
    expect(render(h(StatusBadge, { kind: 'job', value: '__proto__' }))).toContain('__proto__');
  });

  it('keeps creation-method outlines distinct from job fills', () => {
    expect(render(h(StatusBadge, { kind: 'method', value: 'ai_research' }))).toContain('MuiChip-outlined');
    expect(render(h(StatusBadge, { kind: 'job', value: 'running' }))).toContain('MuiChip-filled');
  });

  it.each(['default', 'muted', 'accent', 'info', 'success', 'warning', 'destructive'] as const)('renders %s sections on the server', tone => {
    const html = render(h(SectionCard, { title: '章节', tone, children: h('p', null, '内容') }));
    expect(html).toContain('<section');
    expect(html).toContain('MuiPaper-root');
    expect(html).toMatch(/<h2[^>]*>.*章节<\/h2>/);
    expect(html).toContain('<p>内容</p>');
    expect(html.includes('<svg')).toBe(!['default', 'muted'].includes(tone));
  });

  it('renders icon functions before the client boundary, spacing variants and actions-only headers', () => {
    const html = render(h(SectionCard, { icon: Info, title: '正文', children: '正文内容', bodySpacing: 'top', variant: 'reading' }));
    expect(html).toContain('<svg');
    expect(html).toContain('data-body-spacing="top"');
    expect(html).toContain('data-section-variant="reading"');
    const actions = render(h(SectionCard, { actions: h('button', null, '操作'), children: '内容', bodySpacing: 'none' }));
    expect(actions).toContain('<header');
    expect(actions).not.toContain('<h2');
    expect(actions).toContain('data-body-spacing="none"');
  });

  it('preserves numeric zero, hint and compact stat appearance', () => {
    const html = render(h(StatCard, { label: '任务', value: 0, hint: '没有待办', variant: 'grid', density: 'compact', tone: 'primary' }));
    expect(html).toContain('>0</div>');
    expect(html).toContain('没有待办');
    expect(html).toContain('data-stat-density="compact"');
    expect(html).toContain('data-stat-variant="grid"');
  });

  it('keeps native tag links, escaped text and group attributes', () => {
    const html = render(h(TagList, { 'aria-label': '标签', children: [
      h(TagChip, { key: 1, href: '/researches?tag=a%26b', children: '<a&b>' }),
      h(TagChip, { key: 2, children: '纯文本' }),
    ] }));
    expect(html).toContain('aria-label="标签"');
    expect(html).toContain('href="/researches?tag=a%26b"');
    expect(html).toContain('&lt;a&amp;b&gt;');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain('<button');
    expect(html).toContain('纯文本');
  });

  it('uses shared semantic CSS variables only', () => {
    for (const palette of Object.keys(domainPalettes) as (keyof typeof domainPalettes)[]) {
      const appearance = domainAppearance(palette);
      expect(appearance.color).toMatch(/^var\(--dr-color-[a-z-]+\)$/);
      expect(appearance.backgroundColor).toMatch(/^var\(--dr-color-[a-z-]+\)$/);
    }
  });
});
