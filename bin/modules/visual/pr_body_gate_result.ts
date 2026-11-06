export type GateResult = {
  state: "rewritten" | "explicit_no_image" | "blocked" | "update_failed";
  phase: "phase-a" | "phase-b";
  pr_number: number;
  target_sha: string;
  target_ref: string;
  target_ref_kind: "branch" | "commit";
  selected_images: string[];
  output_images: string[];
  reasons: string[];
  base_repo: string;
  publish_repo: string;
  body_changed: boolean;
  rewritten_body?: string;
};

export function exitCodeForGateState(state: GateResult["state"]): number {
  if (state === "rewritten" || state === "explicit_no_image") return 0;
  if (state === "blocked") return 20;
  return 30;
}
