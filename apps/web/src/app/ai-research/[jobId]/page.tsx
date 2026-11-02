import { redirect } from 'next/navigation';

// The research result lives in the chat workspace. Keep the old deep link as
// a compatibility redirect so bookmarks and notifications still resolve.
export default async function AiResearchJobRedirect({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  redirect(`/ai-research?job=${encodeURIComponent(jobId)}`);
}
