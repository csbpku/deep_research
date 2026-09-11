export type DefaultRadarSource = {
  id: string;
  name: string;
  sourceType: string;
  config: Record<string, unknown>;
  enabled: boolean;
};

/**
 * Install-time radar defaults.
 *
 * IDs are stable so the bootstrap can be safely re-run. The bootstrap only
 * inserts missing rows; the database remains the authority for any source
 * that an administrator has already edited, disabled, or removed.
 */
export const DEFAULT_RADAR_SOURCES: readonly DefaultRadarSource[] = [
  {
    id: 'a0000000-0000-0000-0000-000000000001',
    name: 'GitHub Trending AI/ML',
    sourceType: 'github',
    config: {
      orgs: [],
      type: 'trending',
      repos: [
        'huggingface/transformers',
        'pytorch/pytorch',
        'langchain-ai/langchain',
        'ollama/ollama',
        'openai/openai-cookbook',
        'openai/codex',
        'anthropics/claude-code',
        'google-gemini/gemini-cli',
        'ggerganov/llama.cpp',
        'huggingface/diffusers',
        'run-llama/llama_index',
        'crewAIInc/crewAI',
        'All-Hands-AI/OpenHands',
        'vllm-project/vllm',
        'sgl-project/sglang',
      ],
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000002',
    name: 'Arxiv cs.AI / cs.CL / cs.LG',
    sourceType: 'arxiv',
    config: {
      categories: ['cs.AI', 'cs.CL', 'cs.LG'],
      maxResults: 30,
      lookbackHours: 168,
      maxCandidates: 30,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000003',
    name: 'Hacker News Frontpage',
    sourceType: 'rss',
    config: {
      feedUrl: 'https://hnrss.org/frontpage',
      maxResults: 20,
      maxAgeHours: 24,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000004',
    name: 'WeWe RSS 微信公众号',
    sourceType: 'rss',
    config: {
      feedUrl: 'http://localhost:4001/feeds/all.rss?limit=5',
      localPort: 4001,
      maxResults: 5,
      maxAgeHours: 24,
      applyAiFilter: false,
      allowLocalhost: true,
    },
    enabled: false,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000005',
    name: 'GitHub Curated Repositories',
    sourceType: 'github',
    config: {
      mode: 'repos',
      type: 'repos',
      pollingIntervalMinutes: 720,
      repos: [
        'anthropics/claude-code',
        'openai/codex',
        'google-gemini/gemini-cli',
        'Aider-AI/aider',
        'All-Hands-AI/OpenHands',
        'cline/cline',
        'block/goose',
        'continuedev/continue',
        'langchain-ai/langgraph',
        'The-Pocket/PocketFlow',
        'microsoft/autogen',
        'crewAIInc/crewAI',
        'vllm-project/vllm',
        'BerriAI/litellm',
        'ollama/ollama',
        'huggingface/transformers',
        'sgl-project/sglang',
        'langchain-ai/langchain',
        'run-llama/llama_index',
        'comfyanonymous/ComfyUI',
        'openai/gpt-oss',
        'meta-llama/llama-models',
        'moonshotai/Kimi-K3',
        'QwenLM/Qwen3',
        'deepseek-ai/DeepSeek-V3',
        'mistralai/mistral-inference',
        'ggerganov/llama.cpp',
        'unslothai/unsloth',
        'huggingface/diffusers',
        'huggingface/peft',
        'huggingface/trl',
        'meta-llama/llama-cookbook',
      ],
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000006',
    name: 'Reddit AI Communities',
    sourceType: 'reddit',
    config: {
      subreddits: ['programming', 'MachineLearning', 'LocalLLaMA'],
      max_age_hours: 24,
      max_per_subreddit: 10,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000007',
    name: 'Lobste.rs AI/ML',
    sourceType: 'lobsters',
    config: {
      max_results: 20,
      max_age_hours: 24,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000008',
    name: 'Dev.to AI',
    sourceType: 'devto',
    config: {
      tags: ['llm', 'openai', 'langchain'],
      max_results: 10,
      max_age_hours: 24,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000009',
    name: 'Hugging Face Trending Models',
    sourceType: 'huggingface_models',
    config: {
      sort: 'likes7d',
      max_results: 30,
      timeoutSeconds: 30,
      retries: 2,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000010',
    name: 'Anthropic Official News',
    sourceType: 'vendor_news',
    config: {
      vendor: 'anthropic',
      max_age_hours: 72,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000011',
    name: 'OpenAI Official News',
    sourceType: 'vendor_news',
    config: {
      vendor: 'openai',
      max_age_hours: 72,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000012',
    name: 'Hugging Face Daily Papers',
    sourceType: 'huggingface_papers',
    config: {
      maxResults: 20,
      maxAgeHours: 96,
      number_of_papers: 50,
      minKeywordOverlap: 0,
      timeoutSeconds: 30,
      retries: 2,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000013',
    name: 'OpenReview Accepted Papers',
    sourceType: 'openreview',
    config: {
      query: 'agent',
      venues: [
        'NeurIPS.cc/2025/Conference',
        'NeurIPS.cc/2024/Conference',
        'ICLR.cc/2025/Conference',
        'ICML.cc/2024/Conference',
      ],
      maxAgeDays: 400,
      maxResults: 40,
      limitPerVenue: 20,
    },
    enabled: false,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000014',
    name: 'Hacker News AI Stories (Algolia)',
    sourceType: 'hn_algolia',
    config: {
      query: 'AI OR LLM OR agent OR chatgpt OR claude OR gemini',
      maxResults: 30,
      maxAgeHours: 48,
      minPoints: 2,
      minComments: 0,
      tags: 'story',
    },
    enabled: false,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000015',
    name: 'Google DeepMind Blog',
    sourceType: 'vendor_news',
    config: {
      vendor: 'google_deepmind',
      max_age_hours: 72,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000016',
    name: 'xAI News',
    sourceType: 'vendor_news',
    config: {
      vendor: 'xai',
      max_age_hours: 96,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000017',
    name: 'Hugging Face Blog',
    sourceType: 'vendor_news',
    config: {
      vendor: 'huggingface_blog',
      max_age_hours: 96,
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000018',
    name: 'Reddit AI Communities (expanded)',
    sourceType: 'reddit',
    config: {
      subreddits: [
        'programming',
        'MachineLearning',
        'LocalLLaMA',
        'singularity',
        'ChatGPT',
        'StableDiffusion',
      ],
      max_age_hours: 24,
      max_per_subreddit: 10,
    },
    enabled: false,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000019',
    name: 'OpenAI Changelog',
    sourceType: 'vendor_changelog',
    config: {
      vendor: 'openai',
      sources: ['https://developers.openai.com/api/docs/changelog'],
      max_entries: 30,
      title_pattern: '<h2[^>]*>(.*?)</h2>',
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000020',
    name: 'Anthropic Release Notes',
    sourceType: 'vendor_changelog',
    config: {
      vendor: 'anthropic',
      sources: ['https://platform.claude.com/docs/en/release-notes/feed.xml'],
      max_entries: 30,
      allow_path_regex: '/release-notes/',
    },
    enabled: true,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000021',
    name: 'Product Hunt AI Tools',
    sourceType: 'producthunt',
    config: {
      fetch_count: 60,
      max_results: 20,
      max_age_hours: 48,
    },
    enabled: false,
  },
  {
    id: 'a0000000-0000-0000-0000-000000000022',
    name: '量子位 (QbitAI)',
    sourceType: 'rss',
    config: {
      feedUrl: 'https://www.qbitai.com/feed',
      maxResults: 10,
      maxAgeHours: 72,
      // QbitAI is already an AI-only editorial feed. A second keyword gate
      // drops valid stories such as world-model and AI-conference coverage.
      applyAiFilter: false,
    },
    enabled: true,
  },
];
