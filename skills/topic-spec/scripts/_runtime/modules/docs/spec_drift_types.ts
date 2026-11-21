export interface DriftPathContext {
  repoRoot: string;
  baseRef: string;
  changedFiles: string[];
  deletedFiles: string[];
  renamePairs: RenamePair[];
}

export interface RenamePair {
  oldPath: string;
  newPath: string;
}

export interface RelatedAdrResult {
  ok: boolean;
  paths: string[];
  error?: string;
}

export interface DriftResult {
  exitCode: 0 | 2 | 3;
  status: "通过" | "阻断" | "未检查";
  drift: "不存在" | "存在" | "未检查";
  evidence: string;
  reason: string;
  stdout: string;
}
