export const LIBRARY_PAGE_SIZE = 12;

/** Search the complete collection before paging, including notes and answers. */
export function libraryPage(insights, annotations, { query = '', kind = 'all', page = 1 } = {}) {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  const all = [
    ...insights.map(record => ({ kind: 'insight', record })),
    ...annotations.map(record => ({ kind: 'annotation', record })),
  ];
  const matches = all.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    const record = item.record;
    const searchable = normalize([record.title, record.url, record.document?.title, record.document?.url,
      record.quote, record.anchor?.quote, record.note, record.aiAnswer, ...(record.tags || [])].join(' '));
    return terms.every(term => searchable.includes(term));
  }).sort((a, b) => String(b.record.updatedAt || b.record.createdAt || '').localeCompare(String(a.record.updatedAt || a.record.createdAt || ''))
    || `${a.kind}:${a.record.id}`.localeCompare(`${b.kind}:${b.record.id}`));
  const pages = Math.max(1, Math.ceil(matches.length / LIBRARY_PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { items: matches.slice((current - 1) * LIBRARY_PAGE_SIZE, current * LIBRARY_PAGE_SIZE),
    total: matches.length, collectionTotal: all.length, page: current, pages };
}

/** Undo stays in this panel's memory; never overwrite a record restored elsewhere. */
export function createLibraryDeletion(store) {
  const deleted = [];
  let queue = Promise.resolve();
  const run = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const methods = kind => {
    if (kind === 'insight') return { list: () => store.listInsights(), remove: id => store.deleteInsight(id), save: record => store.saveInsight(record) };
    if (kind === 'annotation') return { list: () => store.listAnnotations(), remove: id => store.deleteAnnotation(id), save: record => store.saveAnnotation(record) };
    throw new Error('Unknown library record type');
  };
  return {
    get count() { return deleted.length; },
    remove(kind, record) {
      return run(async () => {
        const access = methods(kind);
        const current = (await access.list()).find(item => item.id === record.id);
        if (!current) return null;
        const snapshot = structuredClone(current);
        await access.remove(snapshot.id);
        deleted.push({ kind, record: snapshot });
        return snapshot;
      });
    },
    undo: () => run(async () => {
      const item = deleted.at(-1);
      if (!item) return null;
      const access = methods(item.kind);
      const exists = (await access.list()).some(record => record.id === item.record.id);
      if (!exists) await access.save(item.record);
      deleted.pop();
      return { ...item, restored: !exists };
    }),
    reset: () => run(() => { deleted.length = 0; }),
  };
}
