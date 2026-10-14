import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.RENDER_REVIEW_PORT ?? '4100');
const script = process.env.RENDER_REVIEW_SCRIPT ?? '/app/radar-render-review.mjs';
const timeoutMs = Math.max(30_000, Number(process.env.RADAR_RENDER_REVIEW_TIMEOUT_SECONDS ?? '150') * 1000);

// Shared secret the caller (ai-engine) must present in the x-render-review-token
// header. Without it anyone on the Compose network could make this Chromium
// browse arbitrary URLs (SSRF). The sidecar refuses to start without a token.
const authToken = process.env.RENDER_REVIEW_TOKEN ?? '';
if (!authToken) {
  console.error('RENDER_REVIEW_TOKEN is required; refusing to start the render-review sidecar without it');
  process.exit(1);
}

// Only these origins may be passed as baseUrl. Default: the Compose web service.
function originOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
const defaultBaseUrl = process.env.RADAR_RENDER_REVIEW_BASE_URL ?? 'http://web:3000';
const allowedOrigins = new Set(
  (process.env.RENDER_REVIEW_ALLOWED_BASE_URLS ?? defaultBaseUrl)
    .split(',')
    .map((entry) => originOf(entry.trim()))
    .filter(Boolean),
);
if (allowedOrigins.size === 0) {
  console.error('No valid origin in RENDER_REVIEW_ALLOWED_BASE_URLS / RADAR_RENDER_REVIEW_BASE_URL');
  process.exit(1);
}

function tokenMatches(header) {
  const provided = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(authToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function respond(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) {
      throw new Error('request_too_large');
    }
  }
  return JSON.parse(body || '{}');
}

function runReview(payload) {
  return new Promise((resolve) => {
    const summaryId = typeof payload.summaryId === 'string' ? payload.summaryId : '';
    const round = Number.isFinite(Number(payload.round)) ? Number(payload.round) : 1;
    const requestedBaseUrl = typeof payload.baseUrl === 'string' && payload.baseUrl
      ? payload.baseUrl
      : defaultBaseUrl;
    const baseOrigin = originOf(requestedBaseUrl);
    // Exact-origin allowlist: private/link-local/metadata addresses and any
    // other host are rejected unless explicitly listed by the operator.
    if (!baseOrigin || !allowedOrigins.has(baseOrigin)) {
      resolve({
        status: 'unavailable',
        summary: 'Render-review baseUrl is not on the sidecar allowlist.',
        error: 'base_url_not_allowed',
      });
      return;
    }
    const baseUrl = baseOrigin;
    if (!summaryId || !/^[a-zA-Z0-9-]+$/u.test(summaryId)) {
      resolve({
        status: 'unavailable',
        summary: 'Invalid render-review summary id.',
        error: 'invalid_summary_id',
      });
      return;
    }

    const child = spawn(process.execPath, [
      script,
      '--summary-id',
      summaryId,
      '--round',
      String(round),
      '--base-url',
      baseUrl,
    ], {
      cwd: '/app',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The browser script does not need the sidecar auth token.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'RENDER_REVIEW_TOKEN'),
      ),
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        status: 'unavailable',
        summary: 'Browser sidecar review timed out.',
        error: `timeout:${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        status: 'unavailable',
        summary: 'Browser sidecar could not start the review.',
        error: String(error).slice(0, 500),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString('utf8').trim();
      for (const line of text.split(/\r?\n/u).reverse()) {
        try {
          const result = JSON.parse(line);
          if (result && typeof result === 'object') {
            if (stderr.length) {
              result.sidecarStderr = Buffer.concat(stderr).toString('utf8').slice(-2000);
            }
            result.sidecarExitCode = code;
            resolve(result);
            return;
          }
        } catch {
          // Ignore log lines and keep looking for the final JSON payload.
        }
      }
      resolve({
        status: 'unavailable',
        summary: 'Browser sidecar returned no structured review result.',
        error: `exit_code=${code}; stderr=${Buffer.concat(stderr).toString('utf8').slice(-1000)}`,
      });
    });
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    respond(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/review') {
    respond(response, 404, { error: 'not_found' });
    return;
  }
  if (!tokenMatches(request.headers['x-render-review-token'])) {
    respond(response, 401, { status: 'unavailable', error: 'unauthorized' });
    return;
  }
  try {
    respond(response, 200, await runReview(await readJson(request)));
  } catch (error) {
    respond(response, 400, {
      status: 'unavailable',
      summary: 'Invalid browser sidecar request.',
      error: String(error).slice(0, 500),
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`render-review sidecar listening on ${port}`);
});
