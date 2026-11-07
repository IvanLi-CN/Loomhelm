import type { Finding } from "./replay";

export interface StashPush {
  line: number;
  callId: string | undefined;
  untracked: boolean;
  effective: boolean;
}

export interface PendingCall {
  name: string;
  command: string;
  line: number;
  sessionId: number | undefined;
}

export type LatestPr = "exists" | "missing" | "merged" | undefined;

export interface TerminalState {
  findings: Finding[];
  parentFlow: string;
  parentLock: string;
  taskFlow: string;
  taskLock: string;
  fastTrackLine: number;
  latestPr: LatestPr;
  currentHeadLine: number;
  localProofLine: number;
  mergeIntentLine: number;
  cleanupLine: number;
  mergeCallLine: number;
  mergeSuccessLine: number;
  mergeGuarded: boolean;
  preflightSeen: boolean;
  preflightEligible: boolean;
  head: string;
  deletedLine: number;
  deleteBranchName: string;
  deleteExemptionLine: number;
  baseBlockLine: number;
  baseMenuLine: number;
  baseDecisionLine: number;
  safeAlignLine: number;
  safeAlignBackupLine: number;
  safeAlignRebaseLine: number;
  safeAlignStashLine: number;
  safeAlignUntracked: boolean;
  safeAlignStashApplyLine: number;
  safeAlignStashPopLine: number;
  pending: Map<string, PendingCall>;
  stashes: StashPush[];
  activeSessions: Set<number>;
  activeReviewSessions: Set<number>;
  activeProofLine: number;
  activeProofIntentLine: number;
  activeProofSessions: Set<number>;
  taskTurns: Map<string, string>;
  gateKey: string;
}

export function createTerminalState(): TerminalState {
  return {
    findings: [],
    parentFlow: "",
    parentLock: "",
    taskFlow: "",
    taskLock: "",
    fastTrackLine: 0,
    latestPr: undefined,
    currentHeadLine: 0,
    localProofLine: 0,
    mergeIntentLine: 0,
    cleanupLine: 0,
    mergeCallLine: 0,
    mergeSuccessLine: 0,
    mergeGuarded: false,
    preflightSeen: false,
    preflightEligible: false,
    head: "",
    deletedLine: 0,
    deleteBranchName: "",
    deleteExemptionLine: 0,
    baseBlockLine: 0,
    baseMenuLine: 0,
    baseDecisionLine: 0,
    safeAlignLine: 0,
    safeAlignBackupLine: 0,
    safeAlignRebaseLine: 0,
    safeAlignStashLine: 0,
    safeAlignUntracked: false,
    safeAlignStashApplyLine: 0,
    safeAlignStashPopLine: 0,
    pending: new Map(),
    stashes: [],
    activeSessions: new Set(),
    activeReviewSessions: new Set(),
    activeProofLine: 0,
    activeProofIntentLine: 0,
    activeProofSessions: new Set(),
    taskTurns: new Map(),
    gateKey: "",
  };
}

export function add(
  findings: Finding[],
  code: string,
  line: number,
  message: string,
): void {
  if (!findings.some((item) => item.code === code))
    findings.push({ code, line, message });
}
