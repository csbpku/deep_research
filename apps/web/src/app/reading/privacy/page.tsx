import { readerLanguage } from '@/lib/reader-language';
import type { Metadata } from 'next';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import { ReaderPublicDocument } from '@/components/reader/ReaderPublicDocument';
import policy from '../../../../../extension/privacy-policy.json';

export async function generateMetadata({ searchParams }: { searchParams?: Promise<{ lang?: string | string[] }> }): Promise<Metadata> {
  const language = await readerLanguage(searchParams);
  return {
    title: language === 'en' ? 'Deep Research Reader · Privacy policy' : 'Deep Research Reader 隐私政策',
    description: language === 'en' ? 'How Reader handles article content, model requests, API keys, image bytes, local data and optional platform sync.' : 'Reader 的模型连接、阅读数据和隐私说明。',
    alternates: { canonical: 'https://techradar.top/reading/privacy' },
  };
}

export default async function ReaderPrivacyPage({ searchParams }: { searchParams?: Promise<{ lang?: string | string[] }> }) {
  const language = await readerLanguage(searchParams);
  const en = language === 'en';
  const content = en ? policy.translations.en : policy;
  return (
    <ReaderPublicDocument language={language} path="/reading/privacy" title={en ? 'Privacy policy' : '隐私政策'} intro={content.summary}>
      <Typography component="div" variant="metadata" color="text.secondary" sx={{ marginBottom: space.md }}>
        {en ? 'Last updated: ' : '最后更新：'}<time dateTime={policy.updatedAt}>{policy.updatedAt}</time> · {en ? 'No sign-in required' : '此页面无需登录'}
      </Typography>
      {content.sections.map((section) => (
        <section key={section.id} id={section.id}>
          <h2>{section.title}</h2>
          {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </section>
      ))}
    </ReaderPublicDocument>
  );
}
