/** Configuration projection, independent of runtime activity and delivery policy. */
export function deriveExecutionPolicy(owner: unknown, conversation: unknown) {
  const owners = [null, "main", "delivery_agent", "task_agent"];
  const conversations = [null, "main_owned", "delivery_owned", "task_agent", "none"];
  if (
    !owners.some((value) => value === owner) ||
    !conversations.some((value) => value === conversation)
  )
    return { state: "unknown", label: "归属待确认", reason: "字段缺失或枚举未知" } as const;
  if (owner === null && conversation === null)
    return { state: "undeclared", label: "未声明", reason: "执行归属与对话策略尚未声明" } as const;
  if (owner === null || conversation === null)
    return { state: "incomplete", label: "声明不完整", reason: "两个字段必须同时声明" } as const;
  const policies = {
    main: ["main_owned", "Main Agent"],
    delivery_agent: ["delivery_owned", "交付 Agent"],
    task_agent: ["task_agent", "Task Agent"],
  } as const;
  const entry = policies[owner as keyof typeof policies];
  if (entry?.[0] === conversation)
    return { state: owner as keyof typeof policies, label: entry[1], reason: "" } as const;
  return { state: "conflict", label: "归属冲突", reason: "执行归属与对话策略不匹配" } as const;
}
