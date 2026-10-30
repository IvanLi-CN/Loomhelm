import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Approval } from "@loomhelm/protocol";

export type ApprovalHistoryClient = Pick<GeneratedApiClient, "listRunApprovals">;

export interface ApprovalHistoryReadOptions {
  forceRefresh?: boolean;
  shouldContinue?: () => boolean;
}

interface CachedApprovalHistory {
  approvals: readonly Approval[];
  resumeCursor?: string;
}

function approvalKey(approval: Approval): string {
  return `${approval.id}:${approval.revision}`;
}

function isCursorExpiredError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  const body = error.body && typeof error.body === "object" ? error.body as { code?: unknown } : undefined;
  return body?.code === "cursor_expired";
}

export class ApprovalHistoryClientAdapter {
  private readonly cachedHistory = new Map<string, CachedApprovalHistory>();

  constructor(private readonly client: ApprovalHistoryClient) {}

  clear(runId?: string): void {
    if (runId === undefined) this.cachedHistory.clear();
    else this.cachedHistory.delete(runId);
  }

  async readApprovals(runId: string, { forceRefresh = false, shouldContinue = () => true }: ApprovalHistoryReadOptions = {}): Promise<readonly Approval[]> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) throw new Error("审批历史读取缺少 Run 身份");
    const cached = this.cachedHistory.get(normalizedRunId);
    try {
      return await this.readPages(normalizedRunId, cached, forceRefresh, shouldContinue);
    } catch (error) {
      if (!forceRefresh && isCursorExpiredError(error)) {
        this.cachedHistory.delete(normalizedRunId);
        return this.readApprovals(normalizedRunId, { forceRefresh: true, shouldContinue });
      }
      throw error;
    }
  }

  private async readPages(runId: string, cached: CachedApprovalHistory | undefined, forceRefresh: boolean, shouldContinue: () => boolean): Promise<readonly Approval[]> {
    const resumeCursor = forceRefresh ? undefined : cached?.resumeCursor;
    const approvalsByKey = new Map<string, Approval>(resumeCursor && cached ? cached.approvals.map((approval) => [approvalKey(approval), approval]) : []);
    const seenCursors = new Set<string>();
    let afterCursor: string | undefined = resumeCursor;

    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
      if (!shouldContinue()) return cached?.approvals ?? [];
      const page = await this.client.listRunApprovals({ run_id: runId, limit: 200, ...(afterCursor ? { after_cursor: afterCursor } : {}) });
      if (!shouldContinue()) return cached?.approvals ?? [];
      if (!Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("审批历史响应缺少分页字段");
      page.items.forEach((approval) => approvalsByKey.set(approvalKey(approval), approval));
      if (!page.has_more) {
        const approvals = [...approvalsByKey.values()];
        this.cachedHistory.set(runId, { approvals, resumeCursor: afterCursor });
        return approvals;
      }
      const nextCursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
      if (!nextCursor || !nextCursor.trim() || seenCursors.has(nextCursor)) throw new Error("审批历史分页游标未前进");
      seenCursors.add(nextCursor);
      afterCursor = nextCursor;
    }

    throw new Error("审批历史分页超过安全页数限制");
  }
}
