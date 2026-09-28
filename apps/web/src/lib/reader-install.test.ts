import { describe, expect, it } from 'vitest';
import { getReaderInstallDownloadState } from './reader-install';

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
