import type { Metadata } from 'next';
import { ReaderPublicDocument } from '@/components/reader/ReaderPublicDocument';
import policy from '../../../../../extension/privacy-policy.json';

export const metadata: Metadata = {
  title: 'Deep Research Reader 隐私政策',
  description: 'Reader 如何处理网页内容、模型请求、API Key、本地阅读成果和可选平台同步。',
  alternates: { canonical: policy.policyUrl },
};

export default function ReaderPrivacyPage() {
  return (
    <ReaderPublicDocument title="隐私政策" intro={policy.summary}>
      <p className="text-sm text-muted-foreground">最后更新：<time dateTime={policy.updatedAt}>{policy.updatedAt}</time> · 此页面无需登录</p>
      {policy.sections.map((section) => (
        <section key={section.id} id={section.id}>
          <h2>{section.title}</h2>
          {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </section>
      ))}
    </ReaderPublicDocument>
  );
}
