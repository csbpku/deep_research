import { DEFAULT_RESEARCH_DECISION_DIMENSIONS } from '@deep-research/shared/schemas';

const INSTRUCTION = /^(?:请|并|同时|给出|提供|说明|解释|总结|整理|输出|列出|评估|建议|无需|不要|不需要|please\b|provide\b|give\b|explain\b|include\b)/iu;
const VAGUE_OPTION = /^(?:(?:现有|当前|更好|其他|另一个|另一|不同|多个|若干|备选|推荐|主流).*(?:方案|实现|工具|方式|路径)|方案[一二三四五六七八九十\d]?|实现|工具|建议|适用边界)$/u;

function cleanOption(value: string): string {
  return value
    .replace(/^\s*and\s+/iu, '')
    // Scenario and requested comparison dimensions are not part of a name.
    .replace(/\s+(?:在|针对|面向|用于|for\b|in\b)\s*.+$/iu, '')
    .replace(/\s*的(?:工程取舍|研究过程|研究能力|产品能力|适用|异常|取消|优劣|区别|差异|选择|机制|行为|成本|性能).*/u, '')
    .replace(/\s*(?:工程取舍|研究过程(?:设计)?|研究能力|产品能力|优劣|区别|差异|对比|比较)$/iu, '')
    .replace(/^[“"'「『]|[”"'」』。！？!?\.]+$/gu, '')
    .trim();
}

function protectQuotedNames(value: string): { value: string; restore: (name: string) => string } {
  let prefix = 'QRESEARCHNAMEX';
  while (value.includes(prefix)) prefix += 'X';
  const names: string[] = [];
  const protectedValue = value.replace(/「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+"|'[^']+'/gu, (match) => {
    names.push(match.slice(1, -1));
    return `${prefix}${names.length - 1}Q`;
  });
  const token = new RegExp(`${prefix}(\\d+)Q`, 'gu');
  return {
    value: protectedValue,
    restore: (name) => name.replace(token, (_match, index: string) => names[Number(index)]!),
  };
}

function splitNamedItems(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let index = 0;
  while (index < value.length) {
    const separator = value.slice(index).match(/^(?:、|\s*(?:以及|和|与|及)\s*|\s+(?:and|vs\.?|versus)\s+)/iu);
    // A connector begins a new item only after an existing name. This keeps
    // a product such as 和鲸 intact at the beginning of an item.
    if (separator && current.trim()) {
      parts.push(current.trim());
      current = '';
      index += separator[0].length;
    } else {
      current += value[index];
      index += 1;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Extract only the named options; leave ambiguous questions for confirmation. */
export function inferComparisonOptions(question: string): string[] {
  const quoted = protectQuotedNames(question);
  const clauses = quoted.value.split(/[:：。！？!?；;\n]/u);
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
  const options = Array.from(new Set(splitNamedItems(namedPart)
    .map(cleanOption)
    .map(quoted.restore)
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
  const exclusions: string[] = [];
  const relevant = `${question}\n${context}`.replace(
    /(?:不(?:需要|讨论|考虑|关注|比较|涉及|展开|延伸|扩展|涵盖|纳入)|无需|不要)(?!忽略|遗漏)[^。；;\n]*?(?=但是|但|不过|然而|同时|而且|并且|\bbut\b|\bhowever\b|[。；;\n]|$)/gu,
    (excluded) => { exclusions.push(excluded); return ''; },
  );
  const inferred = DIMENSION_SIGNALS.filter(([, signal]) => signal.test(relevant)).map(([dimension]) => dimension);
  if (inferred.length > 0) return inferred;
  const excludedDimensions = new Set(DIMENSION_SIGNALS
    .filter(([, signal]) => exclusions.some((excluded) => signal.test(excluded)))
    .map(([dimension]) => dimension));
  return DEFAULT_RESEARCH_DECISION_DIMENSIONS.filter((dimension) => !excludedDimensions.has(dimension));
}
