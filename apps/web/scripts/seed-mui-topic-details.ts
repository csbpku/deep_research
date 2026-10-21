import type { Prisma } from '@prisma/client';

/** Called only inside the guarded, empty-database fixture transaction. No worker/LLM calls. */
export async function seedMuiTopicDetails(tx: Prisma.TransactionClient, topics: Array<{ id: string }>, authorId: string, start: Date, end: Date) {
  const source = await tx.radarSource.create({ data: { name: 'MUI 隔离来源（禁止同步）', sourceType: 'rss', config: {}, enabled: false } });
  const run = await tx.radarSyncRun.create({ data: { sourceId: source.id, triggeredBy: 'admin', status: 'completed', completedAt: end } });
  const references: Array<{ summaryId: string; title: string }> = [];
  for (let index = 0; index < 15; index++) {
    const summary = await tx.summary.create({ data: {
      title: `MUI 证据 ${index + 1}：编码代理的独立实验与可复现工程验证`,
      body: '只用于本地浏览器的合成证据，不是实际研究结论。',
      url: `https://example.com/mui-detail-${index + 1}`, canonicalUrl: `https://example.com/mui-detail-${index + 1}`,
      source: 'daily', summaryDate: end, publishedAt: index === 14 ? null : end, status: 'candidate', originalKind: 'rss',
      interpretation: '隔离测试判断：先核对来源证据，再决定是否用于团队研究。长标识符 RetrievalAugmentedGenerationWithoutSpacesForResponsiveLayoutVerification。',
      tags: ['external_reading', '合成测试'], syncRunId: run.id, distilledTier: 'deep_read', distilledTotal: 70,
      distilledScore: { isDefault: false, dimensions: { informationGain: 2, analysisDepth: 2, actionability: 2, factualReliability: 2, currentApplicability: 2, expressionQuality: 2, audienceFit: 2 }, total: 70, profile: 'tech_blog', version: 'mui-fixture-v1', tier: 'deep_read' },
      topicLinks: { create: { topicId: topics[1]!.id, addedAt: end } },
    } });
    references.push({ summaryId: summary.id, title: summary.title });
    if (index < 14) await tx.topicIssue.create({ data: {
      topicId: topics[1]!.id, kind: index % 2 ? 'problem' : 'event', title: `MUI 独立议题 ${index + 1}：不同实验边界与结论核对`,
      proposition: `第 ${index + 1} 个独立合成命题，使用独立证据测试重要度排序与增量加载。`,
      importanceScore: 20 - index, firstSeenAt: start, lastSeenAt: end,
      candidates: { create: { summaryId: summary.id } },
    } });
  }
  await tx.topic.update({ where: { id: topics[1]!.id }, data: {
    candidateCount: 15, sourceCount: 1, lastSynthesisSuccessAt: end,
    synthesisPayload: {
      tldr: '隔离综述：把代理能力变化和独立证据分开核对，避免把视觉演示当成研究结论。',
      keyChanges: [{ title: '先验证工程边界，再判断是否推广', whyItMatters: '不同实验条件会改变结论，完整证据必须可回溯。', summaryIds: [references[0]!.summaryId, references[0]!.summaryId, references[1]!.summaryId] }],
      subtopics: [{ title: '可复现验证', summary: '保留实验条件、版本与反例。' }],
      openQuestions: ['跨项目结果是否稳定？', '尚未覆盖的失败边界有哪些？'],
      sections: [{ title: '验证边界与限制', content: '这是一段用于排版和交互验收的合成综述。\n保留原有换行，以及证据关联和阅读层级。'.repeat(5), summaryIds: [references[1]!.summaryId] }],
      references: [references[0]!, references[1]!, references[0]!],
    },
  } });
  await tx.topic.update({ where: { id: topics[3]!.id }, data: { synthesisErrorCode: 'MUI_TEST_UNAVAILABLE', synthesisErrorMessage: '仅管理员可见的合成诊断信息' } });
  await tx.topic.update({ where: { id: topics[4]!.id }, data: { lastSynthesisSuccessAt: end, synthesisPayload: { tldr: '只有来源清单、没有关键变化的合成综述。', references: [references[0]!, references[1]!, references[0]!] } } });
  await tx.research.create({ data: { type: 'research', status: 'published', title: 'MUI 专题详情的团队研究：真实链接与共享层级', body: '仅用于隔离验收。', authorId, publishedAt: end, researchTopics: { create: { topicId: topics[1]!.id } } } });
}
