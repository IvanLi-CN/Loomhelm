import { ApiClientError } from "@loomhelm/api-client";
import type { DeploymentCandidate, DeploymentEvent, DeploymentStatus } from "@loomhelm/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";

import { DeploymentDashboard } from "./DeploymentConsole";

const now = "2026-10-31T08:00:00Z";
const candidate: DeploymentCandidate = {
  id: "7ad8fe8e4f1e3b36a7f3a0cf6b97d601e2a9dfc2e2b4f1d37a5b9ce0f2f3c451",
  source_sha: "7ad8fe8e4f1e3b36a7f3a0cf6b97d601e2a9dfc2",
  artifact_digest: "sha256:7ad8fe8e4f1e3b36a7f3a0cf6b97d601e2a9dfc2e2b4f1d37a5b9ce0f2f3c451",
  web_digest: "sha256:2e8f6b97d601e2a9dfc2e2b4f1d37a5b9ce0f2f3c4517ad8fe8e4f1e3b36a7f3a0cf6b97d601",
  state_version: 1,
  read_min: 1,
  read_max: 1,
  migration_mode: "none",
  status: "staged",
  created_at: now,
  updated_at: now
};

const baseStatus: DeploymentStatus = {
  active_slot: "blue",
  active_candidate_id: "2e8f6b97d601e2a9dfc2e2b4f1d37a5b9ce0f2f3c4517ad8fe8e4f1e3b36a7f3",
  active_fingerprint: "4f1d37a5b9ce0f2f3c4517ad8fe8e4f1e3b36a7f3a0cf6b97d601e2a9dfc2e2b4f1d37",
  next_worker_generation: 8,
  slots: [
    { slot: "blue", state: "active", candidate_id: "2e8f6b97d601e2a9dfc2e2b4f1d37a5b9ce0f2f3c4517ad8fe8e4f1e3b36a7f3", worker_generation: 7 },
    { slot: "green", state: "staged", candidate_id: candidate.id, worker_generation: 8 }
  ],
  role: "installation_owner",
  capabilities: ["view", "preflight", "stage", "promote", "rollback", "reconcile", "emergency_drain"],
  controller_ready: true
};

const events: DeploymentEvent[] = [
  { id: 4, operation_id: "deploy-5c4a", type: "stage_succeeded", candidate_id: candidate.id, slot: "green", created_at: now },
  { id: 3, operation_id: "deploy-5c4a", type: "stage_started", candidate_id: candidate.id, slot: "green", created_at: "2026-10-31T07:59:10Z" },
  { id: 2, operation_id: "deploy-0e91", type: "promote_succeeded", slot: "blue", created_at: "2026-10-30T18:20:00Z" }
];

const meta = {
  title: "Features/Deployment/DeploymentConsole",
  parameters: { layout: "fullscreen" }
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Frame(props: ComponentProps<typeof DeploymentDashboard>) {
  return <div className="min-h-screen bg-[var(--canvas)] p-12" data-visual-evidence-surface><div data-visual-evidence-target><DeploymentDashboard {...props} /></div></div>;
}

function commonProps(overrides: Partial<ComponentProps<typeof DeploymentDashboard>> = {}) {
  return {
    status: baseStatus,
    candidates: [candidate],
    events,
    loading: false,
    selectedCandidateId: candidate.id,
    onSelectedCandidate: () => undefined,
    onRefresh: () => undefined,
    onAction: () => undefined,
    onCancelAction: () => undefined,
    ...overrides
  } satisfies ComponentProps<typeof DeploymentDashboard>;
}

export const Active: Story = { render: () => <Frame {...commonProps()} /> };

export const UnknownOperation: Story = {
  render: () => <Frame {...commonProps({ operation: { id: "deploy-unknown", kind: "promote", status: "unknown", candidate_id: candidate.id, slot: "green", error_code: "unknown_outcome", error_message: "Caddy result was not observed before timeout.", created_at: now, updated_at: now } })} />
};

export const PermissionDenied: Story = {
  render: () => <Frame {...commonProps({ status: undefined, error: new ApiClientError(403, {}) })} />
};

export const Loading: Story = {
  render: () => <Frame {...commonProps({ status: undefined, candidates: [], events: [], loading: true })} />
};

export const DegradedAndConfirming: Story = {
  render: () => <Frame {...commonProps({ confirmingAction: "promote", actionPending: undefined, operation: { id: "deploy-degraded", kind: "promote", status: "degraded", created_at: now, updated_at: now } })} />
};
