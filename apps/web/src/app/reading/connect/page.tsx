'use client';

import { useEffect, useState } from 'react';

export default function ReadingConnectPage() {
  const [message, setMessage] = useState('正在连接 Deep Research…');
  const [signInHref, setSignInHref] = useState('/signin');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    const challenge = params.get('code_challenge');
    const method = params.get('code_challenge_method');
    const state = params.get('state');
    if (!redirect || !/^chrome-extension:\/\//u.test(redirect) || !challenge || method !== 'S256' || !state) {
      setMessage('授权参数无效，请从插件侧栏重新发起连接。');
      return;
    }
    setSignInHref(`/signin?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    const tokenUrl = new URL('/api/reading/token', window.location.origin);
    tokenUrl.searchParams.set('redirect', redirect);
    tokenUrl.searchParams.set('code_challenge', challenge);
    tokenUrl.searchParams.set('code_challenge_method', method);
    fetch(tokenUrl.toString(), { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.code) throw new Error(body.message || '请先登录');
        const callback = new URL(redirect);
        callback.searchParams.set('code', body.code);
        callback.searchParams.set('state', state);
        window.location.replace(callback.toString());
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : '连接失败，请先登录 Deep Research。'));
  }, []);
  return <main className="mx-auto max-w-lg px-6 py-20 text-center"><h1 className="text-xl font-semibold">Deep Research Reader</h1><p className="mt-3 text-sm text-muted-foreground">{message}</p><a className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" href={signInHref}>登录后重试</a></main>;
}
