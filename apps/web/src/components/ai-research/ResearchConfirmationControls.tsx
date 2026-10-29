'use client';

import { FileText, Globe2, Link2, Presentation, Sparkles, X } from 'lucide-react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Input from '@mui/material/TextField';

export type ReportType = 'research_report' | 'summary_brief' | 'slides' | 'web_brief';
export type ResearchLength = 'brief' | 'standard' | 'deep';
export type SourcePolicy = 'prefer_user_sources' | 'only_user_sources';
export type ResearchSourceRef = { type: 'url' | 'favorite' | 'research' | 'summary'; value: string; required: boolean };
export interface ResearchConfirmationControlsProps {
  reportType: ReportType;
  reportLength: ResearchLength;
  sourcePolicy: SourcePolicy;
  sourceRefs: ResearchSourceRef[];
  sourceUrls: string[];
  sourceDraft: string;
  selectedContextCount: number;
  seed: { id: string; title: string; url: string; interpretation: string | null; body: string | null } | null;
  submitting: boolean;
  planning: boolean;
  scopeIncomplete: boolean;
  onReportTypeChange: (value: ReportType) => void;
  onReportLengthChange: (value: ResearchLength) => void;
  onSourcePolicyChange: (value: SourcePolicy) => void;
  onSourceDraftChange: (value: string) => void;
  onAddSource: () => void;
  onRemoveSource: (url: string) => void;
}

const outputs = [
  { value: 'research_report', label: '研究稿', detail: '完整论证与引用，生成可编辑的私有草稿。', icon: FileText },
  { value: 'slides', label: 'Slides 提纲', detail: '按页组织要点与讲述线索，可继续编辑；不是 PPT 文件。', icon: Presentation },
  { value: 'web_brief', label: '网页简报', detail: '适合独立阅读的网页版本，保留研究依据。', icon: Globe2 },
  { value: 'summary_brief', label: '快速判断', detail: '先看方向；不做完整检索与逐条核验，不创建正式研究稿。', icon: Sparkles },
] as const;
const legendSx = { typography: 'fieldTitle', fontWeight: 600, color: 'text.primary', mb: 1, '&.Mui-focused': { color: 'text.primary' } };
const optionLabel = (title: string, description: string) => (
  <Box component="span" sx={{ display: 'grid', gap: 0.5, minWidth: 0 }}>
    <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
    <Typography component="span" variant="metadata" color="text.secondary">{description}</Typography>
  </Box>
);

export function ResearchConfirmationControls(props: ResearchConfirmationControlsProps) {
  const { reportType, reportLength, sourcePolicy, sourceRefs, sourceUrls, sourceDraft, selectedContextCount, seed, submitting, scopeIncomplete,
    onReportTypeChange, onReportLengthChange, onSourcePolicyChange, onSourceDraftChange, onAddSource, onRemoveSource } = props;
  const output = outputs.find(item => item.value === reportType)!;
  const sourceCount = sourceRefs.length + selectedContextCount;
  const missingSource = sourcePolicy === 'only_user_sources' && sourceCount === 0;
  return (
    <Box sx={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <FormControl component="fieldset" disabled={submitting} sx={{ minWidth: 0 }}>
        <FormLabel component="legend" sx={legendSx}>交付什么</FormLabel>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>选一种产物；研究问题和资料会一起保留。</Typography>
        <RadioGroup aria-label="交付什么" name="research-output" value={reportType} onChange={event => onReportTypeChange(event.target.value as ReportType)}
          sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gridAutoRows: '1fr', gap: 1.5 }}>
          {outputs.map(item => {
            const Icon = item.icon;
            const selected = reportType === item.value;
            return (
              <FormControlLabel key={item.value} value={item.value} control={<Radio size="small" />}
                label={<Box component="span" sx={{ display: 'grid', gap: 0.75, minWidth: 0 }}>
                  <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Icon size={16} aria-hidden /><Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>{item.label}</Typography></Box>
                  <Typography component="span" variant="metadata" color="text.secondary">{item.detail}</Typography>
                </Box>}
                sx={{ m: 0, p: 1.5, minHeight: 104, minWidth: 0, alignItems: 'flex-start', gap: 0.5, border: 1, borderRadius: 1,
                  borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? 'action.selected' : 'background.paper',
                  '&:hover': { borderColor: 'primary.main' }, '&:has(input:focus-visible)': { outline: '2px solid var(--dr-color-primary)', outlineOffset: 2 },
                  '& .MuiFormControlLabel-label': { minWidth: 0, overflowWrap: 'anywhere' }, '& .MuiRadio-root': { p: 0.5, mt: -0.25 } }} />
            );
          })}
        </RadioGroup>
      </FormControl>

      {reportType !== 'summary_brief' ? (
        <FormControl component="fieldset" disabled={submitting} sx={{ minWidth: 0, borderTop: 1, borderColor: 'divider', pt: 3 }}>
          <FormLabel component="legend" sx={legendSx}>投入多少</FormLabel>
          <RadioGroup aria-label="投入多少" name="research-depth" value={reportLength} onChange={event => onReportLengthChange(event.target.value as ResearchLength)}
            sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
            <FormControlLabel value="standard" control={<Radio size="small" />} sx={{ m: 0, alignItems: 'flex-start' }} label={optionLabel('单轮研究', '完成一轮检索与分析，适合范围明确的问题。')} />
            <FormControlLabel value="deep" control={<Radio size="small" />} sx={{ m: 0, alignItems: 'flex-start' }} label={optionLabel('多轮研究', '先覆盖多个角度，再按证据缺口补查；耗时更长。')} />
          </RadioGroup>
          {sourcePolicy === 'only_user_sources' ? <Typography variant="metadata" color="text.secondary" sx={{ mt: 1.5 }}>当前仅分析指定资料，研究投入不会扩大资料范围。</Typography> : null}
        </FormControl>
      ) : null}

      <FormControl component="fieldset" disabled={submitting} sx={{ minWidth: 0, borderTop: 1, borderColor: 'divider', pt: 3 }}>
        <FormLabel component="legend" sx={legendSx}>参考什么</FormLabel>
        <RadioGroup aria-label="参考什么" name="research-source-policy" value={sourcePolicy} onChange={event => onSourcePolicyChange(event.target.value as SourcePolicy)} sx={{ gap: 1.5 }}>
          <FormControlLabel value="prefer_user_sources" control={<Radio size="small" />} sx={{ m: 0, alignItems: 'flex-start' }} label={optionLabel('网页搜索 + 已选资料', '检索公开网页，同时参考你明确选择的资料。')} />
          <FormControlLabel value="only_user_sources" control={<Radio size="small" />} sx={{ m: 0, alignItems: 'flex-start' }} label={optionLabel('仅使用已选资料', '只读取你添加的资料，不搜索其他网页。')} />
        </RadioGroup>
        <Box sx={{ display: 'grid', gap: 1.5, mt: 2, minWidth: 0 }}>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', color: 'info.main', typography: 'metadata' }}>
            <Link2 size={16} aria-hidden />
            <Box component="span">{sourceCount ? `已选 ${sourceCount} 条资料` : '尚未添加资料'}{seed ? '（含当前雷达内容）' : ''}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }}>
            <Input id="conversation-source-url" fullWidth label="添加网页资料（可选）" type="url" value={sourceDraft}
              onChange={event => onSourceDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onAddSource(); } }} placeholder="https://…" disabled={submitting} sx={{ minWidth: 0 }} />
            <Button type="button" variant="outlined" onClick={onAddSource} disabled={submitting || !sourceDraft.trim()} aria-label="添加网页资料" sx={{ flexShrink: 0, minHeight: 40 }}>添加</Button>
          </Box>
          {sourceUrls.length ? <Box component="ul" sx={{ display: 'grid', gap: 1, m: 0, p: 0, listStyle: 'none' }}>{sourceUrls.map(url => (
            <Box component="li" key={url} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
              <Typography variant="metadata" sx={{ color: 'info.main', overflowWrap: 'anywhere', minWidth: 0 }}>{url}</Typography>
              <Button type="button" size="small" disabled={submitting} onClick={() => onRemoveSource(url)} aria-label={`移除资料 ${url}`} sx={{ flexShrink: 0 }}><X size={14} aria-hidden />移除</Button>
            </Box>
          ))}</Box> : null}
        </Box>
      </FormControl>
      {scopeIncomplete ? <Alert severity="warning">请填写完整有效的自定义日期范围后再开始研究。</Alert> : null}
      {missingSource ? <Alert severity="warning">仅使用已选资料时，请先添加至少一条资料。</Alert> : null}
      <Box component="section" aria-label="启动配置摘要" sx={{ borderTop: 1, borderColor: 'divider', pt: 2.5, display: 'grid', gap: 0.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>本次将生成 {output.label}</Typography>
        <Typography variant="metadata" color="text.secondary">{reportType === 'summary_brief' ? '仅模型摘录，不做完整研究' : reportLength === 'deep' ? '多轮研究' : '单轮研究'} · {sourcePolicy === 'only_user_sources' ? '仅使用已选资料' : '网页搜索 + 已选资料'}{sourceCount ? ` · ${sourceCount} 条已选资料` : ''}</Typography>
      </Box>
    </Box>
  );
}
