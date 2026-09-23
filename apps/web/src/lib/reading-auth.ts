import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/session';
import { getCurrentUser } from './auth/session';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from './errors';

const TOKEN_PREFIX = 'dr_reader.';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14;
const CODE_PREFIX = 'dr_reader_code.';
const CODE_TTL_SECONDS = 5 * 60;

export function isAllowedReadingRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'chrome-extension:' || url.pathname !== '/callback.html' || url.search || url.hash) return false;
    const configured = (process.env.READING_EXTENSION_IDS || '').split(',').map((item) => item.trim()).filter(Boolean);
    // Local unpacked extensions receive a generated id. Keep the convenient
    // prototype flow in development, while production requires an explicit
    // Web Store/enterprise extension id allowlist.
    if (configured.length === 0) return process.env.NODE_ENV !== 'production';
    return configured.includes(url.hostname);
  } catch {
    return false;
  }
}

function secret(): string {
  return process.env.NEXTAUTH_SECRET || 'development-reader-secret';
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueReadingToken(userId: string): string {
  const payload = encode(JSON.stringify({ sub: userId, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  return `${TOKEN_PREFIX}${payload}.${signature(payload)}`;
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/**
 * Create a short lived authorization code for the extension callback.
 * The code is deliberately useless without the verifier held by the
 * extension, and the long lived reader token is only minted at exchange time.
 */
export function issueReadingAuthorizationCode(
  userId: string,
  redirect: string,
  codeChallenge: string,
): string {
  const payload = encode(JSON.stringify({
    sub: userId,
    redirect,
    challenge: codeChallenge,
    jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS,
  }));
  return `${CODE_PREFIX}${payload}.${signature(payload)}`;
}

type AuthorizationCodePayload = {
  sub: string;
  redirect: string;
  challenge: string;
  jti: string;
  exp: number;
};

function readAuthorizationCode(code: string): AuthorizationCodePayload | null {
  if (!code.startsWith(CODE_PREFIX)) return null;
  const value = code.slice(CODE_PREFIX.length);
  const [payload, provided] = value.split('.');
  if (!payload || !provided) return null;
  const expected = signature(payload);
  try {
    if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
    const parsed = JSON.parse(decode(payload)) as Partial<AuthorizationCodePayload>;
    if (
      typeof parsed.sub !== 'string'
      || typeof parsed.redirect !== 'string'
      || typeof parsed.challenge !== 'string'
      || typeof parsed.jti !== 'string'
      || typeof parsed.exp !== 'number'
      || parsed.exp < Math.floor(Date.now() / 1000)
    ) return null;
    return parsed as AuthorizationCodePayload;
  } catch {
    return null;
  }
}

/**
 * Consume an authorization code exactly once and return a reader grant.
 * ProductEvent is used as a durable, unique replay ledger so this remains
 * one-time across Next.js instances without adding a second token table.
 */
export async function exchangeReadingAuthorizationCode(input: {
  code: string;
  redirect: string;
  codeVerifier: string;
}): Promise<string | null> {
  if (input.codeVerifier.length < 43 || input.codeVerifier.length > 128) return null;
  const parsed = readAuthorizationCode(input.code);
  if (!parsed || parsed.redirect !== input.redirect) return null;
  const actualChallenge = base64UrlSha256(input.codeVerifier);
  if (
    actualChallenge.length !== parsed.challenge.length
    || !timingSafeEqual(Buffer.from(actualChallenge), Buffer.from(parsed.challenge))
  ) return null;
  try {
    await prisma.productEvent.create({
      data: {
        userId: parsed.sub,
        eventName: 'reading_authorization_code_used',
        entityType: 'reading_grant',
        metadata: { jti: parsed.jti, redirect: parsed.redirect } as Prisma.InputJsonValue,
        dedupeKey: `reading-auth:${parsed.jti}`,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
  return issueReadingToken(parsed.sub);
}

type ReadingTokenPayload = { sub: string; exp: number; jti?: string };

function readReadingToken(token: string): ReadingTokenPayload | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const value = token.slice(TOKEN_PREFIX.length);
  const [payload, provided] = value.split('.');
  if (!payload || !provided) return null;
  const expected = signature(payload);
  try {
    if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
    const parsed = JSON.parse(decode(payload)) as { sub?: unknown; exp?: unknown; jti?: unknown };
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (parsed.jti !== undefined && typeof parsed.jti !== 'string') return null;
    return { sub: parsed.sub, exp: parsed.exp, ...(typeof parsed.jti === 'string' ? { jti: parsed.jti } : {}) };
  } catch {
    return null;
  }
}

async function isReadingTokenRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  const revoked = await prisma.productEvent.findUnique({
    where: { dedupeKey: `reading-revoke:${jti}` },
    select: { id: true },
  });
  return Boolean(revoked);
}

/** Revoke one bearer grant without disabling the user's other sessions. */
export async function revokeReadingToken(token: string, userId: string): Promise<boolean> {
  const parsed = readReadingToken(token);
  if (!parsed || parsed.sub !== userId || !parsed.jti) return false;
  try {
    await prisma.productEvent.create({
      data: {
        userId,
        eventName: 'reading_authorization_revoked',
        entityType: 'reading_grant',
        entityId: parsed.jti,
        metadata: { jti: parsed.jti },
        dedupeKey: `reading-revoke:${parsed.jti}`,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
    throw error;
  }
  return true;
}

export async function requireReadingUser(req: Request): Promise<SessionUser | Response> {
  const authorization = req.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  // An explicit extension token takes precedence over a possibly different
  // browser session cookie. This prevents an iframe opened under account B
  // from silently saving account A's reading result into B's library.
  if (token) {
    const tokenPayload = readReadingToken(token);
    if (tokenPayload && !(await isReadingTokenRevoked(tokenPayload.jti))) {
      const row = await prisma.user.findUnique({ select: { id: true, email: true, name: true, avatarUrl: true, role: true, disabledAt: true }, where: { id: tokenPayload.sub } });
      if (row && !row.disabledAt) return { id: row.id, email: row.email, name: row.name, image: row.avatarUrl, role: row.role as 'member' | 'admin', disabledAt: null };
    }
    return toApiErrorResponse({ code: ERROR_CODES.AUTH_NOT_AUTHENTICATED, message: '阅读令牌已失效，请重新连接 Deep Research', requestId: req.headers.get('x-request-id') || 'unknown' });
  }
  const user = await getCurrentUser();
  if (user) return user;
  return toApiErrorResponse({ code: ERROR_CODES.AUTH_NOT_AUTHENTICATED, message: '需要登录或连接 Deep Research', requestId: req.headers.get('x-request-id') || 'unknown' });
}
