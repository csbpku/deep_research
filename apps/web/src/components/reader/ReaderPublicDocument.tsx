import { ReaderPublicTheme } from './ReaderPublicTheme';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import NextLink from 'next/link';
import React, { type ReactNode } from 'react';
import { space } from '@deep-research/design-system';

export function ReaderPublicDocument({ title, intro, children, language = 'zh-CN', path = '/reading/support' }: { title: string; intro: string; children: ReactNode; language?: string; path?: string }) {
  const en = language === 'en';
  return (
    <ReaderPublicTheme><Box component="article" lang={language} sx={{ width: '100%', maxWidth: 'var(--dr-width-reading)', marginInline: 'auto', paddingInline: { xs: space.sm, sm: space.md }, paddingBlock: { xs: space.lg, sm: space.section } }}>
      <Box component="nav" aria-label="Language / 语言" sx={{ display: 'flex', justifyContent: 'flex-end', gap: space.md, marginBottom: space.md }}>
        <Link href={`${path}?lang=en`} lang="en" aria-current={en ? 'page' : undefined}>English</Link>
        <Link href={`${path}?lang=zh-CN`} lang="zh-CN" aria-current={!en ? 'page' : undefined}>中文</Link>
      </Box>
      <header>
        <Typography component="p" variant="metadata" color="primary.main" sx={{ fontWeight: 600, letterSpacing: '0.04em' }}>Deep Research Reader</Typography>
        <Typography component="h1" variant="pageTitle" sx={{ marginTop: space.sm }}>{title}</Typography>
        <Typography component="p" variant="reading" sx={{ marginTop: space.lg }}>{intro}</Typography>
      </header>
      <Box component="div" sx={{
        marginTop: space.section, color: 'text.primary', fontSize: 'var(--dr-type-reading)', lineHeight: 'var(--dr-line-height-reading)',
        '& section + section': { marginTop: space.section },
        '& h2': { margin: 0, marginBottom: space.sm, fontSize: 'var(--dr-type-title-medium)', fontWeight: 'var(--dr-weight-semibold)', lineHeight: 'var(--dr-line-height-heading)' },
        '& p': { margin: 0, overflowWrap: 'anywhere' },
        '& p + p': { marginTop: space.sm },
        '& ol, & ul': { margin: 0, paddingLeft: space.lg },
        '& li': { marginTop: space.xs, paddingLeft: space.xs },
        '& a': { color: 'primary.main', textDecoration: 'underline', textUnderlineOffset: '4px', overflowWrap: 'anywhere' },
      }}>
        {children}
      </Box>
      <Box component="footer" aria-label={en ? 'Reader links' : 'Reader 相关链接'} sx={{ display: 'flex', flexWrap: 'wrap', gap: space.md, marginTop: space.section, paddingTop: space.lg, borderTop: 1, borderColor: 'divider', fontSize: 'var(--dr-type-body)' }}>
        <Link component={NextLink} href="/reading/install" underline="hover">{en ? 'Install Reader' : '安装 Reader'}</Link>
        <Link component={NextLink} href={`/reading/privacy?lang=${language}`} underline="hover">{en ? 'Privacy' : '隐私政策'}</Link>
        <Link component={NextLink} href={`/reading/support?lang=${language}`} underline="hover">{en ? 'Support' : '使用与支持'}</Link>
        <Link href="https://github.com/csbpku/deep_research/issues" target="_blank" rel="noreferrer" underline="hover">GitHub Issues ↗</Link>
      </Box>
    </Box></ReaderPublicTheme>
  );
}
