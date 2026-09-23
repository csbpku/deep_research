import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { getWebEnv } from '@/lib/env';

export default async function ReadingInstallPage() {
  const env = getWebEnv();
  const user = await getCurrentUser();
  const downloadReady = Boolean(env.READING_EXTENSION_BETA_PATH || env.READING_EXTENSION_BETA_URL);
  const signInHref = `/signin?callbackUrl=${encodeURIComponent('/reading/install')}`;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Deep Research Reader</p>
      <h1 className="mt-3 font-serif text-3xl font-semibold tracking-tight text-foreground">在原网页中使用 AI 阅读</h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">Reader 是独立的 Chrome 扩展。它在你打开的网页里按需读取正文，直接调用你配置的 OpenAI 兼容模型；雷达账号和数据库不是核心阅读的前置条件。</p>
      <section className="mt-8 grid gap-3 sm:grid-cols-2">
        <div className="border-l-2 border-primary bg-primary/[0.04] px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">独立模式</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">使用自己的模型服务。会话、标注、收藏和翻译缓存留在浏览器，可导入导出。</p>
        </div>
        <div className="border-l-2 border-emerald-600 bg-emerald-600/[0.04] px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">平台模式</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">登录调研平台后使用平台模型，并把会话与确认保存的结论写入平台数据库。</p>
        </div>
      </section>
      <section className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Beta 安装包</h2>
            <p className="mt-1 text-xs text-muted-foreground">当前版本 `v{env.READING_EXTENSION_BETA_VERSION}`，适用于桌面 Chrome。</p>
          </div>
          {user ? (
            downloadReady ? (
              <a
                href="/api/reading/extension/download"
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                下载 Beta ZIP
              </a>
            ) : (
              <span className="inline-flex rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">产物尚未发布</span>
            )
          ) : (
            <Link
              href={signInHref}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              登录后下载
            </Link>
          )}
        </div>
        {env.READING_EXTENSION_BETA_SHA256 ? (
          <p className="mt-4 break-all font-mono text-[11px] leading-5 text-muted-foreground">
            SHA-256: {env.READING_EXTENSION_BETA_SHA256}
          </p>
        ) : null}
        <ol className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
          <li><span className="font-medium text-foreground">1.</span> 下载并解压 Beta ZIP；解压后的目录根部应直接包含 `manifest.json`。</li>
          <li><span className="font-medium text-foreground">2.</span> 打开 Chrome 的 `chrome://extensions`，开启“开发者模式”。</li>
          <li><span className="font-medium text-foreground">3.</span> 选择“加载已解压的扩展程序”，选中 `chrome-mv3` 目录。</li>
          <li><span className="font-medium text-foreground">4.</span> 打开任意公开技术网页，点击工具栏里的 Deep Research Reader。首次启用站点后，网页右侧也会保留一个低打扰入口。</li>
          <li><span className="font-medium text-foreground">5.</span> 在设置中选择独立模式或平台模式；平台模式会跳转登录并使用 PKCE 安全连接。</li>
        </ol>
      </section>
      <section className="mt-5 rounded-xl border border-border/70 bg-muted/30 p-5 sm:p-6">
        <h2 className="text-base font-semibold">Beta 分发方式</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          白名单用户通过本页下载。部署时把 `READING_EXTENSION_BETA_URL` 指向 GitHub Release 或对象存储中的 ZIP；自托管环境也可以把 ZIP 挂载到服务器，并设置 `READING_EXTENSION_BETA_PATH`。站内地址固定为 `/api/reading/extension/download`，以后替换版本时不需要修改邀请邮件或雷达链接。
        </p>
      </section>
      <section className="mt-5 rounded-xl border border-border/70 bg-muted/30 p-5 sm:p-6">
        <h2 className="text-base font-semibold">数据边界</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">独立模式默认留在浏览器本地。平台模式会自动同步有界会话元数据，并在你确认保存结论时创建研究库草稿；完整网页正文、图片字节、翻译缓存和 API Key 都不会写入平台数据库。</p>
      </section>
      <Link href="/radar" className="mt-8 inline-flex text-sm font-medium text-primary hover:underline">返回雷达</Link>
    </main>
  );
}
