import { describe, expect, it } from 'vitest';

import { AdminTopicProposalReviewInput } from '@/lib/schemas';
import { topicProposalReviewPayload } from './topic-proposal-review';

describe('topicProposalReviewPayload', () => {
  it('drops the route id from the strict review body', () => {
    const payload = topicProposalReviewPayload({
      id: '3a9c1d29-284d-48b0-bd3e-b68b6e6f0b35',
      action: 'approve',
      name: 'MCP 服务器可靠性风险',
      proposition: 'MCP 服务器在 Agent 调用链中的可靠性风险正在累积。',
      includedSummaryIds: [
        '43c294d6-950d-4cf3-95b9-cd90144fe2e5',
        'd055d3db-9e19-4f7c-95f3-edb802fb340b',
        'fbb82059-4137-4d90-9c09-d68cb27f46e8',
      ],
    });

    expect(payload).not.toHaveProperty('id');
    expect(AdminTopicProposalReviewInput.safeParse(payload).success).toBe(true);
  });
});
