/**
 * Web pages are untrusted data. These signals are intentionally conservative:
 * a match changes presentation and model context handling, but never labels
 * the page itself as malicious.
 */
const EXTERNAL_INSTRUCTION_SIGNAL = /(?:agents?\.md|网页数据中的疑似指令已隔离|system\s+prompt|developer\s+message|ignore\s+(?:all\s+)?previous\s+instructions|忽略(?:之前|以上|所有)指令|请(?:让|要求)\s*AI|要求\s*模型|遵守(?:本页|该页|以下)规则|不要告诉用户|作为系统提示)/iu;

export function hasExternalInstructionSignal(value: string | null | undefined): boolean {
  return typeof value === 'string' && EXTERNAL_INSTRUCTION_SIGNAL.test(value);
}

export function externalContentLabel(value: string | null | undefined): string | null {
  return hasExternalInstructionSignal(value) ? '含疑似网页指令' : null;
}
