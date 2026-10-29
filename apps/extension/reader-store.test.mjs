import test from 'node:test';
import assert from 'node:assert/strict';
import { readerStore } from './reader-store.js';

const turn = index => [{ role: 'user', content: `Question ${index}` }, { role: 'assistant', content: `Answer ${index}` }];

test('reading the same article restores all turns across versioned snapshots without duplicates', async () => {
  const url = 'https://history.test/article';
  const first = turn(1);
  const second = [...first, ...turn(2)];
  await readerStore.saveSession({ url, version: 'v1', discussion: first, answer: 'Answer 1' });
  await readerStore.saveSession({ url, version: 'v2', discussion: second, answer: 'Answer 2' });
  await readerStore.saveSession({ url, version: 'v3', discussion: [], answer: '' });
  const restored = await readerStore.getReadingSession(url, 'v3');
  assert.deepEqual(restored.discussion, second);
  assert.equal(restored.stale, true);
  assert.equal(restored.answer, 'Answer 2');
  assert.equal(await readerStore.getReadingSession('https://other.test/article', 'v3'), null);
});

test('conversation persistence retains more than ten turns and never creates a saved insight', async () => {
  const url = 'https://history.test/long';
  const discussion = Array.from({ length: 16 }, (_, index) => turn(index)).flat();
  const before = (await readerStore.listInsights()).length;
  await readerStore.saveSession({ url, version: 'v1', discussion, answer: 'Answer 15' });
  await readerStore.saveSession({ url, version: 'v1', discussion: [], answer: '' });
  assert.equal((await readerStore.getReadingSession(url, 'v1')).discussion.length, 32);
  assert.equal((await readerStore.listInsights()).length, before);
});

const radarId = '10000000-0000-4000-8000-000000000001';
const researchId = '10000000-0000-4000-8000-000000000002';

test('one saved record owns both its excerpt and optional highlight through edits and export', async () => {
  const url = 'https://unified.test/article';
  const document = { url, title: 'Unified', version: 'a'.repeat(64) };
  const anchor = { quote: 'Original excerpt', startOffset: 0, endOffset: 16, contentHash: document.version };
  const record = await readerStore.saveInsight({ id: 'unified', url, document, quote: anchor.quote, anchor, highlight: true, note: 'Note', aiAnswer: 'AI', tags: ['tag'] });
  assert.equal((await readerStore.findInsightForSource(record)).id, record.id);
  assert.equal((await readerStore.listAnnotations()).filter(item => item.insightId === record.id).length, 1);
  const exported = await readerStore.exportData();
  assert.equal(exported.insights.filter(item => item.id === record.id).length, 1);
  assert.equal(exported.annotations.filter(item => item.id === record.id).length, 0);
  await readerStore.importData(exported);
  assert.equal((await readerStore.listAnnotations()).find(item => item.insightId === record.id).note, 'Note');
  await readerStore.saveInsight({ ...record, highlight: false });
  assert.equal((await readerStore.listAnnotations()).some(item => item.insightId === record.id), false);
  await readerStore.saveInsight({ ...record, quote: 'Edited excerpt' });
  assert.equal((await readerStore.listAnnotations()).some(item => item.insightId === record.id), false);
  await readerStore.deleteInsight(record.id);
  assert.equal((await readerStore.listAnnotations()).some(item => item.insightId === record.id), false);
});

test('editing a legacy annotation preserves its identity and data in the unified record', async () => {
  const document = { url: 'https://legacy.test/article', title: 'Legacy', version: 'b'.repeat(64) };
  const anchor = { quote: 'Legacy excerpt', contentHash: document.version };
  await readerStore.saveAnnotation({ id: 'legacy', document, anchor, note: 'Legacy note' });
  const record = await readerStore.saveInsight({ id: 'legacy', url: document.url, document, anchor, quote: anchor.quote, note: 'Updated note', highlight: true }, { legacyAnnotationId: 'legacy' });
  const data = await readerStore.exportData();
  assert.equal(data.annotations.some(item => item.id === record.id), false);
  assert.equal(data.insights.find(item => item.id === record.id).note, 'Updated note');
  assert.equal((await readerStore.listAnnotations()).filter(item => item.id === record.id).length, 1);
  await readerStore.deleteInsight(record.id);
});

test('knowledge identity drops only known tracking and reader hints, not session or page identity', () => {
  const base = 'https://recall.test/article?a=1&b=2';
  assert.equal(readerStore.knowledgePageKey(`${base}&utm_source=radar&fbclid=click&gclid=ad&deep-research-summary=${radarId}#section`), base);
  assert.equal(readerStore.knowledgePageKey('https://recall.test/article?b=2&a=1'), base);
  assert.notEqual(readerStore.knowledgePageKey(`${base}&page=2`), base);
  assert.notEqual(readerStore.pageKey(`${base}&utm_source=radar`), readerStore.pageKey(base));
  for (const url of ['javascript:alert(1)', 'file:///article', 'https://user:secret@recall.test/article', 'not a url', null]) {
    assert.equal(readerStore.knowledgePageKey(url), '');
  }
});

test('radar provenance is explicit, same-page only and frozen at capture', async () => {
  const context = { url: 'https://capture.test/a', radarSummaryId: radarId };
  const captured = readerStore.captureInsightSource({ url: `${context.url}?utm_source=radar#section`, quote: 'Excerpt' }, context);
  context.url = 'https://capture.test/b';
  context.radarSummaryId = researchId;
  assert.equal(captured.radarSummaryId, radarId);
  assert.equal(readerStore.captureInsightSource({ url: 'https://capture.test/a' }, context).radarSummaryId, undefined);
  assert.equal(readerStore.captureInsightSource({ url: context.url, radarSummaryId: undefined }, context).radarSummaryId, undefined);
  assert.equal(readerStore.captureInsightSource({ url: context.url, radarSummaryId: radarId }, context).radarSummaryId, radarId);
  const invalid = await readerStore.saveInsight({ id: 'invalid-radar', url: context.url, quote: 'Excerpt', radarSummaryId: 'not-a-uuid' });
  assert.equal(invalid.radarSummaryId, undefined);
});

test('same-page recall returns at most three confirmed records, labels stale versions, never promotes session answers', async () => {
  const url = 'https://confirmed.test/article?item=1';
  await readerStore.saveSession({ url, version: 'v2', answer: 'Unconfirmed AI answer', discussion: turn(1) });
  assert.deepEqual(await readerStore.listPageKnowledge(url), []);
  await readerStore.saveInsight({ id: 'confirmed-ai', url, document: { url, version: 'v1' }, quote: 'Evidence', aiAnswer: 'Confirmed AI conclusion' });
  await readerStore.saveAnnotation({ id: 'confirmed-note', document: { url, version: 'v1' }, anchor: { quote: 'Original' }, note: 'My note' });
  await readerStore.saveInsight({ id: 'different-page', url: `${url}&page=2`, quote: 'Other page' });
  const remote = Array.from({ length: 4 }, (_, i) => ({
    id: `20000000-0000-4000-8000-00000000000${i}`, url: `${url}&utm_medium=reader#intro`,
    title: `Saved ${i}`, conclusion: `Confirmed ${i}`, status: 'draft', updatedAt: '2020-01-01T00:00:00Z',
  }));
  const items = await readerStore.listPageKnowledge(`${url}#intro`, { version: 'v2', platformItems: remote, origin: 'https://platform.test' });
  assert.equal(items.length, 3);
  assert.equal(items.find(item => item.id === 'confirmed-ai').aiAnswer, 'Confirmed AI conclusion');
  assert.equal(items.find(item => item.id === 'confirmed-note').note, 'My note');
  assert.ok(items.filter(item => item.kind !== 'platform').every(item => item.stale));
  assert.ok(items.every(item => !String(item.quote).includes('Other page')));
  assert.deepEqual(await readerStore.listPageKnowledge('https://confirmed.test/other', { platformItems: remote, origin: 'https://platform.test' }), []);
});

test('platform links merge into the current insight, deduplicate recall and disappear when disconnected', async () => {
  const url = 'https://linked.test/article';
  await readerStore.saveInsight({ id: 'linked', url, quote: 'Original' });
  await readerStore.saveInsight({ id: 'linked', url, quote: 'Edited while sync was in flight', radarSummaryId: radarId });
  const linked = await readerStore.linkInsightToPlatform('linked', researchId, 'https://platform.test/');
  assert.equal(linked.quote, 'Edited while sync was in flight');
  assert.equal(linked.radarSummaryId, radarId);
  assert.equal(linked.platformResearchId, researchId);
  assert.equal(linked.platformOrigin, 'https://platform.test');
  const platformItems = [
    { id: researchId, url, conclusion: 'Synced copy', status: 'draft' },
    { id: radarId, url, conclusion: 'Archived', status: 'archived' },
  ];
  const connected = await readerStore.listPageKnowledge(url, { platformItems, origin: 'https://platform.test' });
  assert.equal(connected.length, 1);
  assert.equal(connected[0].platformResearchId, researchId);
  for (const origin of ['', 'https://other-platform.test']) {
    const disconnected = await readerStore.listPageKnowledge(url, { platformItems: origin ? [] : platformItems, origin });
    assert.equal(disconnected.length, 1);
    assert.equal(disconnected[0].platformResearchId, undefined);
  }
  await readerStore.deleteInsight('linked');
  assert.equal(await readerStore.linkInsightToPlatform('linked', researchId, 'https://platform.test'), null);
  assert.equal(await readerStore.linkInsightToPlatform('invalid-radar', 'not-a-uuid', 'https://platform.test'), null);
});

test('bulk translation cache retains the newest 500 entries and supports an ordered sparse read', async () => {
  await readerStore.clearCache();
  const entries = Array.from({ length: 520 }, (_, i) => ({ key: `bulk-${i}`, value: `Translation ${i}` }));
  await readerStore.cacheTranslations(entries);
  const cache = await readerStore.getCachedTranslations(['bulk-0', 'bulk-19', 'bulk-20', 'bulk-519', 'absent']);
  assert.deepEqual([...cache.values()], [null, null, 'Translation 20', 'Translation 519', null]);
  assert.equal((await readerStore.exportData()).cache, undefined);
  await readerStore.clearCache();
});
