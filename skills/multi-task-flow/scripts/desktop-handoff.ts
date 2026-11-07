import type { Ledger } from "./schema";

/** The formal task is returned to the coordinator, never passed to exec. */
export function desktopHandoff(ledger: Ledger, operationId: string, prompt: string) {
  const operation = ledger.operations.find(op => op.id === operationId)!;
  const groupTarget = operation.request.target_type === "group";
  const target = groupTarget ? ledger.groups.find(g => g.id === operation.target_id)! : ledger.tasks.find(t => t.id === operation.target_id)!;
  const owner = groupTarget ? target : ledger.groups.find(g => g.id === (target as Ledger["tasks"][number]).group_id)!;
  const repository = ledger.repository;
  const receipt = operation.request.creation_result as any;
  const evidence = receipt?.native_evidence;
  if (operation.status !== "succeeded" || !evidence || evidence.native_tool_name !== "codex exec") return null;
  return {
    thread_id: receipt.thread_id,
    next_action: "send_message_to_thread",
    formal_prompt: [
      `run_id: ${ledger.orchestration_id}; ${groupTarget ? "group" : "task"}_id: ${target.id}`,
      `Repository: ${repository.host}/${repository.owner}/${repository.name}; mainline: ${repository.target_branch}`,
      `Workspace: ${evidence.workspace_path}; owner thread: ${receipt.thread_id}; initial HEAD (not development baseline): ${evidence.initial_head}`,
      groupTarget
        ? `开工前 fetch 远程主干 ${repository.target_branch}，核验配置的远端确属此仓库，固定实际 SHA 和真实 fetched_at；fetch 失败必须阻塞，不能使用缓存 HEAD。`
        : `开发基线必须是组 ${owner.id} 父分支 ${(owner as Ledger["groups"][number]).parent_branch} 的已核验 SHA ${(owner as Ledger["groups"][number]).current_sha}；先向账本核对最新值，不能自行改用主干。`,
      "先核验当前 CODEX_THREAD_ID、Codex 工作区归属元数据和干净状态。只在本次新建且归属自己的干净工作区对齐基线并建立工作分支；有改动、身份不明或基线获取失败必须报告阻塞，不能覆盖或清理。",
      "向主对话提供资源证据，由主对话通过现有 resource-update 注册资源，再由你调用 lifecycle-record workspace_ready，baseline 必须包含 sha、head、clean:true、source，组还须有 fetched_at；初始 HEAD 保留在创建证据。门禁通过后才可进入 running。",
      groupTarget ? "遵守本组范围和验收合同。" : `Owned surfaces: ${JSON.stringify((target as Ledger["tasks"][number]).owned_surfaces)}`,
      "你不是独自工作，保留其他 Agent 的改动。以下为正式任务及验收要求：",
      prompt,
    ].join("\n\n"),
  };
}
