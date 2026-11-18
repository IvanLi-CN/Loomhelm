import { FlowError } from "./common";
import { DIRECT_REVIEW_PROFILES } from "./review";

export interface DirectWaveLaneProfileOptions {
  repoPath: string;
  headSha: string;
  baseSha: string;
  waveId: string;
  lane: string;
  reviewProfile: string;
  declaredModel: string;
  declaredEffort: string;
}

export function directWaveLaneProfileAuthorized(
  _ledger: Record<string, unknown>,
  options: DirectWaveLaneProfileOptions,
): boolean {
  return DIRECT_REVIEW_PROFILES.has(
    `${options.declaredModel}:${options.declaredEffort}`,
  );
}

export function assertDirectProfile(profile: string, role: string): void {
  if (!DIRECT_REVIEW_PROFILES.has(profile))
    throw new FlowError(`${role} review profile is not directly executable`);
}
