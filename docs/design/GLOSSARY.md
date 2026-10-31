# Loomhelm workspace design

Design vocabulary for the shared desktop and mobile workspace. Product meanings and rules belong to the [product requirements](../PRD.md); established engineering definitions belong to the [core specification](../specs/phase1-core/SPEC.md).

## Language

**Workbench (工作台)**: The default global workspace spanning projects and their conversations, pending decisions and exceptions.

_Avoid_: Project workbench when referring to the cross-project entry.

**Global tasks (全局任务)**: The cross-project view of tasks and their goals, progress and associated conversation state.

_Avoid_: Labeling one selected project's task list as the global Tasks entry.

**Conversations (对话)**: The navigation group listing conversations without a project; a conversation is the user-facing name for a Codex session. Project-associated conversations appear under their project.

_Avoid_: Treating conversations as an additional kind of session or as a host-management surface.

**Standalone conversation (独立对话)**: A conversation that is not associated with a task and may also have no project. It can later become a task's main conversation without losing its identity or existing context.

_Avoid_: Treating every conversation as requiring a task or a project at creation.

**Project workspace (项目工作区)**: A workspace scoped to one selected project's tasks and conversations.

_Avoid_: Global workbench when referring to a single project's context, or Projects and tasks as a label for one selected project's task list.

**Project navigation tree (项目导航树)**: The navigation hierarchy from the Projects root to named projects and then directly to their conversations, with task-associated and standalone conversations both included.

_Avoid_: Inserting a task level between a project and its conversations, or treating projectless conversations as a named project.

**Task view (任务视图)**: A list, board or graph presentation of the same tasks; changing the view does not change a task's identity or business state.

_Avoid_: Treating a list item and board card as separate tasks.

**Task graph (任务图谱)**: A view combining task hierarchy and prerequisite dependencies, both of which may cross projects while each task retains its own project.

_Avoid_: Treating containment and dependency as the same relationship, assuming a parent and child share a project, or native sub-agent activity as task hierarchy.

**Desktop/mobile feature parity (桌面与手机功能一致)**: Availability of the same product capabilities on desktop and mobile, with interaction and layout suited to each device.

_Avoid_: Mobile companion when referring to the complete mobile workspace.

**Attention item (待介入事项)**: Work requiring an explicit user decision or manual handling, such as a pending approval or an exception requiring intervention.

_Avoid_: Activity or running session as a synonym; execution alone does not imply a need for human intervention.

**Multi-device continuity (多端连续工作)**: One owner's concurrent clients participating in the same live workspace, sharing task, session and submitted-operation state while each remains able to continue authorized work.

_Avoid_: Device takeover as a name for ordinary movement between the owner's Web/PWA clients.

**Shared session draft (会话共享草稿)**: The private unsent conversation input shared across the creating user's own authorized clients, including after conversation history joins a project.

_Avoid_: Queued message or pending command for text the owner has not explicitly submitted.

**Task session (任务主会话)**: The sole Codex session directly associated with a task, containing its main working conversation and the context for delegated sub-agent work; that session belongs to at most one task and the binding stays fixed in phase one.

_Avoid_: Separate implementation, review and research sessions attached to the same task.

**Task workspace (任务工作区)**: The working surface combining a task's main session with its goals and business state.

_Avoid_: Using task workspace to mean only the conversation or only the task metadata.

**Sub-agent (子代理)**: A delegated participant doing bounded work for the task session, such as code review or research.

_Avoid_: Treating each sub-agent as another directly associated task session.

**Conversation file (对话文件)**: A file referenced or produced within a conversation, understood in the context of the associated messages and work.

_Avoid_: Artifacts module as a user-facing category for these files.
