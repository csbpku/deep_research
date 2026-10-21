import { readerLanguage } from '@/lib/reader-language';
import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import Link from 'next/link';
import { ReaderPublicDocument } from '@/components/reader/ReaderPublicDocument';

export async function generateMetadata({ searchParams }: { searchParams?: Promise<{ lang?: string | string[] }> }): Promise<Metadata> {
  const language = await readerLanguage(searchParams);
  return {
    title: language === 'en' ? 'Deep Research Reader · Help & support' : 'Deep Research Reader 使用与支持',
    description: language === 'en' ? 'Connect a model, translate and discuss articles, manage your reading data, and get support.' : 'Reader 的模型连接、阅读数据和隐私说明。',
    alternates: { canonical: 'https://techradar.top/reading/support' },
  };
}

export default async function ReaderSupportPage({ searchParams }: { searchParams?: Promise<{ lang?: string | string[] }> }) {
  const language = await readerLanguage(searchParams);
  const en = language === 'en';
  return (
    <ReaderPublicDocument language={language} path="/reading/support" title={en ? 'Help & support' : '使用与支持'} intro={en ? 'Read on the original page and discuss in the sidebar. Connect your own model, or optionally connect Deep Research.' : '在原网页阅读，在侧栏讨论。独立模式使用自己的模型服务；平台模式可选连接 Deep Research。'}>
      {en ? <>
        <section><h2>Start reading</h2><ol>
          <li>Install Reader, open a public article, technical document or GitHub README, and click Reader in the Chrome toolbar.</li>
          <li>In Settings, select a service in Standalone mode, confirm its API URL and enter the required key. Connect to discover models, grant service access, choose a model and save. A loopback Local Proxy may omit the key. Test connection checks a short model reply. Providers may charge for usage.</li>
          <li>Platform mode requires platform access. Connect and sign in to use its managed model without entering a model API key.</li>
          <li>Ask in chat, or use Summarize and Translate. Selected text appears beside the input; you can copy or clear it. Use the resize handle or expand button to adjust input height.</li>
        </ol></section>
        <section><h2>Switch between original and translation</h2><p>After translation, use the paragraph’s original/translation button, the context menu, Alt+Shift+O or Alt+click. Switching an existing translation makes no new model request. Restore original removes all translation overlays. Pause or cancel keeps completed results. Code blocks are preserved.</p><p>Image translation requires a vision model. If precise text placement is unreliable, Reader shows a translation beside the image. Diagram questions use the selected image, article and recent discussion; platform mode sends browser-read image bytes to its vision model.</p></section>
        <section><h2>Answers, evidence and history</h2><p>Answers show their text and article evidence. Click evidence to locate its source. Additional background, inference and uncertainty appear in More details. Selecting text, translating or closing the sidebar does not intentionally cancel an answer. Use Stop to end it. Browser shutdown or a terminated background process may interrupt tasks.</p><p>History opens previous chats; Saved items contains insights you explicitly saved. Standalone mode supports switching models in the composer; platform models are managed by the platform.</p></section>
        <section><h2>Export, deletion and installation changes</h2><p>Export reading data in Settings before switching installations, then import it into the new installation. Exports omit API keys, translation caches and temporary task inputs. Store and unpacked installations can have different IDs; reconnect models or the platform after migration.</p><p>Clearing local data does not delete synced platform or provider records. See the <Link href="/reading/privacy?lang=en">privacy policy</Link> for data flows and deletion boundaries.</p></section>
        <section><h2>Troubleshooting</h2><p>Chrome internal pages, the Web Store and other protected pages cannot run Reader. Check your endpoint, key, model and browser access configuration if a model connection fails. Enable site access when prompted. Grant image-origin access and retry if an image cannot be read.</p><p>Contact maintainers through <a href="https://github.com/csbpku/deep_research/issues" target="_blank" rel="noreferrer">GitHub Issues</a>. Include extension and Chrome versions, mode, steps and a public URL. Never post API keys, platform tokens, passwords or private content.</p></section>
      </> : <>
      <section>
        <h2>开始阅读</h2>
        <Box component="ol" sx={{ listStyleType: 'decimal' }}>
          <li>安装扩展后，打开一篇公开文章、技术文档或 GitHub README，点击工具栏里的 Reader 图标。</li>
          <li>进入“设置”。独立模式选择模型服务、确认 API 地址并填写所需 Key，点击“连接并获取模型”，允许该服务后选择模型并保存配置；Local Proxy 的回环地址可以不填 Key。“测试连接”可单独检查所选模型的短回复。模型服务可能按使用量收费。</li>
          <li>平台模式无需填写模型 Key，但需要已有平台访问权限。点击“连接平台”并登录授权，成功后使用固定的平台模型。</li>
          <li>在聊天输入区提问，或点击“总结”“翻译”。选中原文后，输入区会预览选段，也可以复制或清除选段。</li>
        </Box>
      </section>
      <section>
        <h2>译文和原文怎样切换</h2>
        <p>全文翻译完成后，鼠标停在对应段落上，点击“查看这一段原文”；再次操作可切回译文。右键菜单提供同样的双向切换，也可用 Alt+Shift+O 或 Alt+单击。切换已有译文不会再次请求模型。</p>
        <p>“恢复原文”移除整页翻译覆盖。暂停或取消翻译保留已经完成的结果。代码块保持原样，图片翻译需要所选模型具有图片能力；无法可靠定位文字时显示旁译。</p>
      </section>
      <section>
        <h2>回答、证据和聊天记录</h2>
        <p>回答默认显示正文和原文证据，点击证据可定位来源段落。背景、推断和未知项在“补充说明”中展开。继续选择原文、翻译或关闭侧栏不会主动取消问答；需要结束时点击“停止回答”。浏览器退出或后台进程被终止可能中断任务。</p>
        <p>顶部“历史”查看已有会话，“收藏”查看已保存结论。独立模式可以在输入区切换模型；平台模式的模型由平台管理。</p>
      </section>
      <section>
        <h2>导出、删除和更换安装方式</h2>
        <p>在设置中导出阅读数据，再在新的安装中导入。导出不包含 API Key、翻译缓存或临时任务输入。解压版和商店版的扩展 ID 可能不同，迁移后需要重新配置模型或连接平台。</p>
        <p>清除本地数据不会删除已同步到平台或第三方模型服务的记录。完整的数据流和删除边界见 <Link href="/reading/privacy?lang=zh-CN">隐私政策</Link>。</p>
      </section>
      <section>
        <h2>遇到问题</h2>
        <p>Chrome 内置页、Chrome Web Store 和其他受保护页面不能注入阅读助手。模型连接失败时，检查服务地址、Key、模型名称及服务端的浏览器访问配置；没有站点权限时点击侧栏提示中的“启用此站点”。图片读取失败可在授权后重试。</p>
        <p>通过 <a href="https://github.com/csbpku/deep_research/issues" target="_blank" rel="noreferrer">GitHub Issues</a> 联系项目维护者。请提供扩展版本、Chrome 版本、运行模式、复现步骤和可公开的测试 URL。不要粘贴 API Key、平台令牌或私人文章内容。</p>
      </section>
      </>}
    </ReaderPublicDocument>
  );
}
