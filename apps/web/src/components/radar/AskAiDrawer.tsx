'use client';

// AI followup discussion workspace — a wide reading + discussion surface
// anchored to a radar candidate / summary. Uses the Sheet primitive for
// focus management, two-column on desktop. After M7 extraction, the chat
// surface itself lives in `ChatPanel.tsx` and the session lifecycle in
// `useChatSession.ts`.

import { useState } from 'react';
import {
  ExternalLink,
  FileText,
  Sparkles,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
} from '@/components/ui/sheet';
import MarkdownContent from '@/components/MarkdownContent';
import { ChatPanel } from './ChatPanel';
import { useChatSession } from './useChatSession';

interface Props {
  summaryId: string;
  summaryTitle: string;
  summaryUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contextExcerpt?: string | null;
}

export function AskAiDrawer({
  summaryId,
  summaryTitle,
  summaryUrl,
  open,
  onOpenChange,
  contextExcerpt = null,
}: Props) {
  const [contextExpanded, setContextExpanded] = useState(false);
  const chat = useChatSession({ summaryId, enabled: open });

  function close() {
    onOpenChange(false);
    setTimeout(() => {
      setContextExpanded(false);
    }, 300);
  }

  const readingContent = contextExcerpt ?? '';
  const visibleReadingContent = readingContent;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        overlayClassName="bg-foreground/15 backdrop-blur-0"
        hideClose
        className="gap-0 overflow-hidden p-0 sm:max-w-none lg:left-1/2 lg:right-auto lg:w-[min(1120px,calc(100vw-32px))] lg:-translate-x-1/2 lg:flex-row"
      >
        {/* Desktop reading pane: the article remains visible while discussing. */}
        <div className="hidden min-h-0 min-w-0 flex-1 flex-col bg-background lg:flex">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">正文阅读</span>
            </div>
            <Button asChild variant="link" size="xs" className="h-auto shrink-0 p-0">
              <a href={summaryUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3" />
                新窗口打开
              </a>
            </Button>
          </div>
          <article className="min-h-0 flex-1 overflow-y-auto px-6 py-7">
            <h2 className="text-xl font-semibold leading-tight tracking-normal">{summaryTitle}</h2>
            <MarkdownContent
              content={visibleReadingContent || '暂无正文内容。'}
              className="mt-5 text-[15px] leading-8"
            />
            <p className="mt-5 rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {'想查看完整正文或网页排版？'}
              <a
                className="ml-1 font-medium text-primary hover:underline"
                href={summaryUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read more · 继续阅读原文
              </a>
            </p>
          </article>
          <p className="shrink-0 border-t border-border px-6 py-2 text-[11px] leading-5 text-muted-foreground">
            当前显示平台提取并清洗后的正文；原文网页请使用右上角新窗口打开。
          </p>
        </div>

        {/* AI pane */}
        <div className="flex min-h-0 w-full flex-1 flex-col bg-card lg:w-[430px] lg:flex-none lg:border-l lg:border-border">
          <SheetHeader className="flex-row items-center justify-between gap-3 pr-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Sparkles className="size-4 shrink-0 text-method-ai" aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-semibold">与 AI 讨论</div>
                <div className="truncate text-[11px] text-muted-foreground" title={summaryTitle}>
                  基于当前雷达条目
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button asChild variant="link" size="xs" className="h-auto p-0 text-method-ai lg:hidden">
                <a href={summaryUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3" />
                  看原文
                </a>
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={close} aria-label="关闭">
                <X className="size-4" />
              </Button>
            </div>
          </SheetHeader>

          <ChatPanel
            messages={chat.session?.messages ?? []}
            loading={chat.loading}
            sending={chat.sending}
            thinkingStep={chat.thinkingStep}
            err={chat.err}
            input={chat.input}
            onInputChange={chat.setInput}
            onSubmit={chat.sendMessage}
            onRetryLoad={chat.retryLoad}
            messagesRef={chat.messagesRef}
            textareaRef={chat.textareaRef}
            contextExcerpt={readingContent}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default AskAiDrawer;
