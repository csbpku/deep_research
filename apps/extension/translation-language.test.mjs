import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranslationLanguage, resolveTranslationLanguage } from './translation-language.js';
import { readerStore } from './reader-store.js';

test('translation defaults to interface language, explicit target survives interface changes', async () => {
  assert.equal(resolveTranslationLanguage(undefined, 'en'), 'en');
  assert.equal(resolveTranslationLanguage('interface', 'zh-CN'), 'zh-CN');
  for (const ui of ['en', 'zh-CN']) assert.equal(resolveTranslationLanguage('ja', ui), 'ja');
  assert.equal(normalizeTranslationLanguage('untrusted prompt'), 'interface');
  await readerStore.setSetting('translationLanguage', 'en');
  assert.equal(resolveTranslationLanguage(await readerStore.getSetting('translationLanguage'), 'zh-CN'), 'en');
});
