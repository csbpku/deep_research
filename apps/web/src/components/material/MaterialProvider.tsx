'use client';

import React, { useEffect, type ReactNode } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { useTheme as useMode } from 'next-themes';
import { createTheme, ThemeProvider, useColorScheme } from '@mui/material/styles';
import { designThemeOptions } from '@deep-research/design-system/theme';

declare module '@mui/material/styles' {
  interface CssThemeVariables { enabled: true }
}

const light = designThemeOptions('light');
const dark = designThemeOptions('dark');
export const webMaterialTheme = createTheme({
  ...light,
  cssVariables: { colorSchemeSelector: '.%s' },
  colorSchemes: { light: { palette: light.palette }, dark: { palette: dark.palette } },
});

function ModeSubscription() {
  const { resolvedTheme } = useMode();
  const { setMode } = useColorScheme();
  useEffect(() => {
    if (resolvedTheme === 'light' || resolvedTheme === 'dark') setMode(resolvedTheme);
  }, [resolvedTheme, setMode]);
  return null;
}

/** next-themes owns .dark and persistence. MUI only subscribes, never writes either. */
export function MaterialProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={webMaterialTheme} storageManager={null} colorSchemeNode={null}>
      <ModeSubscription />
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
