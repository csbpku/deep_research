// 单一的客户端 IP 推导 helper（限流 / 审计共用）。
//
// 信任模型：nginx 在最外层把真实对端写入 X-Real-IP（覆盖客户端提交的值）。
// 客户端自带的 X-Forwarded-For 可被伪造，默认完全忽略；只有显式配置
// TRUSTED_PROXY_HOPS=N（N>0，表示 XFF 末尾有 N 个可信代理追加的条目）时，
// 才取 XFF 倒数第 N 个条目。

function trustedProxyHops(): number {
  const raw = Number(process.env.TRUSTED_PROXY_HOPS ?? '0');
  return Number.isInteger(raw) && raw > 0 && raw <= 10 ? raw : 0;
}

/** 返回客户端 IP；无法确定时返回 'unknown'。 */
export function clientIp(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const hops = trustedProxyHops();
  if (hops > 0) {
    const parts = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const picked = parts[parts.length - hops];
    if (picked) return picked;
  }
  return 'unknown';
}

/** 限流 key：已登录用户优先按 user id，否则按 IP。 */
export function rateLimitKey(headers: Headers, userId?: string | null): string {
  return userId ? `user:${userId}` : `ip:${clientIp(headers)}`;
}
