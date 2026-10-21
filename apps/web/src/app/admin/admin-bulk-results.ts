export interface AdminBulkItemResult {
  id: string;
  ok: boolean;
  message?: string;
}

export function summarizeAdminBulkResults(
  results: readonly AdminBulkItemResult[],
  actionLabel: string,
): { message: string; failedIds: string[] } {
  const failed = results.filter((result) => !result.ok);
  const succeeded = results.length - failed.length;
  if (failed.length === 0) {
    return { message: `${succeeded} 条内容已${actionLabel}`, failedIds: [] };
  }
  const reason = failed.find((result) => result.message)?.message;
  return {
    message: `批量${actionLabel}未全部完成：成功 ${succeeded} 条，失败 ${failed.length} 条。失败项已保留，可重试。${reason ? ` ${reason}` : ''}`,
    failedIds: failed.map((result) => result.id),
  };
}
