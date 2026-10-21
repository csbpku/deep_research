import { headers } from 'next/headers';

export async function readerLanguage(params?: Promise<{ lang?: string | string[] }>) {
  const query = await params;
  const requested = Array.isArray(query?.lang) ? query.lang[0] : query?.lang;
  if (requested === 'en' || requested === 'zh-CN') return requested;
  const accepted = (await headers()).get('accept-language') || 'en';
  return /^zh(?:-|,|;|$)/iu.test(accepted) ? 'zh-CN' : 'en';
}
