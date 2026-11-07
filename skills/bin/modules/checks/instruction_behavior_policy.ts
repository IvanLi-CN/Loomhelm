export type ReplayExpectation = {
  route: string;
  stop: string;
  confirmation: boolean;
  research: boolean;
  visual: boolean;
  forbidden: string[];
  allowed?: string[];
};

export type ReplayCase = {
  id: string;
  risk: boolean;
  scenario: string;
  expect: ReplayExpectation;
};

export const RELEVANT_SKILLS: Record<string, string[]> = {
  "normal-local": ["normal-flow", "project-engineering-workflow"],
  "fast-pr": ["fast-flow", "project-engineering-workflow"],
  "local-merge": ["local-merge-flow", "project-engineering-workflow"],
  "generic-continue": ["flow-continue"],
  "remote-change": ["git-remote-troubleshoot"],
  "ui-evidence": ["ui-visual-evidence"],
  "non-ui": ["project-engineering-workflow"],
  "latest-fact": [],
  "stable-local-fact": [],
  "legacy-migration": ["docs-migrate"],
  "fresh-thread-default": ["fresh-thread-dispatch"],
  "fresh-thread-local": ["fresh-thread-dispatch"],
  "fresh-thread-parent-continues": ["fresh-thread-dispatch"],
};

export const ROUTES = [
  "normal-flow",
  "fast-flow",
  "local-merge-flow",
  "flow-continue",
  "git-remote-troubleshoot",
  "ui-visual-evidence",
  "project-engineering-workflow",
  "research",
  "local-inspection",
  "docs-migrate",
  "fresh-thread-dispatch",
];

export const STOPS = [
  "local-can-open-pr",
  "step-5c-ready",
  "step-5l-ready",
  "resume-first-gate",
  "blocked-for-confirmation",
  "visual-evidence-gate",
  "next-applicable-gate",
  "research-before-answer",
  "answer",
  "migration-validation",
  "fresh-task-created",
  "parent-scope-continues",
];

export const FORBIDDEN = [
  "push",
  "create-pr",
  "merge-pr",
  "switch-flow",
  "change-remote",
  "change-upstream",
  "retired-skill",
  "fork-thread",
  "move-thread",
  "manual-worktree",
  "touch-child",
  "observe-child",
  "message-child",
  "relay-child",
  "child-work",
  "duplicate-dispatch",
];

export const USAGE = `usage: instruction_behavior_replay.ts [-h] [--repo-root REPO_ROOT]
                                      [--cases CASES] [--runs RUNS]
                                      --model MODEL [--live]
                                      [--baseline-results BASELINE_RESULTS]
                                      [--write-results WRITE_RESULTS]
                                      [--timeout TIMEOUT] [--case CASE_IDS]
                                      [--instructions-ref INSTRUCTIONS_REF]`;

export const HELP = `${USAGE}

Run structured live-model replays against observable instruction outcomes.

options:
  -h, --help            show this help message and exit
  --repo-root REPO_ROOT
  --cases CASES
  --runs RUNS
  --model MODEL
  --live                Required to spend model calls
  --baseline-results BASELINE_RESULTS
  --write-results WRITE_RESULTS
  --timeout TIMEOUT     Seconds allowed per model call
  --case CASE_IDS       Run only a named case
  --instructions-ref INSTRUCTIONS_REF
                        Read instruction files from this Git ref`;
