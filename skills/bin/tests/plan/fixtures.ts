export function threeBatchOverlapPlan(dependencySeparator: string): string {
  return `# Plan

## Flow Decision
- flow_type: wave-thread

## Task Orchestration
- batch:batch-a [parent-child] => target=main;depends_on=none;condition=true;acceptance=A1;observation_window=2026-12-31T00:00:00Z;parent_branch=main;child_pr=required;topology=sibling-prs;event_protocol=wave-thread/v2;release_policy=branch-preview
  - wave: 1
    - task:task-a1 [gpt-6-luna, max] => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A2;skill=$wave-thread-flow;title=First task;purpose=Shared surface producer;outputs=First output
  - wave: 2
    - task:task-a2 [gpt-5.6-luna, xhigh] => owned_surfaces=src/d;depends_on=${dependencySeparator}task-a1/integrated;condition=true;acceptance=A7;skill=$wave-thread-flow;title=Dependent task;purpose=Same-batch dependent task;outputs=Dependent output
- batch:batch-b [direct] => target=main;depends_on=batch:batch-c/merged,${dependencySeparator}batch:batch-a/merged;condition=true;acceptance=A3;observation_window=2026-12-31T00:00:00Z;parent_branch=main;child_pr=none;topology=direct-final-pr;event_protocol=wave-thread/v2;release_policy=branch-preview
  - wave: 1
    - task:task-b1 [gpt-5.6-luna, max] => owned_surfaces=src/a;depends_on=none;condition=true;acceptance=A4;skill=$wave-thread-flow;title=Second task;purpose=Shared surface consumer;outputs=Second output
- batch:batch-c [direct] => target=main;depends_on=none;condition=true;acceptance=A5;observation_window=2026-12-31T00:00:00Z;parent_branch=main;child_pr=none;topology=direct-final-pr;event_protocol=wave-thread/v2;release_policy=branch-preview
  - wave: 1
    - task:task-c1 [gpt-6-luna, max] => owned_surfaces=src/c;depends_on=none;condition=true;acceptance=A6;skill=$wave-thread-flow;title=Independent task;purpose=Independent surface;outputs=Independent output

## Acceptance & Validation
- A1 [contract/direct] batch A | scope=\`batch:batch-a\` | phase=\`pre_merge\` | evidence=\`test:batch-a\` | assertions=\`batch A is valid\`
- A2 [behavior/direct] task A | scope=\`task:task-a1\` | phase=\`pre_merge\` | evidence=\`test:task-a1\` | assertions=\`task A is valid\`
- A3 [contract/direct] batch B | scope=\`batch:batch-b\` | phase=\`pre_merge\` | evidence=\`test:batch-b\` | assertions=\`batch B is valid\`
- A4 [behavior/direct] task B | scope=\`task:task-b1\` | phase=\`pre_merge\` | evidence=\`test:task-b1\` | assertions=\`task B is valid\`
- A5 [contract/direct] batch C | scope=\`batch:batch-c\` | phase=\`pre_merge\` | evidence=\`test:batch-c\` | assertions=\`batch C is valid\`
- A6 [behavior/direct] task C | scope=\`task:task-c1\` | phase=\`pre_merge\` | evidence=\`test:task-c1\` | assertions=\`task C is valid\`
- A7 [behavior/direct] task A2 | scope=\`task:task-a2\` | phase=\`pre_merge\` | evidence=\`test:task-a2\` | assertions=\`task A2 is valid\`
`;
}
