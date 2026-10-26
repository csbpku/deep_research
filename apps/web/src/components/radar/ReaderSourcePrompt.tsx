'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { READER_STORE_URL, safeReaderReturnUrl } from '@/lib/reader-install';

export function ReaderSourcePrompt({ open, onClose, readerUrl }: {
  open: boolean;
  onClose: () => void;
  readerUrl: string;
}) {
  const [storeOpened, setStoreOpened] = useState(false);
  const sourceHref = safeReaderReturnUrl(readerUrl);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="是否已安装 Reader？"
      description={!sourceHref
        ? '扩展商店会在新标签页打开。安装后，打开一篇文章并点击浏览器工具栏中的 Reader。'
        : storeOpened
        ? '安装完成后，回到此窗口打开原文；若未看到侧栏，点击浏览器工具栏中的 Reader。'
        : '扩展商店会在新标签页打开。安装后回到此窗口，即可继续打开这篇原文。'}
      actions={(
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'flex-end', gap: 1, width: '100%' }}>
          <AppButton
            component="a" href={READER_STORE_URL} target="_blank" rel="noopener noreferrer"
            variant="outlined" color="inherit" onClick={() => setStoreOpened(true)} sx={{ minHeight: 44 }}
          >
            {storeOpened ? '重新打开扩展商店' : '未安装，前往商店'}
          </AppButton>
          {/* Reader may intercept only this explicit confirmation, never the prompt trigger. */}
          {sourceHref ? (
            <AppButton
              component="a" href={sourceHref} target="_blank" rel="noopener noreferrer"
              variant="contained" data-reader-launch-source={sourceHref} sx={{ minHeight: 44 }}
            >
              {storeOpened ? '安装完成，打开原文' : '已安装，打开原文'}
            </AppButton>
          ) : null}
        </Box>
      )}
    />
  );
}
