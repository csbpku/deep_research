// Explicit capabilities, not a guess based on "OpenAI-compatible" transport.
// Keep aliases/snapshots bounded: an unknown model keeps its provider defaults.
// Sources and maintenance rules: docs/contracts/reader-model-requests.md.
export function reasoningCapability(model) {
  const id = String(model || '').toLowerCase();
  if (/^minimax-m3\.1(?:-flash)?$/u.test(id)) return { efforts: ['low', 'medium', 'high'], fast: 'low', family: 'minimax', completionTokenLimit: true };
  if (/^grok-4\.[567](?:-\d{8})?$/u.test(id)) return { efforts: ['low', 'medium', 'high'], fast: 'low', family: 'grok' };
  if (/^(?:deepseek-flash|deepseek-v4-pro)$/u.test(id)) return { efforts: ['low', 'high'], fast: 'low', family: 'deepseek' };
  if (/^gemini-(?:2\.5-(?:pro|flash|flash-lite)|3-flash(?:-preview)?|3\.1-(?:pro|flash-lite)(?:-preview)?)$/u.test(id)) {
    return { efforts: ['low', 'high'], fast: 'low', family: 'gemini' };
  }
  if (/^(?:o1|o3(?:-mini)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/u.test(id)
    || /^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/u.test(id)) {
    return { efforts: ['low', 'medium', 'high'], fast: 'low', family: 'openai', completionTokenLimit: true };
  }
  if (/^gpt-5\.(?:1|2|4)(?:-\d{4}-\d{2}-\d{2})?$/u.test(id)) {
    return { efforts: ['none', 'low', 'medium', 'high'], fast: 'none', family: 'openai', completionTokenLimit: true };
  }
  return null;
}

export function modelRequestPolicy(provider, options = {}) {
  const capability = reasoningCapability(options.model || provider?.model);
  // Anthropic effort is verified for MiniMax and DeepSeek here. Native Claude and
  // other Messages providers retain their existing request shape.
  const anthropic = ['anthropic', 'custom-anthropic'].includes(provider?.providerKind);
  if (!capability || (anthropic && !['minimax', 'deepseek'].includes(capability.family))) return { ...options };
  const mode = (['translation', 'image-translation'].includes(options.purpose) || options.action === 'translate') ? 'auto' : options.reasoningMode || 'auto';
  const requested = options.reasoningEffort || (mode === 'auto' ? capability.fast : mode);
  return {
    ...options,
    reasoningEffort: mode === 'provider' ? undefined : capability.efforts.includes(requested) ? requested
      : requested === 'medium' ? 'high' : capability.fast,
    completionTokenLimit: capability.completionTokenLimit || false,
    ...(options.purpose === 'image-translation' && !options.maxTokens ? { maxTokens: 12_000 } : {}),
    // OpenAI reasoning models reject custom temperature while thinking.
    omitTemperature: capability.family === 'openai',
  };
}
