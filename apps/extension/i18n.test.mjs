import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeLocale, resolveUiLanguage, setUiLanguage, t, localizedMarkup } from './i18n.js';

test('interface locale follows the browser with a persistent explicit override', async () => {
  let saved = {};
  globalThis.chrome = { storage: { local: { get: async () => saved, set: async value => { saved = { ...saved, ...value }; } } } };
  assert.equal(resolveUiLanguage('zh-TW'), 'zh-CN');
  assert.equal(resolveUiLanguage('fr-FR'), 'en');
  await setUiLanguage('en');
  await initializeLocale();
  assert.equal(t('聊天'), 'Chat');
  assert.equal(t('部分模型引用无法在当前原文中精确找到，已隐藏。'), 'Some model citations could not be found exactly in the source and were hidden.');
  assert.equal(t('本轮没有可核对的原文证据。'), 'No verifiable source evidence was found for this response.');
  assert.equal(t('{0} 条消息', 12), '12 messages');
  assert.equal(localizedMarkup('<button title="停止回答">停止回答</button>'), '<button title="Stop response">Stop response</button>');
  assert.equal(t('Untranslated user text stays intact'), 'Untranslated user text stays intact');
  await setUiLanguage('zh-CN');
  await initializeLocale();
  assert.equal(t('聊天'), '聊天');
  assert.equal(t('{0} 条消息', 12), '12 条消息');
  delete globalThis.chrome;
});
