# Loomhelm workspace design

Design vocabulary for the shared desktop and mobile workspace. Product entity definitions remain in the core specification.

## Language

**Global workbench (全局工作台)**: The default workspace spanning projects and their sessions, pending decisions and exceptions.

_Avoid_: Project workbench when referring to the cross-project entry.

**Project workbench (项目工作台)**: A workspace scoped to one project's tasks, sessions and execution results.

_Avoid_: Global workbench when referring to a single project's context.

**Desktop/mobile feature parity (桌面与手机功能一致)**: Availability of the same product capabilities on desktop and mobile, with interaction and layout suited to each device.

_Avoid_: Mobile companion when referring to the complete mobile workspace.

**Attention item (待介入事项)**: Work requiring an explicit user decision or manual handling, such as a pending approval or an exception requiring intervention.

_Avoid_: Activity or running session as a synonym; execution alone does not imply a need for human intervention.

**Multi-device continuity (多端连续工作)**: One owner's concurrent clients participating in the same live workspace, sharing task, session and submitted-operation state while each remains able to continue authorized work.

_Avoid_: Device takeover as a name for ordinary movement between the owner's Web/PWA clients.

**Shared session draft (会话共享草稿)**: The unsent conversation input associated with a session that the owner's clients can view and continue editing together.

_Avoid_: Queued message or pending command for text the owner has not explicitly submitted.

**Task session (任务主会话)**: The sole Codex session directly associated with a task, containing its main working conversation and the context for delegated sub-agent work.

_Avoid_: Separate implementation, review and research sessions attached to the same task.

**Task workspace (任务工作区)**: The working surface combining a task's main session with its goals and business state.

_Avoid_: Using task workspace to mean only the conversation or only the task metadata.

**Sub-agent (子代理)**: A delegated participant doing bounded work for the task session, such as code review or research.

_Avoid_: Treating each sub-agent as another directly associated task session.

**Conversation file (对话文件)**: A file referenced or produced within a conversation, understood in the context of the associated messages and work.

_Avoid_: Artifacts module as a user-facing category for these files.
