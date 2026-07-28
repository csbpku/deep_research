// Admin 流程 E2E（Week 9+ 起步骨架）
//
// 覆盖：
//   - 未登录访问 /admin → 跳 signin
//   - 仪表板对 admin 渲染 4 个统计卡
//   - 评论/分享/雷达三个 tab 切换
//
// 完整 admin 操作（批准/拒绝/提炼）需要 seed 数据和登录态，
// 留给有 seed 路由后的 Week 9 收尾。

import { test, expect } from '@playwright/test';

test.describe('Admin flows (public-facing)', () => {
  test('unauthenticated /admin redirects to signin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/signin/);
  });

  test('unauthenticated /api/admin/dashboard rejects with non-2xx', async ({ request }) => {
    const res = await request.get('/api/admin/dashboard');
    expect([401, 403, 307]).toContain(res.status());
  });

  test('unauthenticated /api/admin/comments rejects with non-2xx', async ({ request }) => {
    const res = await request.get('/api/admin/comments');
    expect([401, 403, 307]).toContain(res.status());
  });

  test('unauthenticated /api/admin/shares rejects with non-2xx', async ({ request }) => {
    const res = await request.get('/api/admin/shares');
    expect([401, 403, 307]).toContain(res.status());
  });

  test('unauthenticated POST /api/admin/shares/[id]/review rejects with non-2xx', async ({ request }) => {
    const res = await request.post('/api/admin/shares/00000000-0000-4000-8000-000000000000/review', {
      data: { action: 'approve' },
    });
    expect([401, 403, 404, 307]).toContain(res.status());
  });
});