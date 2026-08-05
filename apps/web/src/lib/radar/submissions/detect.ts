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

/** SSRF 黑名单：与 ai-engine `safe_fetch` 保持一致（简单版；host=localhost/private 拒绝）。 */
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
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: '禁止内网/回环地址' };
  }
  if (/^(10|127|169\.254|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\./.test(host)) {
    return { ok: false, reason: '禁止私网 IPv4' };
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
