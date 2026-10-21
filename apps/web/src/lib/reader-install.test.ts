import { describe, expect, it } from 'vitest';
import { getReaderInstallDownloadState, getReaderInstallHref, safeReaderReturnUrl, READER_STORE_URL } from './reader-install';

describe('getReaderInstallDownloadState', () => {
  it('does not ask users to sign in when no Beta artifact is configured', () => {
    expect(getReaderInstallDownloadState({ signedIn: false, betaPath: '', betaUrl: '' })).toEqual({
      available: false,
      action: 'unavailable',
    });
  });

  it('requires sign-in before offering a configured artifact to anonymous users', () => {
    expect(getReaderInstallDownloadState({
      signedIn: false,
      betaPath: '',
      betaUrl: 'https://downloads.example.test/reader.zip',
    })).toEqual({ available: true, action: 'signin' });
  });

  it('offers the download to signed-in users when an artifact is configured', () => {
    expect(getReaderInstallDownloadState({ signedIn: true, betaPath: '/artifacts/reader.zip', betaUrl: '' }))
      .toEqual({ available: true, action: 'download' });
  });
});

describe('Reader install return links', () => {
  it('keeps an HTTP(S) article URL available after installation', () => {
    const source = 'https://example.com/article?deep-research-source=radar&deep-research-summary=one';
    expect(getReaderInstallHref(source)).toBe(READER_STORE_URL);
    expect(safeReaderReturnUrl(source)).toBe(source);
  });

  it('does not create return links for non-web or credentialed URLs', () => {
    expect(getReaderInstallHref('javascript:alert(1)')).toBe(READER_STORE_URL);
    expect(safeReaderReturnUrl('https://user:pass@example.com/article')).toBeNull();
    expect(safeReaderReturnUrl('/radar')).toBeNull();
  });
});
