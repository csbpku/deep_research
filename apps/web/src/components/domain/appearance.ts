/** Domain meanings stay independent even when they share a base palette. */
export const domainPalettes = {
  neutral: ['text-secondary', 'surface-container'],
  evidence: ['evidence', 'evidence-container'],
  success: ['success', 'success-container'],
  warning: ['warning', 'warning-container'],
  danger: ['danger', 'danger-container'],
  inference: ['inference', 'inference-container'],
  context: ['background-context', 'background-container'],
} as const;

export type DomainPalette = keyof typeof domainPalettes;

export function domainAppearance(palette: DomainPalette) {
  const [foreground, background] = domainPalettes[palette];
  return { color: `var(--dr-color-${foreground})`, backgroundColor: `var(--dr-color-${background})` };
}
