import type { Prisma } from '@prisma/client';

type IndexTx = Pick<Prisma.TransactionClient, 'personalKnowledgeIndexTask'>;

export function readingKnowledgeIndexText(note: string, aiAnswer?: string | null): string | null {
  const sections = [
    note.trim() ? `我的笔记\n${note.trim()}` : '',
    aiAnswer?.trim() ? `确认的 AI 结论\n${aiAnswer.trim()}` : '',
  ].filter(Boolean);
  return sections.length ? sections.join('\n\n') : null;
}

export function confirmedKnowledgeIndexText(input: {
  title: string;
  body: string;
  conclusion?: string | null;
}): string {
  return [input.title.trim(), input.conclusion?.trim(), input.body.trim()]
    .filter(Boolean)
    .join('\n\n');
}

export function readingKnowledgeIndexTextFromBody(body: string): string | null {
  let section: 'note' | 'ai' | null = null;
  const note: string[] = [];
  const ai: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^## (我的笔记|AI 解读)\s*$/u.exec(line.trim());
    if (heading) {
      section = heading[1] === '我的笔记' ? 'note' : 'ai';
      continue;
    }
    if (/^##\s/u.test(line)) {
      section = null;
      continue;
    }
    if (section === 'note') note.push(line);
    if (section === 'ai') ai.push(line);
  }
  return readingKnowledgeIndexText(note.join('\n'), ai.join('\n'));
}

export async function queuePersonalKnowledgeIndex(
  tx: IndexTx,
  input: { ownerId: string; researchId: string; operation: 'upsert' | 'delete' },
): Promise<void> {
  await tx.personalKnowledgeIndexTask.upsert({
    where: { researchId: input.researchId },
    create: {
      ownerId: input.ownerId,
      researchId: input.researchId,
      operation: input.operation,
      status: 'queued',
      generation: 1,
    },
    update: {
      ownerId: input.ownerId,
      operation: input.operation,
      status: 'queued',
      generation: { increment: 1 },
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
    },
  });
}
