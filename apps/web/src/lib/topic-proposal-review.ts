export type TopicProposalReviewInput = {
  id: string;
  action: 'approve' | 'reject';
  name?: string;
  proposition?: string;
  includedSummaryIds?: string[];
  reason?: string;
};

export type TopicProposalReviewPayload = Omit<TopicProposalReviewInput, 'id'>;

/** Route 从 URL 读 proposal id，strict body 不应再携带 id。 */
export function topicProposalReviewPayload(input: TopicProposalReviewInput): TopicProposalReviewPayload {
  const { id: _proposalId, ...payload } = input;
  void _proposalId;
  return payload;
}
