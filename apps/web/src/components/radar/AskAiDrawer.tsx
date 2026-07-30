'use client';

// AI followup drawer — slide-in panel anchored to a radar candidate / summary.
// Posts to /api/chat/sessions + /api/chat/sessions/{id}/messages.
//
// Visual contract (mockup lines 485-606):
// - 480px right drawer, slide-in
// - Header: title, ↗ 看原文, ×
// - Context strip
// - 4 suggestion chips
// - Chat history (user/assistant bubbles)
// - Footer textarea + send button (⌘+Enter)

import { useEffect, useRef, useState } from 'react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  latencyMs?: number | null;
}

interface ChatSession {
  sessionId: string;
  status: string;
  seedSnapshot: {
    id: string;
    title: string;
    url: string;
    body: string;
    interpretation: string | null;
    summaryDate: string;
    tags: string[];
    // Phase 1 deep-dive: original source captured by radar sync. Null
    // for pre-Phase-0 rows.
    originalMarkdown: string | null;
    originalKind: string | null;
  };
  messages: ChatMessage[];
}

const SUGGESTIONS = [
  '这篇的核心观点是什么？',
  '和我们项目有什么关联？',
  '作者没提到什么？',
  '用 50 人的话能落地吗？',
];

interface Props {
  summaryId: string;
  summaryTitle: string;
  summaryUrl: string;
  summaryInterpretation: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function createAndLoadSession(summaryId: string): Promise<ChatSession> {
  const createRes = await fetch('/api/chat/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seedSummaryId: summaryId }),
  });
  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? '创建会话失败');
  }

  const createData = await createRes.json() as { sessionId: string };
  const getRes = await fetch(`/api/chat/sessions/${createData.sessionId}`, { cache: 'no-store' });
  if (!getRes.ok) {
    const body = await getRes.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? '加载历史失败');
  }
  return await getRes.json() as ChatSession;
}

export function AskAiDrawer({
  summaryId,
  summaryTitle,
  summaryUrl,
  summaryInterpretation,
  open,
  onOpenChange,
}: Props) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadRef = useRef<{ summaryId: string; promise: Promise<ChatSession> } | null>(null);

  useEffect(() => {
    if (!open || !summaryId) return;
    if (!loadRef.current || loadRef.current.summaryId !== summaryId) {
      loadRef.current = { summaryId, promise: createAndLoadSession(summaryId) };
    }

    let cancelled = false;
    setLoading(true);
    setErr(null);
    void loadRef.current.promise
      .then((sessionData) => {
        if (!cancelled) setSession(sessionData);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setErr(loadError instanceof Error ? loadError.message : '加载失败');
          loadRef.current = null;
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, summaryId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [session?.messages.length, sending]);

  function close() {
    onOpenChange(false);
    setTimeout(() => {
      loadRef.current = null;
      setSession(null);
      setInput('');
    }, 300);
  }

  async function sendMessage(content: string, anchor?: { quote: string; startOffset: number; endOffset: number } | null) {
    const trimmed = content.trim();
    if (!trimmed || !session || sending) return;
    setSending(true);
    setErr(null);
    const optimisticUserMsg: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    setSession({
      ...session,
      messages: [...session.messages, optimisticUserMsg],
    });
    setInput('');
    try {
      // Phase 3.b: attach anchor if user selected text before asking
      const body: Record<string, unknown> = { content: trimmed };
      if (anchor?.quote) {
        body.anchor = {
          quote: anchor.quote,
          startOffset: anchor.startOffset,
          endOffset: anchor.endOffset,
        };
      }
      const res = await fetch(`/api/chat/sessions/${session.sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? '发送失败');
      }
      const reply = (await res.json()) as ChatMessage;
      setSession((prev) =>
        prev ? { ...prev, messages: [...prev.messages, reply] } : prev
      );
    } catch (e2) {
      setErr(String((e2 as Error).message ?? '发送失败'));
      // Roll back optimistic user message
      setSession((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticUserMsg.id) }
          : prev
      );
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void sendMessage(input, null);
    }
  }

  return (
    <>
      <div
        aria-hidden={!open}
        onClick={close}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.3)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.3s ease',
          zIndex: 40,
        }}
      />
      <aside
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100%',
          width: '480px',
          maxWidth: '90vw',
          background: '#fff',
          boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.08)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s ease-out',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          borderLeft: '1px solid #e2e8f0',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderBottom: '1px solid #e2e8f0',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <span aria-hidden>📄</span>
            <span
              style={{
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 14,
              }}
              title={summaryTitle}
            >
              {summaryTitle}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <a
              href={summaryUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 12,
                padding: '4px 8px',
                color: '#7c3aed',
                textDecoration: 'none',
                borderRadius: 4,
              }}
            >
              ↗ 看原文
            </a>
            <button
              type="button"
              onClick={close}
              aria-label="关闭"
              style={{
                width: 28,
                height: 28,
                border: 'none',
                background: 'transparent',
                fontSize: 18,
                cursor: 'pointer',
                color: '#64748b',
                borderRadius: 4,
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Context strip */}
        <div
          style={{
            padding: '8px 20px',
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
            fontSize: 12,
            color: '#475569',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ color: '#7c3aed' }}>✨</span>
          <span>
            {session?.seedSnapshot.originalMarkdown
              ? 'AI 上下文：原文 + 解读 + 摘要'
              : 'AI 上下文：原文 + interpretation'}
          </span>
        </div>

        {/* Suggestion chips */}
        <div
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>💡 试试这些问题</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={sending || !session}
                onClick={() => void sendMessage(s, null)}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  background: '#f1f5f9',
                  border: 'none',
                  borderRadius: 12,
                  cursor: sending || !session ? 'not-allowed' : 'pointer',
                  color: '#334155',
                  opacity: sending || !session ? 0.6 : 1,
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div
          ref={messagesRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
            background: '#fff',
          }}
        >
          {loading ? (
            <div style={{ fontSize: 13, color: '#64748b', textAlign: 'center', padding: 16 }}>
              加载会话中…
            </div>
          ) : err ? (
            <div
              role="alert"
              style={{
                fontSize: 13,
                color: '#b91c1c',
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 4,
              }}
            >
              {err}
            </div>
          ) : (
            <>
              {session && session.messages.length === 0 ? (
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <div
                    aria-hidden
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: '#7c3aed',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    ✨
                  </div>
                  <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
                    我已读了原文和 AI 摘要。想了解什么？
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      可以引用文章中的具体段落，或直接发问。
                    </div>
                  </div>
                </div>
              ) : null}

              {(session?.messages ?? []).map((m) =>
                m.role === 'user' ? (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      gap: 12,
                      marginBottom: 8,
                      justifyContent: 'flex-end',
                    }}
                  >
                    <div
                      style={{
                        background: '#f1f5f9',
                        borderRadius: 16,
                        borderTopLeftRadius: 4,
                        padding: '8px 14px',
                        maxWidth: '78%',
                        fontSize: 13,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                    <div
                      aria-hidden
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: '#7c3aed',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        flexShrink: 0,
                      }}
                    >
                      ✨
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        flex: 1,
                      }}
                    >
                      {m.content}
                      {m.latencyMs ? (
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: '#94a3b8',
                            display: 'flex',
                            gap: 8,
                          }}
                        >
                          <span>{m.latencyMs < 1000 ? `${m.latencyMs}ms` : `${(m.latencyMs / 1000).toFixed(1)}s`}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              )}

              {sending ? (
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }} aria-live="polite">
                  <div
                    aria-hidden
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: '#7c3aed',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    ✨
                  </div>
                  <div style={{ fontSize: 13, color: '#64748b' }}>
                    AI 正在思考<span className="typing-cursor">▍</span>
                  </div>
                </div>
              ) : null}

              {summaryInterpretation && session && session.messages.length === 0 ? (
                <div
                  style={{
                    marginTop: 8,
                    padding: 10,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#475569',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {summaryInterpretation}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Input */}
        <div
          style={{
            borderTop: '1px solid #e2e8f0',
            padding: '12px 16px',
            background: '#fff',
          }}
        >
          <div
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: '8px',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => {
              const inner = e.currentTarget;
              inner.style.borderColor = '#7c3aed';
            }}
            onBlur={(e) => {
              const inner = e.currentTarget;
              inner.style.borderColor = '#e2e8f0';
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="提问… (⌘+Enter 发送)"
              rows={2}
              disabled={!session || sending}
              style={{
                width: '100%',
                fontSize: 13,
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontFamily: 'inherit',
                background: 'transparent',
                color: '#0f172a',
                boxSizing: 'border-box',
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 4,
              }}
            >
              <div style={{ display: 'flex', gap: 4, fontSize: 12, color: '#64748b' }}>
                <button
                  type="button"
                  aria-label="附加文件（未启用）"
                  disabled
                  style={{
                    padding: '2px 6px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'not-allowed',
                    color: '#94a3b8',
                  }}
                >
                  📎
                </button>
                <button
                  type="button"
                  aria-label="引用（未启用）"
                  disabled
                  style={{
                    padding: '2px 6px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'not-allowed',
                    color: '#94a3b8',
                  }}
                >
                  🔗 引用
                </button>
              </div>
              <button
                type="button"
                onClick={() => void sendMessage(input)}
                disabled={!input.trim() || !session || sending}
                style={{
                  fontSize: 12,
                  padding: '4px 12px',
                  background: !input.trim() || !session || sending ? '#94a3b8' : '#7c3aed',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: !input.trim() || !session || sending ? 'not-allowed' : 'pointer',
                }}
              >
                发送 ✨
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

export default AskAiDrawer;
