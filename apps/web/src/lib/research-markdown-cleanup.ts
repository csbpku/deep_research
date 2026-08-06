/** Remove browser-wrapper reference lines accidentally persisted in reports. */
export function cleanResearchMarkdown(content: string): string {
  let inReferences = false;
  let referenceNumber = 1;
  const lines = content.split('\n');
  const cleaned: string[] = [];

  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s+参考文献\s*$/u.test(line)) {
      inReferences = true;
      referenceNumber = 1;
      cleaned.push(line);
      continue;
    }
    if (inReferences && /^\s{0,3}#{1,6}\s+/u.test(line)) inReferences = false;
    if (/^\s*(?:\d+[.)]|[-*+])\s+.*\/goto\?url=/iu.test(line)) continue;
    if (inReferences && /^\s*\d+[.)]\s+/u.test(line)) {
      cleaned.push(line.replace(/^(\s*)\d+[.)](\s+)/u, `$1${referenceNumber++}.$2`));
      continue;
    }
    cleaned.push(line);
  }

  return cleaned.join('\n').replace(/\n{3,}/gu, '\n\n');
}
