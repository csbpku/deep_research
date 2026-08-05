// P1-B worker bridge.
//
// 设计：
//   - radar_submissions 不再走 ai-engine HTTP 端点；用 DB 共享队列
//     （与 ai_engine/job_runner/db_store.py 同模式）。
//   - Web 进程启动一个 setInterval loop，每 2s 抢一条 received/type_detected/
//     extracting/scoring 行；enrichment 复用 ai-engine 通过 SQL 直连
//     Postgres 的写入（详见 ai-engine P1-B worker 集成）。
//   - 本文件只放"唤起一次"的小工具；真正的循环放到 apps/web/src/lib/radar/
//     submissions/worker.ts（独立进程 / Node cron 启动）。
//
// 之所以这样切分：
//   - Web 进程不直接调 LLM；enrichment 仍由 ai-engine 持有。
//   - enqueueRadarSubmission 把"立刻有人看到这行"作为轻信号；
//     真正的处理由 ai-engine 端 P1-B worker 拉取并执行。

/**
 * 把一条 submission 标记为 extracting 并发出软信号。
 * 实际 enrichment 由 ai-engine P1-B worker 完成（详见
 * packages/ai-engine/ai_engine/radar/submission_worker.py）。
 */
export async function enqueueRadarSubmission(submissionId: string): Promise<void> {
  const { prisma } = await import('@/lib/db');
  // 状态推进到 type_detected（已在路由里设过）；这里再写一次确保 idempotent。
  await prisma.radarSubmission.update({
    where: { id: submissionId },
    data: { status: 'type_detected', attempts: { increment: 1 } },
  });
}
