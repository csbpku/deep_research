'use client';

import { createTheme, ThemeProvider } from '@mui/material/styles';
import { designThemeOptions } from '@deep-research/design-system/theme';
import '@deep-research/design-system/tokens.css';
import React, { type ReactNode } from 'react';

const theme = createTheme(designThemeOptions('light'));
/** The public documents also work when hosted outside the platform shell. */
export function ReaderPublicTheme({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
