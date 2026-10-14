import Link from 'next/link';
import type { ReactNode } from 'react';

export function ReaderPublicDocument({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-3xl px-2 py-6 sm:px-6 sm:py-10">
      <header>
        <p className="text-xs font-semibold tracking-wide text-primary">Deep Research Reader</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-5 text-base leading-7 text-foreground">{intro}</p>
      </header>
      <div className="mt-8 space-y-9 text-base leading-7 text-foreground [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mt-2 [&_p+p]:mt-3 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_p]:break-words">
        {children}
      </div>
      <footer className="mt-12 flex flex-wrap gap-x-6 gap-y-3 border-t border-border pt-6 text-sm">
        <Link href="/reading/install" className="text-primary hover:underline">安装 Reader</Link>
        <Link href="/reading/privacy" className="text-primary hover:underline">隐私政策</Link>
        <Link href="/reading/support" className="text-primary hover:underline">使用与支持</Link>
        <a href="https://github.com/csbpku/deep_research/issues" className="text-primary hover:underline" target="_blank" rel="noreferrer">GitHub Issues ↗</a>
      </footer>
    </article>
  );
}
