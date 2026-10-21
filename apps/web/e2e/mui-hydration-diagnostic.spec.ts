import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Opt-in diagnosis only. Annotates the error branch of the *served test response*,
// not source/build artifacts, and does not suppress errors or change rendering.
// The guard intentionally fails if the pinned React chunk shape changes.
test('locates the production hydration cursor without masking mismatches', async ({ page }, testInfo) => {
  test.skip(process.env.MUI_HYDRATION_DIAGNOSTICS !== '1', 'explicit diagnostic run only');
  test.setTimeout(90_000);
  const diagnostic: unknown[] = [];
  const errors: string[] = [];
  let patched = 0;
  await page.route('**/_next/static/chunks/ef643c99-bddb0229757bd966.js', async route => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'function rD(e){var n=Error(i(418,';
    expect(body).toContain(marker);
    patched++;
    const annotation = `try{var path=[],f=e;while(f&&path.length<18){var c=f.pendingProps?.children,p=c?._payload;path.push({type:typeof f.type==='string'?f.type:(f.type?.displayName||f.type?.name||f.tag),childTag:f.child?.tag,childType:typeof f.child?.type==='string'?f.child.type:f.child?.type?.name,props:{id:f.pendingProps?.id,className:f.pendingProps?.className,children:typeof c==='string'?c:{kind:typeof c,type:typeof c?.type==='string'?c.type:c?.type?.name,keys:c?Object.keys(c).slice(0,8):[],status:p?.status,value:p?.value===null?null:{kind:typeof p?.value,keys:p?.value?Object.keys(p.value).slice(0,8):[],type:typeof p?.value?.type==='string'?p.value.type:p?.value?.type?.name}}}});f=f.return;}console.error('MUI_HYDRATION_CURSOR '+JSON.stringify({path,actual:rN?.outerHTML?.slice(0,2400)||rN?.nodeValue,parent:rN?.parentElement?.outerHTML?.slice(0,4000)}));}catch(ignore){}`;
    return route.fulfill({ response, body: body.replace(marker, `function rD(e){${annotation}var n=Error(i(418,`) });
  });
  page.on('console', message => {
    if (message.text().startsWith('MUI_HYDRATION_CURSOR ')) diagnostic.push({ width: page.viewportSize()?.width, data: JSON.parse(message.text().slice('MUI_HYDRATION_CURSOR '.length)) });
  });
  page.on('pageerror', error => errors.push(`${page.viewportSize()?.width}: ${error.message}`));
  await page.addInitScript(() => localStorage.setItem('dr-theme', 'light'));
  const item = {
    id: '10000000-0000-4000-8000-000000000001', title: '水合诊断测试内容', url: 'https://example.com/article',
    excerpt: '摘要', interpretation: null, distilledScore: null, tier: 'deep_read', selectionReason: null,
    sourceType: 'rss', sourceName: '测试来源', originalKind: 'article', tags: [], status: 'published',
    publishedAt: null, crawledAt: '2026-10-16T00:00:00Z', relevanceScore: null, timelinessScore: null,
    sourceQualityScore: null, sortOrder: null, commentCount: 0, topics: [], issues: [],
    feedbackCounts: { favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0 }, myFeedbacks: [],
  };
  await page.route('**/api/radar?*', route => route.fulfill({ json: { page: 1, perPage: 20, total: 1, totalPages: 1, items: [item] } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null } }));
  for (let iteration = 0; iteration < 6; iteration++) {
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/radar?date=all');
      await expect(page.getByRole('link', { name: item.title, exact: true })).toBeVisible();
      await expect.poll(() => page.locator('html').getAttribute('class')).toContain('light');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect((await new AxeBuilder({ page }).include('.material-surface').analyze()).violations).toEqual([]);
  }
  await testInfo.attach('hydration-cursor.json', { body: JSON.stringify({ patched, diagnostic, errors }, null, 2), contentType: 'application/json' });
  expect(patched).toBeGreaterThan(0);
  expect(errors, `Hydration cursor details are attached (${diagnostic.length} mismatch records)`).toEqual([]);
});
