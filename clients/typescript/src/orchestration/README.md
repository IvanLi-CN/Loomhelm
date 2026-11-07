# 旧简化任务图的处置

正式任务流由根 `skills/multi-task-flow/` 的原始合同驱动。旧 `TaskGraph`、`TaskOrchestrator` 不再导出或执行；旧 `tasks.json`、`orchestration.json` 保留原处，不自动转换、恢复或删除。旧 CLI 参数返回明确兼容错误，需使用原 Multi-task Flow JSON 请求。
