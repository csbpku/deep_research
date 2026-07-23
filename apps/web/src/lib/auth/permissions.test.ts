import { describe, expect, it } from 'vitest';
import { requireRole, requireOwner } from './permissions';
import type { SessionUser } from './session';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { NextResponse } from 'next/server';

const member: SessionUser = {
  id: 'user-1',
  email: 'm@x.com',
  name: 'Member',
  role: 'member',
  disabledAt: null,
};

const admin: SessionUser = {
  id: 'user-2',
  email: 'a@x.com',
  name: 'Admin',
  role: 'admin',
  disabledAt: null,
};

describe('requireRole', () => {
  it('returns user when role matches', () => {
    expect(requireRole(admin, 'admin')).toBe(admin);
    expect(requireRole(member, 'member')).toBe(member);
  });
  it('returns 403 NextResponse when role does not match', () => {
    const r = requireRole(member, 'admin');
    expect(r).toBeInstanceOf(NextResponse);
    // 强制类型为 NextResponse 后读 body
    if (r instanceof NextResponse) {
      expect(r.status).toBe(403);
      const body = (r as unknown as { _body?: unknown })._body;
      // Next.js Response body 是只读 iterator；用 status 校验即可
    }
  });
});

describe('requireOwner', () => {
  it('returns user when authorId matches', () => {
    expect(requireOwner(member, { authorId: member.id })).toBe(member);
  });
  it('returns user when ownerId matches', () => {
    expect(requireOwner(member, { ownerId: member.id })).toBe(member);
  });
  it('returns 403 when authorId differs', () => {
    const r = requireOwner(member, { authorId: 'other-user' });
    expect(r).toBeInstanceOf(NextResponse);
  });
  it('returns 403 when resource is null', () => {
    const r = requireOwner(member, null);
    expect(r).toBeInstanceOf(NextResponse);
  });
});

describe('integration: permission error codes are stable', () => {
  it('PERMISSION_DENIED maps to 403', async () => {
    const r = requireRole(member, 'admin');
    if (r instanceof NextResponse) {
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.code).toBe(ERROR_CODES.PERMISSION_DENIED);
    } else {
      throw new Error('expected NextResponse');
    }
  });
});