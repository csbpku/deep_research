'use client';

import { stripResearchCitationMarkers } from '@/lib/ai-research-state';

import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Clipboard, Send, Sparkles, UserRound, X } from 'lucide-react';

import { AiResearchButton as Button, AiResearchTextarea as Textarea } from '@/components/ai-research/AiResearchMaterial';
import MarkdownContent from '@/components/MarkdownContent';
import { KnowledgeCardComposer } from '@/components/KnowledgeCardComposer';
import type { AiResearchChatMessage, AiResearchConversationDetail, FollowUpIntent } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { formatResearchActionItems, parseResearchActionItems } from '@/lib/research-action-items';
import { domainAppearance } from '@/components/domain/appearance';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

const TYPEWRITER_INTERVAL_MS = 16;
const TYPEWRITER_CHARS_PER_TICK = 4;
const FOLLOW_UP_INTENTS: Array<{ value: FollowUpIntent; label: string; prompt: string }> = [
  { value: 'answer', label: '继续问答', prompt: '继续解释这份调研中最关键的判断，并说明依据。' },
  { value: 'verify', label: '核验证据', prompt: '核验报告中最关键的结论：逐条说明支持证据、反例或仍缺失的证据，不要把推断说成事实。' },
  { value: 'revise', label: '修改报告', prompt: '根据本次追问，提出可以纳入报告的修改内容；请明确修改依据和涉及的证据。' },
  { value: 'action', label: '生成行动项', prompt: '把报告结论整理成下一步行动项，包含负责人需要验证的假设、优先级和完成条件。' },
];

interface StreamEventPayload {
  code?: string;
  message?: string;
  message_id?: string;
  content?: string;
}

export function ResearchChatPanel({
  conversation,
  canAsk,
  note,
  reportId,
  reportContent,
}: {
  conversation: AiResearchConversationDetail | null;
  canAsk: boolean;
  note?: string;
  reportId?: string | null;
  reportContent?: string | null;
}) {
  const [messages, setMessages] = useState<AiResearchChatMessage[]>(conversation?.messages ?? []);
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<FollowUpIntent>('answer');
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revisionMessageId, setRevisionMessageId] = useState<string | null>(null);
  const [appliedRevisionIds, setAppliedRevisionIds] = useState<Set<string>>(() => new Set());
  const [revisionSaving, setRevisionSaving] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reviewClaimPrefillRef = useRef<string | null>(null);
  const pendingRef = useRef('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setMessages(conversation?.messages ?? []);
  }, [conversation]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, sending]);

  // A claim-level review action arrives as a deep link from the review
  // ledger.  Turn it into an explicit verification request, but keep the
  // request as a draft: navigating to “核验这条” must never send a message or
  // mutate the report without the user's confirmation.
  useEffect(() => {
    if (!canAsk || !conversation?.id || typeof window === 'undefined') return;
    const claim = new URLSearchParams(window.location.search).get('reviewClaim')?.trim();
    if (!claim || reviewClaimPrefillRef.current === claim) return;
    reviewClaimPrefillRef.current = claim;
    setIntent('verify');
    setInput([
      '请确认下面这条结论：',
      '',
      `> ${claim.replace(/\r?\n/gu, '\n> ')}`,
      '',
      '请只依据本轮保存的原文摘录，说明：支持、反驳，还是证据不足；如果无法核验，请明确指出还缺什么。',
    ].join('\n'));
    requestAnimationFrame(() => {
      const chat = document.getElementById('research-chat');
      if (!chat) return;
      window.scrollTo({
        top: Math.max(0, window.scrollY + chat.getBoundingClientRect().top - 72),
        behavior: 'smooth',
      });
    });
  }, [canAsk, conversation?.id]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function stopTypewriter(flushAll: boolean) {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (flushAll) pendingRef.current = '';
  }

  function scheduleTypewriter(streamingId: string) {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const chunk = pendingRef.current.slice(0, TYPEWRITER_CHARS_PER_TICK);
      pendingRef.current = pendingRef.current.slice(chunk.length);
      if (chunk) {
        setMessages((current) => current.map((message) => (
          message.id === streamingId ? { ...message, content: message.content + chunk } : message
        )));
      }
      if (pendingRef.current) scheduleTypewriter(streamingId);
    }, TYPEWRITER_INTERVAL_MS);
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || !conversation || sending || !canAsk) return;
    setInput('');
    setErr(null);
    setSending(true);
    setSlow(false);

    const userMessage: AiResearchChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
      intent,
    };
    const streamingId = `streaming-${Date.now()}`;
    const placeholder: AiResearchChatMessage = {
      id: streamingId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      intent,
    };
    setMessages((current) => [...current, userMessage, placeholder]);
    pendingRef.current = '';
    const slowTimer = window.setTimeout(() => setSlow(true), 12_000);

    try {
      const response = await fetch(`/api/ai-research/conversations/${encodeURIComponent(conversation.id)}/messages/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: trimmed, intent }),
      });
      if (!response.ok || !response.body) {
        const apiError = await toApiHttpError(response, '追问失败');
        throw new Error(friendlyMessage(apiError, '追问失败，请稍后重试。'));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let complete = false;
      let renderedAssistantId = streamingId;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          const eventLine = lines.find((line) => line.startsWith('event: '));
          const dataLine = lines.find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const event = eventLine ? eventLine.slice(7).trim() : 'progress';
          let rawPayload: unknown;
          try {
            rawPayload = JSON.parse(dataLine.slice(6)) as unknown;
          } catch {
            continue;
          }
          if (event === 'delta' && typeof rawPayload === 'string') {
            pendingRef.current += rawPayload;
            scheduleTypewriter(streamingId);
          } else if (event === 'delta' && rawPayload && typeof rawPayload === 'object' && typeof (rawPayload as { content?: unknown }).content === 'string') {
            pendingRef.current += (rawPayload as { content: string }).content;
            scheduleTypewriter(streamingId);
          } else if (event === 'done') {
            complete = true;
            stopTypewriter(false);
            const payload = rawPayload as StreamEventPayload;
            const content = payload.content ?? pendingRef.current;
            pendingRef.current = '';
            setMessages((current) => current.map((message) => (
              message.id === streamingId
                ? { ...message, id: payload.message_id ?? message.id, content }
                : message
            )));
            renderedAssistantId = payload.message_id ?? streamingId;
          } else if (event === 'persisted') {
            const payload = rawPayload as StreamEventPayload;
            if (payload.message_id) {
              // upstream 的 message_id 只是流内 id；切换为 BFF 真正落库的 UUID，
              // 后续“应用到报告”才能把修订可靠地关联回这条追问。
              setMessages((current) => current.map((message) => (
                message.id === renderedAssistantId || message.id === streamingId
                  ? { ...message, id: payload.message_id! }
                  : message
              )));
              renderedAssistantId = payload.message_id;
            }
          } else if (event === 'error') {
            const payload = rawPayload as StreamEventPayload;
            setErr(payload.message ?? '追问失败，请稍后重试。');
            setMessages((current) => current.map((message) => (
              message.id === streamingId
                ? { ...message, content: `回答失败：${payload.message ?? '追问失败，请稍后重试。'}` }
                : message
            )));
            complete = true;
          }
        }
      }
      if (!complete) {
        // 流在 done 前断开：保留已生成的部分，避免用户以为内容丢失。
        setMessages((current) => current.map((message) => (
          message.id === streamingId ? { ...message, content: message.content || '回答已中断，请重试。' } : message
        )));
      }
    } catch (sendError) {
      setErr(sendError instanceof Error ? sendError.message : '追问失败，请稍后重试。');
      setMessages((current) => current.map((message) => (
        message.id === streamingId
          ? { ...message, content: `回答失败：${sendError instanceof Error ? sendError.message : '追问失败，请稍后重试。'}` }
          : message
      )));
    } finally {
      window.clearTimeout(slowTimer);
      setSlow(false);
      setSending(false);
      pendingRef.current = '';
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }

  async function applyRevision(message: AiResearchChatMessage) {
    if (message.intent !== 'revise' || !reportId || !reportContent || revisionSaving) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(message.id)) {
      setRevisionError('这条回答还没有完成保存，请稍候再试。');
      return;
    }
    if (!message.content.trim()) return;
    setRevisionSaving(true);
    setRevisionError(null);
    try {
      const response = await fetch(`/api/researches/${encodeURIComponent(reportId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionContext: {
            sourceMessageId: message.id,
          },
        }),
      });
      if (!response.ok) {
        const apiError = await toApiHttpError(response, '应用修订失败');
        throw new Error(friendlyMessage(apiError, '应用修订失败，请稍后重试。'));
      }
      setRevisionMessageId(null);
      setRevisionError(null);
      setAppliedRevisionIds((current) => new Set(current).add(message.id));
      window.dispatchEvent(new CustomEvent('ai-research-report-updated', { detail: { reportId } }));
    } catch (error) {
      setRevisionError(error instanceof Error ? error.message : '应用修订失败，请稍后重试。');
    } finally {
      setRevisionSaving(false);
    }
  }

  return (
    <Paper component="section" id="research-chat" variant="outlined" sx={{ mt: 3, overflow: 'hidden', bgcolor: 'background.default' }} aria-label="研究对话">
      <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1, borderBottom: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}>
          <Sparkles size={16} />
          <Typography variant="fieldTitle" component="h3">继续追问</Typography>
        </Stack>
        {canAsk ? (
          <Typography variant="metadata" color="text.secondary">{note ?? '回答基于本次调研报告，会自动保存到对话。'}</Typography>
        ) : (
          <Typography variant="metadata" color="text.secondary">{note ?? '研究完成后可以在这里继续追问。'}</Typography>
        )}
      </Box>

      <Box
        ref={scrollRef}
        sx={{ minHeight: 180, maxHeight: { lg: 420 }, overflowY: { xs: 'visible', lg: 'auto' }, px: 2, py: 2, display: 'flex', flexDirection: 'column', gap: 2 }}
        aria-live="polite"
      >
        {conversation === null ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'text.secondary' }}><CircularProgress size={16} aria-label="正在恢复对话" /><Typography variant="body2">正在恢复对话…</Typography></Stack>
        ) : messages.length === 0 ? (
          <Typography variant="body2" color="text.secondary">还没有对话内容。研究完成后，可以从报告结论继续深入提问。</Typography>
        ) : (
          messages.map((message, index) => (
            <Stack key={message.id} direction="row" spacing={1.25} sx={{ alignItems: 'flex-start', flexDirection: message.role === 'user' ? 'row-reverse' : 'row' }}>
              <Avatar sx={{ width: 28, height: 28, flexShrink: 0, bgcolor: message.role === 'assistant' ? 'action.selected' : 'action.hover', color: message.role === 'assistant' ? 'primary.main' : 'text.secondary' }}>
                {message.role === 'assistant' ? <Bot size={16} /> : <UserRound size={16} />}
              </Avatar>
              <Box
                sx={{ minWidth: 0, maxWidth: '86%' }}
                data-knowledge-source-message={message.role === 'assistant' ? message.id : undefined}
              >
                <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 500 }}>
                  {message.role === 'assistant' ? 'AI 调研助手' : '你'}
                  {message.id.startsWith('streaming-') ? ' · 生成中' : ''}
                </Typography>
                {message.role === 'assistant' && message.content ? (
                  message.intent === 'action'
                    ? <ActionItemsView content={message.content} />
                    : <Box sx={{ mt: 0.5, typography: 'reading', overflowWrap: 'anywhere' }}><MarkdownContent content={stripResearchCitationMarkers(message.content)} compact /></Box>
                ) : (
                  <Typography variant="reading" component="p" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {message.role === 'assistant' ? stripResearchCitationMarkers(message.content) : message.content}
                    {message.id.startsWith('streaming-') && message.content === '' && sending ? (
                      <CircularProgress size={12} sx={{ ml: 1, verticalAlign: 'middle' }} aria-label="正在生成回答" />
                    ) : null}
                  </Typography>
                )}
                {reportId && reportContent && message.intent === 'revise' && message.role === 'assistant' && message.content && index === messages.length - 1 ? (
                  <Box sx={{ mt: 1 }}>
                    {appliedRevisionIds.has(message.id) ? (
                      <Typography variant="metadata" color="success.main">已生成新版本 · 可在编辑器的版本历史中恢复</Typography>
                    ) : revisionMessageId === message.id ? (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover', borderColor: 'primary.main' }}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <Typography variant="fieldTitle">应用为报告新版本？</Typography>
                          <IconButton size="small" onClick={() => setRevisionMessageId(null)} aria-label="关闭修订预览"><X size={16} /></IconButton>
                        </Stack>
                        <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>这会把本次追问整理为报告末尾的“追问补充”，原版本仍可在版本历史中恢复。</Typography>
                        <Box sx={{ mt: 1.5, display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' } }}>
                          <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
                            <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 500 }}>原报告末尾</Typography>
                            <Typography variant="metadata" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{reportContent.trim().slice(-420)}</Typography>
                          </Paper>
                          <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0, borderColor: 'primary.main', bgcolor: 'action.selected' }}>
                            <Typography variant="metadata" color="primary.main" sx={{ fontWeight: 500 }}>将新增</Typography>
                            <Typography variant="metadata" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>## 追问补充{`\n\n`}{message.content}</Typography>
                          </Paper>
                        </Box>
                        {revisionError ? <Alert severity="error" role="alert" sx={{ mt: 1.5 }}>{revisionError}</Alert> : null}
                        <Stack direction="row" spacing={1} sx={{ mt: 1.5, justifyContent: 'flex-end' }}>
                          <Button type="button" variant="ghost" size="xs" onClick={() => setRevisionMessageId(null)} disabled={revisionSaving}>取消</Button>
                          <Button type="button" size="xs" onClick={() => void applyRevision(message)} disabled={revisionSaving}>
                            <Check size={14} />{revisionSaving ? '保存中…' : '确认生成新版本'}
                          </Button>
                        </Stack>
                      </Paper>
                    ) : (
                      <Button type="button" variant="link" size="xs" onClick={() => { setRevisionError(null); setRevisionMessageId(message.id); }}>
                        应用到报告 · 先预览变更
                      </Button>
                    )}
                  </Box>
                ) : null}
                {message.role === 'assistant' && message.content && !message.id.startsWith('streaming-') ? (
                  <KnowledgeCardComposer sourceKind="research_chat" messageId={message.id} />
                ) : null}
              </Box>
            </Stack>
          ))
        )}
        {sending && slow ? (
          <Typography variant="metadata" color="text.secondary" role="status">模型仍在思考，可能还需要一点时间…</Typography>
        ) : null}
      </Box>

      {canAsk && !sending && messages.length > 0 ? (
        <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center', borderTop: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
          <Typography variant="metadata" color="text.secondary" sx={{ mr: 0.5 }}>研究动作：</Typography>
          {FOLLOW_UP_INTENTS.map((item) => (
            <Button
              key={item.value}
              type="button"
              aria-pressed={intent === item.value}
              size="xs"
              variant={intent === item.value ? 'secondary' : 'outline'}
              onClick={() => { setIntent(item.value); setInput(item.prompt); }}
              sx={{ minHeight: 'var(--dr-control-height)', px: 1.5 }}
            >
              {item.label}
            </Button>
          ))}
        </Stack>
      ) : null}

      {err ? (
        <Alert severity="error" role="alert" sx={{ mx: 2, mb: 1.5 }}>{err}</Alert>
      ) : null}

      <Box sx={{ borderTop: 1, borderColor: 'divider', p: 1.5 }}>
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', '&:focus-within': { borderColor: 'primary.main', boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}22` } }}>
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={canAsk ? '针对这份调研继续追问…' : '研究完成后可继续追问'}
            rows={2}
            maxLength={32000}
            aria-label="研究对话输入"
            disabled={!canAsk || sending}
            sx={{ '& .MuiOutlinedInput-root': { minHeight: 64, bgcolor: 'transparent', boxShadow: 'none', '& fieldset': { border: 0 } }, '& textarea': { resize: 'none' } }}
          />
          <Stack direction="row" spacing={1.5} sx={{ px: 1.5, pb: 1.5, justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="metadata" color="text.secondary">{FOLLOW_UP_INTENTS.find((item) => item.value === intent)?.label} · ⌘/Ctrl + Enter 发送</Typography>
            <Button type="button" size="sm" onClick={() => void sendMessage()} disabled={!input.trim() || !canAsk || sending} aria-label="发送追问">
              {sending ? <CircularProgress size={14} color="inherit" /> : <Send size={14} />}
              发送
            </Button>
          </Stack>
        </Box>
      </Box>
    </Paper>
  );
}

function ActionItemsView({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const items = parseResearchActionItems(content);

  async function copyItems() {
    if (items.length === 0) return;
    try {
      await navigator.clipboard.writeText(formatResearchActionItems(items));
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError(true);
    }
  }

  if (items.length === 0) {
    return (
      <Paper variant="outlined" sx={{ mt: 1, p: 1.5, ...domainAppearance('warning') }}>
        <Typography variant="metadata" sx={{ fontWeight: 600 }}>行动项未按约定格式返回</Typography>
        <Typography variant="metadata" sx={{ display: 'block', mt: 0.5 }}>原始回答仍已保存；请重试生成行动项，避免把缺失的负责人或完成条件猜出来。</Typography>
        <Box component="details" sx={{ mt: 1, '& summary': { cursor: 'pointer', color: 'primary.main', typography: 'metadata', fontWeight: 500 } }}>
          <summary>查看原始回答</summary>
          <Box sx={{ mt: 1, typography: 'reading' }}><MarkdownContent content={content} compact /></Box>
        </Box>
      </Paper>
    );
  }

  return (
    <Paper component="section" variant="outlined" sx={{ mt: 1, p: 1.5, bgcolor: 'action.selected', borderColor: 'primary.main' }} aria-label="结构化行动项">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="fieldTitle">行动项</Typography>
          <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>独立于研究稿保存，不会自动写入报告。</Typography>
        </Box>
        <Button type="button" variant="outline" size="xs" onClick={() => void copyItems()} aria-label="复制行动项">
          {copied ? <Check size={14} /> : <Clipboard size={14} />}
          {copied ? '已复制' : '复制'}
        </Button>
      </Stack>
      <Divider sx={{ my: 1.5 }} />
      <Stack spacing={1.25}>
        {items.map((item, index) => (
          <Paper component="article" variant="outlined" key={`${item.title}-${index}`} sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="metadata" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{String(index + 1).padStart(2, '0')}</Typography>
              <Typography variant="fieldTitle" component="h4" sx={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{item.title}</Typography>
              <Chip size="small" variant="outlined" label={item.priority ?? '待判断'} />
            </Stack>
            <Box component="dl" sx={{ mt: 1.5, mb: 0, display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' } }}>
              <ActionField label="负责人" value={item.owner} />
              <ActionField label="待验证假设" value={item.hypothesis} />
              <ActionField label="完成条件" value={item.completionCriteria} />
              <ActionField label="依据" value={item.basis} />
            </Box>
          </Paper>
        ))}
      </Stack>
      {copyError ? <Alert severity="error" role="alert" sx={{ mt: 1.5 }}>复制失败，请手动选择行动项文本。</Alert> : null}
    </Paper>
  );
}

function ActionField({ label, value }: { label: string; value: string | null }) {
  return (
    <Box component="div" sx={{ minWidth: 0, p: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}>
      <Typography variant="metadata" component="dt" color="text.secondary">{label}</Typography>
      <Typography variant="metadata" component="dd" sx={{ mt: 0.5, ml: 0, color: 'text.primary', overflowWrap: 'anywhere' }}>{value ?? '未明确'}</Typography>
    </Box>
  );
}
