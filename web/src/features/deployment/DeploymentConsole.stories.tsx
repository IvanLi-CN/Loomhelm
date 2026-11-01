import { ApiClientError } from "@loomhelm/api-client";
import type { DeploymentCandidate, DeploymentComponentObservation, DeploymentEvent, DeploymentObservation, DeploymentSlotObservation, DeploymentStatus } from "@loomhelm/protocol";
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

function componentObservation(overrides: Partial<DeploymentComponentObservation> = {}): DeploymentComponentObservation {
  return {
    state: "measured",
    load_state: "measured",
    observed_at: now,
    live: true,
    ready: true,
    requests_total: 1000,
    responses_4xx: 8,
    responses_5xx: 2,
    active_requests: 2,
    active_mcp_requests: 0,
    active_gateway_requests: 1,
    ...overrides
  };
}

const measuredSlots: DeploymentSlotObservation[] = [
  {
    slot: "blue",
    desired_state: "draining",
    candidate_id: baseStatus.slots[0].candidate_id,
    worker_generation: 7,
    server: componentObservation({ candidate_source_sha: baseStatus.slots[0].candidate_id?.slice(0, 40), artifact_digest: baseStatus.active_fingerprint, active_requests: 2 }),
    worker: componentObservation({ queue_depth: 3, running_jobs: 1, worker_capacity: 4, worker_generation: 7, active_requests: 0 }),
    traffic: { state: "measured", requests_total: 1070, request_rate: 70, share: 0.7, error_rate: 0.014, active_requests: 2 },
    load: { state: "measured", http_active_requests: 2, worker_running_jobs: 1, worker_capacity: 4, worker_utilization: 0.25 }
  },
  {
    slot: "green",
    desired_state: "active",
    candidate_id: candidate.id,
    worker_generation: 8,
    server: componentObservation({ candidate_source_sha: candidate.source_sha, artifact_digest: candidate.artifact_digest, requests_total: 800, active_requests: 4, active_gateway_requests: 3 }),
    worker: componentObservation({ queue_depth: 7, running_jobs: 4, worker_capacity: 4, worker_generation: 8, active_requests: 0 }),
    traffic: { state: "measured", requests_total: 800, request_rate: 30, share: 0.3, error_rate: 0, active_requests: 4 },
    load: { state: "measured", http_active_requests: 4, worker_running_jobs: 4, worker_capacity: 4, worker_utilization: 1 }
  }
];

const measuredObservation: DeploymentObservation = {
  state: "measured",
  observed_at: now,
  desired_active_slot: "green",
  observed_active_slot: "green",
  observed_active_candidate_sha: candidate.source_sha,
  migration_state: "draining",
  sample_window_seconds: 10,
  total_request_rate: 100,
  total_error_rate: 0.01,
  shared_worker_load_state: "measured",
  shared_worker_queue_depth: 7,
  shared_worker_running_jobs: 4,
  shared_worker_capacity: 4,
  shared_worker_utilization: 1,
  slots: measuredSlots
};

const staleObservation: DeploymentObservation = {
  ...measuredObservation,
  state: "stale",
  migration_state: "unknown",
  reason: "运行时端点暂时不可用，展示上次有效采样。"
};

const unavailableObservation: DeploymentObservation = {
  ...measuredObservation,
  state: "unavailable",
  observed_active_slot: undefined,
  observed_active_candidate_sha: undefined,
  migration_state: "unknown",
  total_request_rate: undefined,
  total_error_rate: undefined,
  shared_worker_load_state: "unavailable",
  shared_worker_load_reason: "运行时端点尚未提供可用观测。",
  shared_worker_queue_depth: undefined,
  shared_worker_running_jobs: undefined,
  shared_worker_capacity: undefined,
  shared_worker_utilization: undefined,
  reason: "运行时端点尚未提供可用观测。",
  slots: measuredSlots.map((slot) => ({
    ...slot,
    server: componentObservation({ state: "unavailable", load_state: "unavailable", live: false, ready: false, requests_total: 0, responses_4xx: 0, responses_5xx: 0, active_requests: 0, active_mcp_requests: 0, active_gateway_requests: 0 }),
    worker: componentObservation({ state: "unavailable", load_state: "unavailable", live: false, ready: false, requests_total: 0, responses_4xx: 0, responses_5xx: 0, active_requests: 0, active_mcp_requests: 0, active_gateway_requests: 0 }),
    traffic: { state: "unavailable", requests_total: 0, active_requests: 0 },
    load: { state: "unavailable", http_active_requests: 0 }
  }))
};

const degradedObservation: DeploymentObservation = {
  ...measuredObservation,
  state: "degraded",
  migration_state: "route_mismatch",
  observed_active_slot: "blue",
  reason: "Worker generation 7 与蓝槽记录不一致；public route identity does not match the desired slot",
  shared_worker_load_state: "degraded",
  shared_worker_load_reason: "no ready Worker generation supplied a load sample",
  shared_worker_queue_depth: undefined,
  shared_worker_running_jobs: undefined,
  shared_worker_capacity: undefined,
  shared_worker_utilization: undefined,
  slots: measuredSlots.map((slot) => slot.slot === "blue" ? {
    ...slot,
    worker: { ...slot.worker, worker_generation: 99, load_state: "measured" },
    load: { state: "degraded", reason: "Worker generation 99 cannot be attributed to persisted generation 7", http_active_requests: 2 }
  } : slot)
};

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
    observation: measuredObservation,
    observationLoading: false,
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

export const ObservationStale: Story = { render: () => <Frame {...commonProps({ observation: staleObservation })} /> };

export const ObservationUnavailable: Story = { render: () => <Frame {...commonProps({ observation: unavailableObservation })} /> };

export const ObservationDegraded: Story = { render: () => <Frame {...commonProps({ observation: degradedObservation })} /> };

export const ObservationMobile: Story = {
  render: () => <Frame {...commonProps()} />,
  parameters: {
    viewport: {
      options: {
        deploymentMobile: {
          name: "Deployment console mobile 393x852",
          styles: { width: "393px", height: "852px" },
          type: "mobile"
        }
      }
    }
  },
  globals: { viewport: "deploymentMobile" }
};

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
