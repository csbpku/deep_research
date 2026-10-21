'use client';

// /researches/new — 新建调研入口（属于「研究库」的子页面）。

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Upload } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import FormLabel from '@mui/material/FormLabel';
import MaterialLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { TagChip, TagList } from '@/components/domain/TagChip';
import { AppDialog } from '@/components/material/AppDialog';
import { AppTextField } from '@/components/material/AppTextField';

export default function NewResearchPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [background, setBackground] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [risks, setRisks] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  useEffect(() => {
    // 读 ?mode=blank 而非 hash —— hash 会污染浏览器历史且无法 SSR 友好。
    // /researches 的 DropdownMenu 现在通过 router.push('/researches/new?mode=blank') 触发。
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'blank') setMode('create');
  }, []);

  const tags = tagsInput
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  const handleSave = useCallback(async () => {
    // 标题不能为空:不静默填默认值,给用户明确反馈
    if (!title.trim()) {
      setError('请输入标题');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        body: body.trim() || '# 开始编写...',
        background: background || null,
        conclusion: conclusion || null,
        risks: risks || null,
        tags,
      };
      const res = await fetch('/api/researches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '保存失败');
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ['researches'] });
      router.push(`/researches/${data.id}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [title, body, background, conclusion, risks, tags, router, queryClient]);

  const pageWidth = mode === 'pick' ? 'var(--dr-width-shell)' : 'var(--dr-width-reading)';

  if (mode === 'pick') {
    return (
      <Box sx={{ width: '100%', maxWidth: pageWidth, mx: 'auto' }}>
        <Breadcrumbs aria-label="面包屑" sx={{ mb: 1 }}>
          <MaterialLink component={Link} href="/researches" underline="hover" color="text.secondary" variant="metadata">
            研究库
          </MaterialLink>
          <Typography color="text.primary" variant="metadata">新建</Typography>
        </Breadcrumbs>

        <Stack sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'flex-end' }, justifyContent: 'space-between', gap: 2, mb: 3 }}>
          <Box>
            <Typography variant="pageTitle" component="h1">新建调研</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              从一个空白问题开始，或导入已有资料后再整理成团队可复用的研究。
            </Typography>
          </Box>
          <Typography variant="metadata" color="text.secondary" sx={{ flexShrink: 0, textAlign: { xs: 'left', sm: 'right' } }}>
            预计 2–5 分钟<br />可随时保存草稿
          </Typography>
        </Stack>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
          <ButtonBase
            component="button"
            type="button"
            onClick={() => setMode('create')}
            sx={{ display: 'block', width: '100%', borderRadius: 1.5, textAlign: 'left', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}
          >
            <Paper variant="outlined" sx={{ display: 'flex', minHeight: 176, width: '100%', flexDirection: 'column', justifyContent: 'space-between', p: 3, textAlign: 'left', transition: 'border-color var(--dr-motion-fast), background-color var(--dr-motion-fast)', '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' } }}>
              <Stack sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 1 }}>
                <FilePlus2 size={18} aria-hidden="true" color="var(--dr-color-primary)" />
                <Typography variant="listTitle" component="span">从空白创建</Typography>
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 2, maxWidth: 440 }}>
                直接写标题、正文和背景 / 结论 / 风险 / 标签。
              </Typography>
            </Paper>
          </ButtonBase>

          <ButtonBase
            component={Link}
            href="/researches/import"
            sx={{ display: 'block', width: '100%', borderRadius: 1.5, color: 'inherit', textAlign: 'left', textDecoration: 'none', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}
          >
            <Paper variant="outlined" sx={{ display: 'flex', minHeight: 176, width: '100%', flexDirection: 'column', justifyContent: 'space-between', p: 3, textAlign: 'left', transition: 'border-color var(--dr-motion-fast), background-color var(--dr-motion-fast)', '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' } }}>
              <Stack sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 1 }}>
                <Upload size={18} aria-hidden="true" color="var(--dr-color-primary)" />
                <Typography variant="listTitle" component="span">从文件导入</Typography>
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 2, maxWidth: 440 }}>
                拖入 .md / .txt / .html（单文件 ≤ 5MB），转换后保存为个人草稿。
              </Typography>
            </Paper>
          </ButtonBase>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', maxWidth: pageWidth, mx: 'auto' }}>
      <Stack sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Typography variant="panelTitle" component="h1">新建调研 · 编写正文</Typography>
        <Button type="button" variant="outlined" onClick={() => setMode('pick')}>
          取消选择
        </Button>
      </Stack>

      {error ? (
        <Alert
          severity={error === '请输入标题' ? 'warning' : 'error'}
          role="alert"
          aria-live="assertive"
          action={error !== '请输入标题' ? (
            <Button color="inherit" size="small" onClick={() => void handleSave()} disabled={saving}>
              重试
            </Button>
          ) : undefined}
          sx={{ mb: 2 }}
        >
          {error}
        </Alert>
      ) : null}

      <Stack sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box>
          <FormLabel htmlFor="new-title">标题</FormLabel>
          <AppTextField
            id="new-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="输入标题…"
            sx={{ mt: 0.75 }}
          />
        </Box>

        <Box>
          <FormLabel htmlFor="new-body">正文（Markdown）</FormLabel>
          <TextField
            id="new-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="使用 Markdown 编写…"
            multiline
            minRows={20}
            fullWidth
            sx={{ mt: 0.75, '& textarea': { resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 'var(--dr-line-height-reading)' } }}
          />
        </Box>

        <Paper component="details" variant="outlined" sx={{ p: 2 }}>
          <Box component="summary" sx={{ cursor: 'pointer', color: 'text.secondary', typography: 'control' }}>
            结构化字段（可选）
          </Box>
          <Stack sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 2 }}>
            {(
              [
                { id: 'bg', label: '背景', value: background, set: setBackground, placeholder: '调研背景…' },
                { id: 'cc', label: '结论', value: conclusion, set: setConclusion, placeholder: '调研结论…' },
                { id: 'rk', label: '风险', value: risks, set: setRisks, placeholder: '风险与待验证项…' },
              ] as const
            ).map((field) => (
              <Box key={field.id}>
                <FormLabel htmlFor={`new-${field.id}`}>{field.label}</FormLabel>
                <TextField
                  id={`new-${field.id}`}
                  value={field.value}
                  onChange={(event) => field.set(event.target.value)}
                  multiline
                  minRows={3}
                  fullWidth
                  placeholder={field.placeholder}
                  sx={{ mt: 0.75, '& textarea': { resize: 'vertical' } }}
                />
              </Box>
            ))}
          </Stack>
        </Paper>

        <Box>
          <FormLabel htmlFor="new-tags">标签（逗号分隔）</FormLabel>
          <AppTextField
            id="new-tags"
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            placeholder="例如: React, TypeScript, 架构"
            sx={{ mt: 0.75 }}
          />
          {tags.length > 0 ? (
            <TagList style={{ marginTop: 'var(--dr-space-2)' }}>
              {tags.map((tag) => <TagChip key={tag}>{tag}</TagChip>)}
            </TagList>
          ) : null}
        </Box>
      </Stack>

      <Stack sx={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', gap: 1, mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}>
        <Button
          type="button"
          variant="outlined"
          onClick={() => {
            // dirty 时确认,避免未保存内容丢失
            const dirty = title.trim() || body.trim() || background || conclusion || risks;
            if (!dirty) {
              router.push('/researches');
            } else {
              setLeaveConfirmOpen(true);
            }
          }}
        >
          取消
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存草稿'}
        </Button>
      </Stack>
      <AppDialog
        open={leaveConfirmOpen}
        onClose={() => setLeaveConfirmOpen(false)}
        title="确认离开？"
        description="取消后未保存的内容会丢失,确认离开?"
        actions={(
          <>
            <Button type="button" variant="outlined" onClick={() => setLeaveConfirmOpen(false)}>
              继续编辑
            </Button>
            <Button
              type="button"
              onClick={() => {
                setLeaveConfirmOpen(false);
                router.push('/researches');
              }}
            >
              确认离开
            </Button>
          </>
        )}
      />
    </Box>
  );
}
