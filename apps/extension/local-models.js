// Loopback model services a reader may already be running. Detection is a
// convenience, never a default: it runs only after an explicit user action
// that also grants the loopback host permission, and it never sends article
// text or credentials.
export const LOCAL_MODEL_CANDIDATES = Object.freeze([
  { id: 'ollama', label: 'Ollama', providerKind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lm-studio', label: 'LM Studio', providerKind: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'local-proxy', label: '本地 API 代理', providerKind: 'local-proxy', baseUrl: 'http://127.0.0.1:8317/v1' },
]);

// Ollama exposes embedding and audio models through the same /v1/models list.
// They can be discovered but cannot answer a reading question, so the default
// choice skips them instead of saving a configuration that fails on first use.
const NON_CHAT_MODEL = /(?:^|[-_/])(?:embed|embedding|bge|nomic|whisper|tts|dall-e|moderation|rerank)|(?:^|[-_/])(?:text-embedding|all-minilm|mxbai-embed)/iu;

export function pickLocalChatModel(models = []) {
  const ids = models
    .map((model) => (typeof model === 'string' ? model : model?.id))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  return ids.find((id) => !NON_CHAT_MODEL.test(id)) || ids[0] || '';
}

/**
 * Probe every known loopback endpoint concurrently and keep the reachable
 * ones. `probe(baseUrl)` resolves to a model list; any rejection (offline
 * service, wrong port, unsupported API) removes that candidate.
 */
export async function detectLocalModels(probe, { candidates = LOCAL_MODEL_CANDIDATES } = {}) {
  const settled = await Promise.all(candidates.map(async (candidate) => {
    try {
      const models = await probe(candidate.baseUrl, candidate);
      const list = (Array.isArray(models) ? models : [])
        .map((model) => (typeof model === 'string' ? model : model?.id))
        .filter((id) => typeof id === 'string' && id.trim());
      if (!list.length) return null;
      return { ...candidate, models: list.slice(0, 200), model: pickLocalChatModel(list), count: list.length };
    } catch {
      return null;
    }
  }));
  return settled.filter(Boolean);
}
