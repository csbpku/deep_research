/** Split the self-check section into question / answer pairs without a model call. */
export interface SelfCheckItem {
  question: string;
  answer: string;
}

const SECTION = /^##\s+自检\s*$/mu;

function clean(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '[$1]')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function parseSelfCheck(body: string): SelfCheckItem[] {
  const lines = String(body ?? '').split(/\r?\n/u);
  const start = lines.findIndex(line => SECTION.test(line.trim()));
  if (start < 0) return [];
  const items: SelfCheckItem[] = [];
  let question: string | null = null;
  let answer: string[] = [];
  const flush = () => {
    if (question) items.push({ question: clean(question), answer: clean(answer.join(' ')) });
    question = null;
    answer = [];
  };
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) break;
    if (!line) continue;
    const numbered = line.match(/^\d+[.、]\s*(.+)$/u);
    if (numbered) {
      flush();
      const raw = numbered[1];
      const split = raw.split(/答案要点[:：]|答案[:：]/u);
      question = split[0].replace(/\*\*/gu, '').trim();
      if (split[1]) answer.push(split.slice(1).join(' '));
      continue;
    }
    if (question) answer.push(line);
  }
  flush();
  return items.filter(item => item.question && item.answer);
}
