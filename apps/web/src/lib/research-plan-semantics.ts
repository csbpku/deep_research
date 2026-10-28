import { DEFAULT_RESEARCH_DECISION_DIMENSIONS } from '@deep-research/shared/schemas';

const INSTRUCTION = /^(?:请|并|同时|给出|提供|说明|解释|总结|整理|输出|列出|评估|建议|无需|不要|不需要|please\b|provide\b|give\b|explain\b|include\b)/iu;
const VAGUE_OPTION = /^(?:(?:现有|当前|更好|其他|另一个|另一|不同|多个|若干|备选|推荐|主流).*(?:方案|实现|工具|方式|路径)|方案[一二三四五六七八九十\d]?|实现|工具|建议|适用边界)$/u;

function cleanOption(value: string): string {
  return value
    .replace(/^\s*(?:and\s+|和|与)/iu, '')
    // Scenario and requested comparison dimensions are not part of a name.
    .replace(/\s+(?:在|针对|面向|用于|for\b|in\b)\s*.+$/iu, '')
    .replace(/\s*的(?:工程取舍|研究过程|研究能力|产品能力|适用|异常|取消|优劣|区别|差异|选择|机制|行为|成本|性能).*/u, '')
    .replace(/\s*(?:工程取舍|研究过程(?:设计)?|研究能力|产品能力|优劣|区别|差异|对比|比较)$/iu, '')
    .replace(/^[“"'「『]|[”"'」』。！？!?\.]+$/gu, '')
    .trim();
}

/** Extract only the named options; leave ambiguous questions for confirmation. */
export function inferComparisonOptions(question: string): string[] {
  const clauses = question.split(/[:：。！？!?；;\n]/u);
  // A leading "A vs B: compare costs" must not turn its cost list into options.
  const versus = clauses.find((clause) => /\s+(?:vs\.?|versus)\s+/iu.test(clause));
  const comparison = versus ?? clauses
    .map((clause) => clause.match(/(?:比较|对比|\bcompare\b)\s*(.+)/iu)?.[1])
    .find((clause): clause is string => Boolean(clause));
  if (!comparison) return [];

  const namedPart = comparison.split(/，|,/u)
    .filter((part) => !INSTRUCTION.test(part.trim()))
    .join('、')
    .replace(/\s+(?:在|针对|面向|用于|for\b|in\b)\s*.+$/iu, '')
    .replace(/\s*的(?:工程取舍|研究过程|研究能力|产品能力|适用|异常|取消|优劣|区别|差异|选择|机制|行为|成本|性能).*/u, '');
  const options = Array.from(new Set(namedPart
    .split(/、|\s*(?:以及|和|与|及)\s*|\s+(?:and|vs\.?|versus)\s+/iu)
    .map(cleanOption)
    .filter(Boolean)));
  if (options.length < 2 || options.length > 8) return [];
  if (options.some((option) => option.length > 80 || VAGUE_OPTION.test(option) || INSTRUCTION.test(option))) return [];
  return options;
}

const DIMENSION_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['效果与适用范围', /效果|适用|边界|功能|能力|feature|capabilit|use\s*case/iu],
  ['异常传播', /异常(?:传播|处理|聚合)?|exception|error\s*propagation/iu],
  ['取消行为', /取消|cancel(?:lation)?/iu],
  ['成本与资源', /成本|费用|价格|cost|pricing|budget/iu],
  ['网络/性能实测', /网络|性能|测速|带宽|延迟|吞吐|benchmark|performance|bandwidth|latency|throughput/iu],
  ['磁盘与资源占用', /磁盘|存储|空间|内存|资源占用|\bcpu\b|\bdisk\b|storage|memory/iu],
  ['部署与构建', /部署|构建|镜像|安装|\bghcr\b|\bvps\b|deploy|\bbuild\b|container\s*image/iu],
  ['回滚与恢复', /回滚|恢复|备份|rollback|restore|backup|recovery/iu],
  ['可运维性', /运维|维护|升级|日志|监控|operation|maintenance|monitoring/iu],
  ['安全与风险', /安全|风险|权限|漏洞|security|\brisk\b|vulnerability/iu],
];

/** Defaults are suggestions; operational gates are added only for requested topics. */
export function inferDecisionDimensions(question: string, context = ''): string[] {
  const relevant = `${question}\n${context}`.replace(
    /(?:不(?:需要|讨论|考虑|关注|比较|涉及)|无需|不要)[^。；;\n]*/gu,
    '',
  );
  const inferred = DIMENSION_SIGNALS.filter(([, signal]) => signal.test(relevant)).map(([dimension]) => dimension);
  return inferred.length > 0 ? inferred : [...DEFAULT_RESEARCH_DECISION_DIMENSIONS];
}
