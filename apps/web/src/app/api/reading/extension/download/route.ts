import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireUser } from '../../../../../lib/auth/session';
import { apiHandler } from '../../../../../lib/api-handler';
import { getWebEnv } from '../../../../../lib/env';

const ZIP_CONTENT_TYPE = 'application/zip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fileName(version: string): string {
  return `deep-research-reader-beta-${version}.zip`;
}

function downloadHeaders(version: string, sha256: string): Headers {
  const headers = new Headers({
    'content-type': ZIP_CONTENT_TYPE,
    'content-disposition': `attachment; filename="${fileName(version)}"`,
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  });
  if (sha256) headers.set('x-content-sha256', sha256);
  return headers;
}

function unavailable(message: string): NextResponse {
  return NextResponse.json(
    { ok: false, code: 'READING_EXTENSION_BETA_UNAVAILABLE', message },
    { status: 503, headers: { 'cache-control': 'private, no-store' } },
  );
}

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const env = getWebEnv();
  const headers = downloadHeaders(env.READING_EXTENSION_BETA_VERSION, env.READING_EXTENSION_BETA_SHA256);

  if (env.READING_EXTENSION_BETA_PATH) {
    try {
      const archive = await readFile(env.READING_EXTENSION_BETA_PATH);
      headers.set('content-length', String(archive.byteLength));
      return new Response(new Uint8Array(archive), { status: 200, headers });
    } catch {
      return unavailable('Beta 插件产物暂时不可用，请联系管理员');
    }
  }

  if (env.READING_EXTENSION_BETA_URL) {
    try {
      const upstream = await fetch(env.READING_EXTENSION_BETA_URL, {
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      if (!upstream.ok || !upstream.body) return unavailable('Beta 插件产物暂时不可用，请联系管理员');
      const length = upstream.headers.get('content-length');
      if (length) headers.set('content-length', length);
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      return unavailable('Beta 插件产物暂时不可用，请联系管理员');
    }
  }

  return unavailable('Beta 插件尚未发布，请联系管理员');
});
