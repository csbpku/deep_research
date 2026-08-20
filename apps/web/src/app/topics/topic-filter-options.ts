export const TOPIC_FILTER_KEYS = ['all', 'hot', 'warming', 'emerging', 'followed'] as const;

export type TopicFilterKey = (typeof TOPIC_FILTER_KEYS)[number];

export function parseTopicFilter(value: string | null | undefined): TopicFilterKey {
  return TOPIC_FILTER_KEYS.find((key) => key === value) ?? 'all';
}
