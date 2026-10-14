import type { Metadata } from 'next';
import Link from 'next/link';
import { ReaderPublicDocument } from '@/components/reader/ReaderPublicDocument';

export const metadata: Metadata = {
  title: 'Deep Research Reader 使用与支持',
  description: 'Reader 的模型连接、阅读翻译、原文定位、本地数据和问题反馈说明。',
  alternates: { canonical: 'https://techradar.top/reading/support' },
};

export default function ReaderSupportPage() {
  return (
    <ReaderPublicDocument title="使用与支持" intro="在原网页阅读，在侧栏讨论。独立模式使用自己的模型服务；平台模式可选连接 Deep Research。">
      <section>
        <h2>开始阅读</h2>
        <ol className="list-decimal pl-6">
          <li>安装扩展后，打开一篇公开文章、技术文档或 GitHub README，点击工具栏里的 Reader 图标。</li>
          <li>进入“设置”。独立模式选择模型服务并填写所需 API Key，模型列表会自动获取；Local Proxy 的回环地址可以不填 Key。点击“保存并快速验证”。模型服务可能按使用量收费。</li>
          <li>平台模式无需填写模型 Key，但需要已有平台访问权限。点击“连接平台”并登录授权，成功后使用固定的平台模型。</li>
          <li>在聊天输入区提问，或点击“总结”“翻译”“工具”。选中原文后，输入区会预览选段，也可以复制或清除选段。</li>
        </ol>
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
        <p>清除本地数据不会删除已同步到平台或第三方模型服务的记录。完整的数据流和删除边界见 <Link href="/reading/privacy">隐私政策</Link>。</p>
      </section>
      <section>
        <h2>遇到问题</h2>
        <p>Chrome 内置页、Chrome Web Store 和其他受保护页面不能注入阅读助手。模型连接失败时，检查服务地址、Key、模型名称及服务端的浏览器访问配置；没有站点权限时点击侧栏提示中的“启用此站点”。图片读取失败可在授权后重试。</p>
        <p>通过 <a href="https://github.com/csbpku/deep_research/issues" target="_blank" rel="noreferrer">GitHub Issues</a> 联系项目维护者。请提供扩展版本、Chrome 版本、运行模式、复现步骤和可公开的测试 URL。不要粘贴 API Key、平台令牌或私人文章内容。</p>
      </section>
    </ReaderPublicDocument>
  );
}
