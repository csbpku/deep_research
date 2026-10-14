import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await readFile(resolve(root, 'privacy-policy.json'), 'utf8'));
const escape = (text) => String(text).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sections = policy.sections.map((section) => `<section id="${escape(section.id)}"><h2>${escape(section.title)}</h2>${section.paragraphs.map((text) => `<p>${escape(text)}</p>`).join('')}</section>`).join('\n');
const markdown = `# ${policy.name} 隐私政策\n\n最后更新：${policy.updatedAt}\n\n${policy.summary}\n\n${policy.sections.map((section) => `## ${section.title}\n\n${section.paragraphs.join('\n\n')}`).join('\n\n')}\n\n公开政策：${policy.policyUrl}\n\n支持：${policy.supportUrl}\n\nGitHub Issues：${policy.issuesUrl}\n`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${policy.name} 隐私政策</title><style>:root{color-scheme:light dark}body{max-width:760px;margin:0 auto;padding:40px 24px;font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}h1{font-size:28px;line-height:1.3}h2{font-size:20px;margin-top:36px}a{color:light-dark(#3159c9,#b9cbff)}time{font-size:14px}nav{display:flex;gap:24px;flex-wrap:wrap}p{overflow-wrap:anywhere}</style></head><body><header><p>${policy.name}</p><h1>隐私政策</h1><p>最后更新：<time datetime="${policy.updatedAt}">${policy.updatedAt}</time></p><p>${escape(policy.summary)}</p></header>${sections}<footer><nav><a href="${policy.policyUrl}" target="_blank" rel="noreferrer">在线隐私政策</a><a href="${policy.supportUrl}" target="_blank" rel="noreferrer">使用与支持</a><a href="${policy.issuesUrl}" target="_blank" rel="noreferrer">报告问题</a></nav></footer></body></html>`;
await mkdir(resolve(root, 'public'), { recursive: true });
await writeFile(resolve(root, 'public/privacy.html'), html);
await writeFile(resolve(root, 'PRIVACY.md'), markdown);
