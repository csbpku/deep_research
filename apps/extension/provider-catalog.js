export const PROVIDER_GROUPS = Object.freeze([
  { id: 'cloud', label: '云端服务商' },
  { id: 'local', label: '本机服务' },
  { id: 'custom', label: '自定义接口' },
]);

export const PROVIDER_CATALOG = Object.freeze([
  { id: 'openai', label: 'OpenAI', subtitle: 'GPT', aliases: 'ChatGPT', group: 'cloud', icon: 'openai.svg', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', subtitle: 'Claude', aliases: '克劳德', group: 'cloud', icon: 'claude-color.svg', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', label: 'Google Gemini', subtitle: 'Google AI', aliases: '谷歌', group: 'cloud', icon: 'gemini-color.svg', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'deepseek', label: 'DeepSeek', subtitle: '深度求索', aliases: '', group: 'cloud', icon: 'deepseek-color.svg', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Kimi', subtitle: '月之暗面', aliases: 'Moonshot', group: 'cloud', icon: 'kimi-color.svg', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'qwen', label: '阿里云百炼', subtitle: 'Qwen', aliases: '通义千问 DashScope Alibaba', group: 'cloud', icon: 'qwen-color.svg', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'minimax', label: 'MiniMax', subtitle: '国内站', aliases: '海螺', group: 'cloud', icon: 'minimax-color.svg', protocol: 'openai', baseUrl: 'https://api.minimaxi.com/v1' },
  { id: 'minimax-global', label: 'MiniMax', subtitle: '国际站', aliases: 'Global', group: 'cloud', icon: 'minimax-color.svg', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1' },
  { id: 'zhipu', label: '智谱 GLM', subtitle: 'BigModel', aliases: 'Zhipu ChatGLM', group: 'cloud', icon: 'zhipu-color.svg', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'siliconflow', label: '硅基流动', subtitle: 'SiliconFlow', aliases: '', group: 'cloud', icon: 'siliconcloud-color.svg', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openrouter', label: 'OpenRouter', subtitle: '模型聚合服务', aliases: '', group: 'cloud', icon: 'openrouter.svg', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'groq', label: 'Groq', subtitle: 'GroqCloud', aliases: '', group: 'cloud', icon: 'groq.svg', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'xai', label: 'xAI', subtitle: 'Grok', aliases: '', group: 'cloud', icon: 'xai.svg', protocol: 'openai', baseUrl: 'https://api.x.ai/v1' },
  { id: 'volcengine', label: '火山方舟', subtitle: '豆包 · Ark', aliases: 'Doubao ByteDance Volcengine', group: 'cloud', icon: 'volcengine-color.svg', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'local-proxy', label: '本地 API', subtitle: 'CLIProxy 等', aliases: 'Local Proxy 本地代理 VibeProxy 自建', group: 'local', icon: 'local-api.svg', protocol: 'openai', baseUrl: 'http://127.0.0.1:8317/v1' },
  { id: 'lm-studio', label: 'LM Studio', subtitle: '本机模型服务', aliases: '本地', group: 'local', icon: 'lmstudio.svg', protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'ollama', label: 'Ollama', subtitle: '本机模型服务', aliases: '本地', group: 'local', icon: 'ollama.svg', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'custom', label: 'OpenAI 兼容', subtitle: '自定义地址', aliases: '其他 custom', group: 'custom', icon: 'custom-api.svg', protocol: 'openai', baseUrl: '' },
  { id: 'custom-anthropic', label: 'Anthropic 兼容', subtitle: '自定义地址', aliases: '其他 custom Claude', group: 'custom', icon: 'custom-api.svg', protocol: 'anthropic', baseUrl: '' },
].map(item => Object.freeze(item)));

export const PROVIDER_PRESETS = Object.freeze(Object.fromEntries(PROVIDER_CATALOG.map(item => [
  item.id,
  Object.freeze({ label: item.label, protocol: item.protocol, baseUrl: item.baseUrl, placeholder: '填写精确的模型 ID' }),
])));

export function findProvider(id) {
  return PROVIDER_CATALOG.find(item => item.id === id) || PROVIDER_CATALOG[0];
}

export function matchingProviders(query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return PROVIDER_CATALOG.filter(item => {
    const group = PROVIDER_GROUPS.find(group => group.id === item.group).label;
    const search = `${item.label} ${item.subtitle} ${item.aliases} ${group}`.toLocaleLowerCase();
    return words.every(word => search.includes(word));
  });
}
