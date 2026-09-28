export function getReaderInstallDownloadState(input: {
  signedIn: boolean;
  betaPath: string;
  betaUrl: string;
}): { available: boolean; action: 'download' | 'signin' | 'unavailable' } {
  const available = Boolean(input.betaPath || input.betaUrl);

  if (!available) return { available, action: 'unavailable' };
  return { available, action: input.signedIn ? 'download' : 'signin' };
}
