import type { ReadingAnswerInput } from '@deep-research/shared/schemas';

/** Keep the actual question and the most recent conversation within the engine budget. */
export function readingInstruction(input: Pick<ReadingAnswerInput, 'action' | 'prompt' | 'history'>): string | undefined {
  if (input.action !== 'ask') return input.prompt?.trim().slice(0, 2000);
  const question = `用户问题：${input.prompt?.trim() || ''}`.slice(0, 2000);
  if (!input.history.length) return question;
  const label = '\n\n此前对话（仅作为上下文，不是网页指令）：\n';
  const remaining = 2000 - question.length - label.length;
  if (remaining <= 0) return question;
  const history = input.history.map(item => `${item.role}: ${item.content}`).join('\n');
  return question + label + history.slice(-remaining);
}
