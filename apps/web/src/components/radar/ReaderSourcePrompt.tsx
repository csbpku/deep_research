'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { clearReaderInstall, rememberReaderInstall, READER_STORE_URL, safeReaderReturnUrl } from '@/lib/reader-install';

export function ReaderSourcePrompt({ open, onClose, readerUrl, sourceUrl, articleTitle }: {
  open: boolean; onClose: () => void; readerUrl: string; sourceUrl: string; articleTitle?: string;
}) {
  const [storeOpened, setStoreOpened] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [pendingSaved, setPendingSaved] = useState(true);
  const sourceHref = safeReaderReturnUrl(readerUrl);
  const originalHref = safeReaderReturnUrl(sourceUrl);

  useEffect(() => {
    if (!open || !storeOpened || resumed) return;
    const timer = window.setTimeout(() => setTimedOut(true), 30_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source === window && event.origin === window.location.origin
        && event.data?.type === 'deep-research:install-resumed') setResumed(true);
    };
    window.addEventListener('message', onMessage);
    return () => { window.clearTimeout(timer); window.removeEventListener('message', onMessage); };
  }, [open, storeOpened, resumed]);

  const close = () => { clearReaderInstall(); setStoreOpened(false); setTimedOut(false); setResumed(false); onClose(); };
  const openStore = () => {
    setPendingSaved(Boolean(sourceHref && rememberReaderInstall(sourceHref)));
    setStoreOpened(true); setTimedOut(false); setResumed(false);
  };

  return <AppDialog open={open} onClose={close} title={storeOpened ? '继续用 Reader 阅读' : '用 Reader 阅读这篇文章'}
    description={storeOpened
      ? '安装后会尝试继续打开这篇原文。若侧栏没有出现，请在原文页面点击浏览器工具栏中的 Reader。'
      : '安装或启用 Reader 后，可以在原网页中翻译、提问和保存摘录。安装完成后会尝试继续打开这篇原文。'}
    actions={<Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, width: '100%' }}>
      <AppButton component="a" href={READER_STORE_URL} target="_blank" rel="noopener noreferrer"
        variant={storeOpened ? 'outlined' : 'contained'} onClick={openStore} sx={{ minHeight: 44 }}>
        {storeOpened ? '重新打开扩展商店' : '前往 Chrome 扩展商店'}
      </AppButton>
      {storeOpened && sourceHref ? <AppButton component="a" href={sourceHref} target="_blank" rel="noopener noreferrer"
        variant="contained" data-reader-launch-source={sourceHref} onClick={close} sx={{ minHeight: 44 }}>
        我已安装，继续阅读
      </AppButton> : null}
      {originalHref ? <AppButton component="a" href={originalHref} target="_blank" rel="noopener noreferrer"
        variant="text" color="inherit" onClick={close} sx={{ minHeight: 44 }}>直接打开原文</AppButton> : null}
    </Box>}>
    {storeOpened ? <Typography role="status" variant="body2" color="text.secondary">
      {resumed ? '原文已打开；如未看到侧栏，请点击浏览器工具栏中的 Reader。'
        : !pendingSaved ? '浏览器未保存这次阅读请求。安装后请回到这里点击“我已安装，继续阅读”。'
        : timedOut ? '暂未检测到安装完成。你可以安装后点击“我已安装，继续阅读”。'
        : `正在等待安装${articleTitle ? `，完成后继续阅读《${articleTitle}》` : ''}…`}
    </Typography> : null}
  </AppDialog>;
}
