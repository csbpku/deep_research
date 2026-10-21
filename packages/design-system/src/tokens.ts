import light from './tokens.json';
import darkOverrides from './dark.json';

export type DesignMode = 'light' | 'dark';
export type DesignTokens = typeof light;
export const tokens = light;
export const darkTokens: DesignTokens = { ...light, ...darkOverrides };
export const breakpoints = { xs: 0, sm: 640, md: 768, lg: 1024, xl: 1280 } as const;
export const space = {
  xs: light['space-1'], sm: light['space-2'], md: light['space-3'],
  lg: light['space-4'], xl: light['space-5'], section: light['space-6'], wide: light['space-8'],
} as const;
export function tokensFor(mode: DesignMode): DesignTokens {
  return mode === 'dark' ? darkTokens : tokens;
}
