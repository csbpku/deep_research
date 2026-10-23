'use client';

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Clock3, GitBranch, RefreshCw, Search } from 'lucide-react';
import { adminRootSx } from '../AdminMaterial';

type UsageItem = {
  id: string;
  operation: string;
  provider: string;
  requestedModel: string;
  actualModel: string | null;
  fallbackModel: string | null;
  usedFallback: boolean;
  status: string;
  errorKind: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
};

type Breakdown = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  fallbackCount: number;
  failureCount: number;
};

type UsageResponse = {
  days: number;
  summary: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    knownCostCents: number;
    fallbackCount: number;
    failureCount: number;
  };
  operationBreakdown: Array<Breakdown & { operation: string }>;
  modelBreakdown: Array<Breakdown & { model: string }>;
  daily: Array<{
    date: string;
    calls: number;
    totalTokens: number;
    fallbackCount: number;
    failureCount: number;
    knownCostCents: number;
  }>;
  failureBreakdown: Array<{ kind: string; count: number; operations: string[] }>;
  items: UsageItem[];
};

const number = new Intl.NumberFormat('zh-CN');
const token = (value: number | null) => number.format(value ?? 0);
const modelLabel = (model: string) => model.replace(/^anthropic:/u, '').replace(/^openai:/u, '');

export default function LlmUsageConsole() {
  const [days, setDays] = useState(7);
  const [search, setSearch] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const usage = useQuery<UsageResponse>({
    queryKey: ['admin-llm-usage', days],
    queryFn: async () => {
      const response = await fetch(`/api/admin/llm-usage?days=${days}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('读取 LLM 用量失败');
      return response.json() as Promise<UsageResponse>;
    },
    refetchInterval: 30_000,
  });

  const detailItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (usage.data?.items ?? []).filter((item) => {
      if (attentionOnly && !item.usedFallback && item.status === 'succeeded') return false;
      return !query || `${item.operation} ${item.requestedModel} ${item.errorKind ?? ''}`.toLowerCase().includes(query);
    });
  }, [attentionOnly, search, usage.data?.items]);

  if (usage.isLoading) {
    return (
      <Box sx={[adminRootSx, { display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', xl: 'repeat(4, 1fr)' }, gap: 2 }]}>
        {[0, 1, 2, 3].map((item) => <Skeleton key={item} variant="rounded" height={100} />)}
      </Box>
    );
  }
  if (usage.isError || !usage.data) {
    return (
      <Alert
        sx={adminRootSx}
        severity="error"
        action={<Button color="inherit" size="small" onClick={() => void usage.refetch()}>重新读取</Button>}
      >
        <Stack sx={{ flexDirection: 'row', gap: 1, alignItems: 'center' }}>
          <AlertTriangle size={16} aria-hidden="true" />
          <span>无法读取 LLM 用量审计</span>
        </Stack>
      </Alert>
    );
  }

  const { summary, operationBreakdown, modelBreakdown, daily, failureBreakdown } = usage.data;
  const totalTokens = summary.inputTokens + summary.outputTokens;
  const callCount = Math.max(summary.calls, 1);
  const fallbackRate = Math.round((summary.fallbackCount / callCount) * 100);
  const failureRate = Math.round((summary.failureCount / callCount) * 100);
  const maxDailyTokens = Math.max(1, ...daily.map((item) => item.totalTokens));
  const topFailedOperations = operationBreakdown
    .filter((item) => item.failureCount > 0)
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 5);

  return (
    <Stack component="section" sx={[adminRootSx, { gap: 3 }]}>
      <Stack sx={{ flexDirection: { xs: 'column', sm: 'row' }, gap: 2, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h2">Token 消耗</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            按环节统计实际记录的输入与输出 Token。
          </Typography>
        </Box>
        <Stack sx={{ flexDirection: 'row', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <ToggleButtonGroup
            aria-label="用量时间范围"
            exclusive
            size="small"
            value={days}
            onChange={(_event, value: number | null) => { if (value !== null) setDays(value); }}
          >
            {[1, 7, 30].map((value) => (
              <ToggleButton key={value} value={value} aria-label={`最近 ${value} 天`}>
                最近 {value} 天
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <IconButton aria-label="刷新用量" title="刷新用量" onClick={() => void usage.refetch()}>
            <RefreshCw size={17} aria-hidden="true" />
          </IconButton>
        </Stack>
      </Stack>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: 'action.hover' }}>
        <Stack sx={{ flexDirection: { xs: 'column', sm: 'row' }, gap: 2, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="subtitle2">运行信号</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              先看异常和降级，再进入按环节与按模型的明细。
            </Typography>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(80px, 1fr))', gap: { xs: 2, sm: 3 }, textAlign: 'right' }}>
            <Signal label="失败率" value={`${failureRate}%`} tone={failureRate > 0 ? 'danger' : 'success'} />
            <Signal label="降级率" value={`${fallbackRate}%`} tone={fallbackRate > 0 ? 'warning' : 'success'} />
            <Signal label="已知成本" value={`$${(summary.knownCostCents / 100).toFixed(2)}`} tone="default" />
          </Box>
        </Stack>
      </Paper>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(4, minmax(0, 1fr))' }, gap: 2 }}>
        <SummaryCard label="总 Token" value={token(totalTokens)} />
        <SummaryCard label="输入 Token" value={token(summary.inputTokens)} />
        <SummaryCard label="输出 Token" value={token(summary.outputTokens)} />
        <SummaryCard label="调用 / 降级" value={`${token(summary.calls)} / ${token(summary.fallbackCount)}`} hint={summary.failureCount > 0 ? `失败 ${token(summary.failureCount)} 次` : '没有失败调用'} />
      </Box>

      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <SectionHeading title="运行趋势与异常排行" description="按天观察 Token 峰值，再定位失败最多的环节和原因。" />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.4fr) minmax(280px, 1fr)' }, gap: 2.5, p: { xs: 2, sm: 2.5 } }}>
          <Box sx={{ minWidth: 0, borderRadius: 'var(--dr-radius-small)', bgcolor: 'action.hover', p: 2 }}>
            <Stack sx={{ flexDirection: 'row', gap: 2, alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography variant="subtitle2">Token 趋势</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                  柱高按当前时间范围内的日总 Token 归一化。
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{daily.length} 天</Typography>
            </Stack>
            {daily.length > 0 ? (
              <>
                <Box aria-label="每日 Token 趋势" role="img" sx={{ mt: 2, display: 'flex', alignItems: 'end', gap: 1, height: 116, overflow: 'hidden' }}>
                  {daily.map((item) => (
                    <Box
                      key={item.date}
                      title={`${formatTrendDate(item.date)} · ${token(item.totalTokens)} Token · 失败 ${item.failureCount} · 降级 ${item.fallbackCount}`}
                      sx={{ flex: '1 1 0', minWidth: 4, height: `${Math.max(4, (item.totalTokens / maxDailyTokens) * 100)}%`, bgcolor: 'primary.main', opacity: 0.78, borderRadius: 'var(--dr-radius-xs) var(--dr-radius-xs) 0 0', transition: 'opacity var(--dr-motion-fast)', '&:hover': { opacity: 1 } }}
                    />
                  ))}
                </Box>
                <Stack sx={{ mt: 1, flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Typography variant="caption" color="text.secondary">{formatTrendDate(daily[0].date)}</Typography>
                  <Typography variant="caption" color="text.secondary">{formatTrendDate(daily[daily.length - 1].date)}</Typography>
                </Stack>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>当前时间范围内没有趋势数据。</Typography>
            )}
          </Box>

          <Stack sx={{ minWidth: 0, gap: 2.5 }}>
            <RankingList title="失败最多的环节" emptyLabel="当前没有失败环节。" items={topFailedOperations.map((item) => ({ label: item.operation, value: item.failureCount, total: item.calls, suffix: '次' }))} />
            <RankingList title="失败原因" emptyLabel="当前没有失败原因。" items={failureBreakdown.slice(0, 5).map((item) => ({ label: item.kind, value: item.count, total: failureBreakdown[0]?.count ?? item.count, suffix: '次' }))} />
          </Stack>
        </Box>
      </Paper>

      <UsageTable title="按环节汇总" description="这里是主要查看入口；每一行对应一个业务步骤。" label="按环节汇总" minWidth={760}>
        <TableHead><TableRow>
          <HeaderCell>环节</HeaderCell><HeaderCell align="right">调用次数</HeaderCell><HeaderCell align="right">输入 Token</HeaderCell><HeaderCell align="right">输出 Token</HeaderCell><HeaderCell align="right">总 Token</HeaderCell><HeaderCell align="right">降级</HeaderCell><HeaderCell align="right">失败</HeaderCell>
        </TableRow></TableHead>
        <TableBody>
          {operationBreakdown.map((item) => <TableRow key={item.operation} hover>
            <DataCell mono>{item.operation}</DataCell><DataCell align="right" mono>{token(item.calls)}</DataCell><DataCell align="right" mono>{token(item.inputTokens)}</DataCell><DataCell align="right" mono>{token(item.outputTokens)}</DataCell><DataCell align="right" mono bold>{token(item.totalTokens)}</DataCell><DataCell align="right" mono>{token(item.fallbackCount)}</DataCell><DataCell align="right" mono>{token(item.failureCount)}</DataCell>
          </TableRow>)}
          {operationBreakdown.length === 0 ? <EmptyTableRow colSpan={7}>当前时间范围内没有记录。</EmptyTableRow> : null}
        </TableBody>
      </UsageTable>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
        <UsageTable title="按模型汇总" label="按模型汇总">
          <TableHead><TableRow><HeaderCell>模型</HeaderCell><HeaderCell align="right">输入</HeaderCell><HeaderCell align="right">输出</HeaderCell><HeaderCell align="right">合计</HeaderCell></TableRow></TableHead>
          <TableBody>
            {modelBreakdown.map((item) => <TableRow key={item.model} hover>
              <DataCell mono>{modelLabel(item.model)}</DataCell><DataCell align="right" mono>{token(item.inputTokens)}</DataCell><DataCell align="right" mono>{token(item.outputTokens)}</DataCell><DataCell align="right" mono bold>{token(item.totalTokens)}</DataCell>
            </TableRow>)}
            {modelBreakdown.length === 0 ? <EmptyTableRow colSpan={4}>当前时间范围内没有记录。</EmptyTableRow> : null}
          </TableBody>
        </UsageTable>
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          <SectionHeading title="已知成本" />
          <Box sx={{ p: 2.5 }}>
            <Typography variant="h2" sx={{ fontVariantNumeric: 'tabular-nums' }}>${(summary.knownCostCents / 100).toFixed(2)}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 520 }}>
              只有上游返回价格或主研究引擎提供成本时才会计入；Token 统计不受此限制。
            </Typography>
          </Box>
        </Paper>
      </Box>

      <UsageTable
        title="调用明细"
        description={`显示最新 ${usage.data.items.length} 条记录。`}
        label="调用明细"
        minWidth={980}
        actions={
          <Stack sx={{ flexDirection: { xs: 'column', sm: 'row' }, gap: 1 }}>
            <TextField
              aria-label="搜索环节或模型"
              size="small"
              placeholder="搜索环节或模型"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> } }}
              sx={{ width: { xs: '100%', sm: 220 } }}
            />
            <Button
              variant={attentionOnly ? 'contained' : 'outlined'}
              color={attentionOnly ? 'warning' : 'inherit'}
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly((value) => !value)}
            >
              仅看异常
            </Button>
          </Stack>
        }
      >
        <TableHead><TableRow>
          <HeaderCell>时间</HeaderCell><HeaderCell>环节</HeaderCell><HeaderCell>模型</HeaderCell><HeaderCell>状态</HeaderCell><HeaderCell align="right">输入</HeaderCell><HeaderCell align="right">输出</HeaderCell><HeaderCell align="right">延迟</HeaderCell><HeaderCell>备注</HeaderCell>
        </TableRow></TableHead>
        <TableBody>
          {detailItems.map((item) => <TableRow key={item.id} hover>
            <DataCell nowrap secondary>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</DataCell>
            <DataCell mono>{item.operation}</DataCell><DataCell mono>{modelLabel(item.actualModel ?? item.requestedModel)}</DataCell>
              <TableCell>
              {item.usedFallback
                ? <Chip size="small" color="warning" icon={<GitBranch size={14} aria-hidden="true" />} label="降级" />
                : item.status === 'succeeded'
                  ? <Chip size="small" color="success" icon={<CheckCircle2 size={14} aria-hidden="true" />} label="成功" />
                  : <Chip size="small" color="error" icon={<AlertTriangle size={14} aria-hidden="true" />} label="失败" />}
            </TableCell>
            <DataCell align="right" mono>{token(item.inputTokens)}</DataCell><DataCell align="right" mono>{token(item.outputTokens)}</DataCell>
            <DataCell align="right" mono secondary>{item.latencyMs === null ? '—' : `${token(item.latencyMs)} ms`}</DataCell>
            <DataCell truncate secondary>{item.usedFallback ? `fallback → ${modelLabel(item.fallbackModel ?? 'deepseek-v4-flash')}` : item.errorKind ?? '—'}</DataCell>
          </TableRow>)}
          {detailItems.length === 0 ? <EmptyTableRow colSpan={8}>没有匹配的调用记录。</EmptyTableRow> : null}
        </TableBody>
      </UsageTable>
    </Stack>
  );
}

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <Box sx={{ px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Typography variant="subtitle2">{title}</Typography>
      {description ? <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>{description}</Typography> : null}
    </Box>
  );
}

function UsageTable({
  title,
  description,
  label,
  minWidth,
  actions,
  children,
}: {
  title: string;
  description?: string;
  label: string;
  minWidth?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ minWidth: 0, overflow: 'hidden' }}>
      {actions ? (
        <Stack sx={{ px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider', flexDirection: { xs: 'column', md: 'row' }, gap: 1.5, alignItems: { md: 'center' }, justifyContent: 'space-between' }}>
              <Box>
                <Stack sx={{ flexDirection: 'row', gap: 1, alignItems: 'center' }}>
                  {title === '调用明细' ? <Clock3 size={16} aria-hidden="true" /> : null}
                  <Typography variant="subtitle2">{title}</Typography>
                </Stack>
                {description ? <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>{description}</Typography> : null}
              </Box>
          {actions}
        </Stack>
      ) : <SectionHeading title={title} description={description} />}
      <TableContainer
        role="region"
        aria-label={label}
        tabIndex={0}
        sx={{ maxWidth: '100%', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
      >
        <Table size="small" sx={{ minWidth: minWidth ?? 0, '& th': { bgcolor: 'action.hover' }, '& td, & th': { borderColor: 'divider' } }}>
          {children}
        </Table>
      </TableContainer>
      <Stack sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider', color: 'text.secondary', display: { xs: 'flex', lg: 'none' }, flexDirection: 'row', gap: 1, alignItems: 'center' }}>
        <ArrowLeftRight size={14} aria-hidden="true" />
        <Typography variant="caption">左右滑动查看完整明细</Typography>
      </Stack>
    </Paper>
  );
}

function HeaderCell({ children, align }: { children: ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <TableCell align={align} sx={{ whiteSpace: 'nowrap', fontSize: 'var(--dr-type-caption)', fontWeight: 600, color: 'text.secondary' }}>{children}</TableCell>;
}

function DataCell({
  children,
  align,
  mono = false,
  bold = false,
  nowrap = false,
  secondary = false,
  truncate = false,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  bold?: boolean;
  nowrap?: boolean;
  secondary?: boolean;
  truncate?: boolean;
}) {
  return (
    <TableCell align={align} sx={{ fontFamily: mono ? 'monospace' : undefined, fontVariantNumeric: mono ? 'tabular-nums' : undefined, fontWeight: bold ? 600 : undefined, color: secondary ? 'text.secondary' : undefined, whiteSpace: nowrap ? 'nowrap' : undefined, maxWidth: truncate ? 224 : undefined, overflow: truncate ? 'hidden' : undefined, textOverflow: truncate ? 'ellipsis' : undefined }}>
      {children}
    </TableCell>
  );
}

function EmptyTableRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return <TableRow><TableCell align="center" colSpan={colSpan} sx={{ py: 4, color: 'text.secondary' }}>{children}</TableCell></TableRow>;
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h2" sx={{ mt: 1, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</Typography>
      {hint ? <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>{hint}</Typography> : null}
    </Paper>
  );
}

function RankingList({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: Array<{ label: string; value: number; total: number; suffix: string }>;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <Box>
      <Typography variant="subtitle2">{title}</Typography>
      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{emptyLabel}</Typography>
      ) : (
        <Stack sx={{ mt: 1.5, gap: 1.5 }}>
          {items.map((item) => (
            <Box key={item.label} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 2, alignItems: 'center' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="caption" title={item.label} noWrap sx={{ fontFamily: 'monospace' }}>{item.label}</Typography>
                <Box sx={{ mt: 1, height: 6, overflow: 'hidden', borderRadius: 'var(--dr-radius-small)', bgcolor: 'action.selected' }}>
                  <Box sx={{ height: '100%', width: `${Math.max(4, (item.value / max) * 100)}%`, bgcolor: 'error.main', opacity: 0.75, borderRadius: 'var(--dr-radius-small)' }} />
                </Box>
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {token(item.value)}{item.suffix}{item.total > item.value ? ` / ${token(item.total)}` : ''}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function formatTrendDate(value: string): string {
  const [, month, day] = value.split('-');
  return month && day ? `${month}/${day}` : value;
}

function Signal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'default' | 'success' | 'warning' | 'danger';
}) {
  const color = tone === 'success' ? 'success.main' : tone === 'warning' ? 'warning.main' : tone === 'danger' ? 'error.main' : 'text.primary';
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h3" sx={{ mt: 0.5, color, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    </Box>
  );
}
