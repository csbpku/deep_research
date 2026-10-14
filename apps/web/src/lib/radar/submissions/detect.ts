// 类型识别 + canonical URL + 文件元信息 — P1-B 共用逻辑。
//
// 设计要点：
//   - URL 类：canonicalize + 类型识别（github_repo / github_issue / ... / arxiv / article）
//   - 文件类：扩展名 / MIME / magic bytes 校验 → 落 sha256 → 类型识别（pdf / markdown / html / txt）
//   - SSRF 防护复用现有 canonicalize_url + safe_fetch 的域名黑名单
//   - 返回结构 `{ kind, canonicalUrl?, contentSha256?, rawInput }` 给 BFF 落库

import { createHash } from 'node:crypto';

export type DetectedKind =
  | 'github_repo'
  | 'github_issue'
  | 'github_pr'
  | 'github_release'
  | 'arxiv'
  | 'article'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'txt';

const GITHUB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i;
const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const GITHUB_PR_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
const GITHUB_RELEASE_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases/i;
const ARXIV_RE = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([0-9.]+(?:v\d+)?)(?:\.pdf)?\/?$/i;

export type DetectedInput =
  | { kind: Exclude<DetectedKind, 'pdf' | 'markdown' | 'html' | 'txt'>; canonicalUrl: string; rawInput: string }
  | { kind: 'pdf' | 'markdown' | 'html' | 'txt'; canonicalUrl: null; rawInput: string; contentSha256: string; sizeBytes: number; mimeType: string };

/** 规范化 URL：去 utm_、去 fragment、host lowercase、path 去尾斜杠。 */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const cleaned = new URL(u.toString());
    cleaned.hash = '';
    // 剥离常见 tracking params
    for (const k of Array.from(cleaned.searchParams.keys())) {
      if (/^utm_/i.test(k) || k === 'fbclid' || k === 'gclid') cleaned.searchParams.delete(k);
    }
    let path = cleaned.pathname.replace(/\/+$/, '');
    if (!path) path = '';
    cleaned.pathname = path;
    return cleaned.toString();
  } catch {
    return raw;
  }
}

function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0) // 192.0.0.0/24, 192.0.2.0/24
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

/** 把（已被 URL 规范化的）IPv6 字面量展开成 8 个 16-bit 段；无法解析返回 null。 */
function parseIpv6(host: string): number[] | null {
  let value = host;
  const dotted = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/u);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    value = value.slice(0, dotted.index) + ((a! << 8) | b!).toString(16) + ':' + ((c! << 8) | d!).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/iu.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function isPrivateIpv6(host: string): boolean {
  const g = parseIpv6(host);
  if (!g) return true; // 无法解析的 IPv6 字面量一律拒绝
  const allZeroHigh = g.slice(0, 5).every((x) => x === 0);
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: 与 ::1
  // IPv4-mapped (::ffff:a.b.c.d)、IPv4-compatible (::a.b.c.d)、NAT64 (64:ff9b::/96)
  const embeddedV4 =
    (allZeroHigh && (g[5] === 0xffff || g[5] === 0))
    || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embeddedV4 && isPrivateIpv4(g[6]! >> 8, g[6]! & 0xff)) return true;
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local（已废弃）
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.intranet', '.corp', '.home', '.home.arpa'];

/**
 * SSRF 前置过滤（纵深防御）：ai-engine 的 `safe_fetch` 才是权威（含 DNS 解析后校验）。
 * 这里只做字面量层面的拒绝：回环/私网/链路本地/CGNAT 的 IPv4 与 IPv6（含 [::1]、
 * [::ffff:127.0.0.1]、[fd00::1]）、内部后缀，以及没有点号的裸主机名（如 `intranet`）。
 */
export function isLikelySafeUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: '仅允许 http(s) 协议' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: '禁止在 URL 中携带凭据' };
  }
  // URL 会把 `[::1]` 的 hostname 保留方括号；统一去掉并去掉末尾点。
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (host.includes(':')) {
    return isPrivateIpv6(host) ? { ok: false, reason: '禁止内网/回环 IPv6 地址' } : { ok: true };
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return isPrivateIpv4(a, b) ? { ok: false, reason: '禁止私网 IPv4' } : { ok: true };
  }
  if (
    host === 'localhost'
    || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return { ok: false, reason: '禁止内网/回环地址' };
  }
  if (!host.includes('.')) {
    return { ok: false, reason: '禁止无域名后缀的内部主机名' };
  }
  return { ok: true };
}

export function detectUrlKind(raw: string): { kind: DetectedKind; canonicalUrl: string } | null {
  // Tracking query params / fragments are not part of the resource identity
  // and must not make a known GitHub/arXiv URL fall through to `article`.
  const canonicalUrl = canonicalizeUrl(raw);
  if (GITHUB_RELEASE_RE.test(canonicalUrl)) return { kind: 'github_release', canonicalUrl };
  if (GITHUB_PR_RE.test(canonicalUrl)) return { kind: 'github_pr', canonicalUrl };
  if (GITHUB_ISSUE_RE.test(canonicalUrl)) return { kind: 'github_issue', canonicalUrl };
  if (GITHUB_RE.test(canonicalUrl)) return { kind: 'github_repo', canonicalUrl };
  if (ARXIV_RE.test(canonicalUrl)) return { kind: 'arxiv', canonicalUrl };
  // 普通文章：要求是 http(s) URL
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return { kind: 'article', canonicalUrl };
    }
  } catch {
    /* noop */
  }
  return null;
}

// ── 文件类 ──────────────────────────────────────────────────────────

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');
const HTML_TAGS = ['<!doctype', '<html', '<head', '<body'];
const MD_MARKERS = ['# ', '## ', '```'];

export type FileKind = 'pdf' | 'markdown' | 'html' | 'txt';

const EXT_TO_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  txt: 'txt',
};

export function detectFileKind(opts: { filename: string; mimeType: string; head: Buffer }): FileKind | null {
  const lower = opts.filename.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() ?? '' : '';
  // magic bytes 优先
  if (opts.head.subarray(0, 4).equals(PDF_MAGIC)) return 'pdf';
  const headStr = opts.head.subarray(0, 64).toString('utf8').toLowerCase();
  if (HTML_TAGS.some((t) => headStr.startsWith(t))) return 'html';
  if (MD_MARKERS.some((m) => headStr.startsWith(m))) return 'markdown';
  // 退回到扩展名
  if (ext && EXT_TO_KIND[ext]) return EXT_TO_KIND[ext];
  // mime 兜底
  const mime = opts.mimeType.toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/plain') return 'txt';
  return null;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
