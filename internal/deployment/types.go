package deployment

import (
	"context"
	"time"
)

type Role string

const (
	RoleObserver Role = "deployment_observer"
	RoleOperator Role = "deployment_operator"
	RoleReleaser Role = "deployment_releaser"
	RoleRecovery Role = "deployment_recovery"
	RoleOwner    Role = "installation_owner"
)

type Capability string

const (
	CapabilityView      Capability = "view"
	CapabilityPreflight Capability = "preflight"
	CapabilityStage     Capability = "stage"
	CapabilityPromote   Capability = "promote"
	CapabilityRollback  Capability = "rollback"
	CapabilityReconcile Capability = "reconcile"
	CapabilityDrain     Capability = "emergency_drain"
)

type Candidate struct {
	ID             string    `json:"id"`
	SourceSHA      string    `json:"source_sha"`
	ArtifactDigest string    `json:"artifact_digest"`
	WebDigest      string    `json:"web_digest"`
	StateVersion   int64     `json:"state_version"`
	ReadMin        int64     `json:"read_min"`
	ReadMax        int64     `json:"read_max"`
	MigrationMode  string    `json:"migration_mode"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	ServerImage    string    `json:"-"`
	WorkerImage    string    `json:"-"`
}

type Slot struct {
	Name             string `json:"slot"`
	State            string `json:"state"`
	CandidateID      string `json:"candidate_id,omitempty"`
	WorkerGeneration *int64 `json:"worker_generation,omitempty"`
}

type Operation struct {
	ID                  string     `json:"id"`
	Kind                string     `json:"kind"`
	Status              string     `json:"status"`
	CandidateID         string     `json:"candidate_id,omitempty"`
	Slot                string     `json:"slot,omitempty"`
	TargetOperationID   string     `json:"target_operation_id,omitempty"`
	ExpectedFingerprint string     `json:"expected_current_fingerprint,omitempty"`
	ErrorCode           string     `json:"error_code,omitempty"`
	ErrorMessage        string     `json:"error_message,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	StartedAt           *time.Time `json:"started_at,omitempty"`
	FinishedAt          *time.Time `json:"finished_at,omitempty"`
	UpdatedAt           time.Time  `json:"updated_at"`
	ObservedFingerprint string     `json:"-"`
	ExecutionKind       string     `json:"-"`
	RetiringSlot        string     `json:"-"`
	CandidateSourceSHA  string     `json:"-"`
	ArtifactDigest      string     `json:"-"`
	WebDigest           string     `json:"-"`
	ServerImage         string     `json:"-"`
	WorkerImage         string     `json:"-"`
	WorkerGeneration    int64      `json:"-"`
	RetainedCandidates  []string   `json:"-"`
}

type Event struct {
	ID                  int64          `json:"id"`
	OperationID         string         `json:"operation_id"`
	Type                string         `json:"type"`
	CandidateID         string         `json:"candidate_id,omitempty"`
	Slot                string         `json:"slot,omitempty"`
	WorkerGeneration    *int64         `json:"worker_generation,omitempty"`
	ObservedFingerprint string         `json:"observed_fingerprint,omitempty"`
	Details             map[string]any `json:"details,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
}

type Status struct {
	ActiveSlot           string       `json:"active_slot"`
	ActiveCandidateID    string       `json:"active_candidate_id"`
	ActiveFingerprint    string       `json:"active_fingerprint"`
	NextWorkerGeneration int64        `json:"next_worker_generation"`
	Slots                []Slot       `json:"slots"`
	LatestOperation      *Operation   `json:"latest_operation,omitempty"`
	Role                 Role         `json:"role,omitempty"`
	Capabilities         []Capability `json:"capabilities"`
	ControllerReady      bool         `json:"controller_ready"`
}

type OperationRequest struct {
	CandidateID         string `json:"candidate_id,omitempty"`
	ExpectedFingerprint string `json:"expected_current_fingerprint,omitempty"`
	Slot                string `json:"slot,omitempty"`
	OperationID         string `json:"operation_id,omitempty"`
	Confirm             bool   `json:"confirm,omitempty"`
}

type StatusResponse struct {
	Status Status `json:"status"`
}

type CandidateListResponse struct {
	Candidates []Candidate `json:"candidates"`
}

type CandidateResponse struct {
	Candidate Candidate `json:"candidate"`
}

type EventListResponse struct {
	Events []Event `json:"events"`
}

type OperationResponse struct {
	Operation Operation `json:"operation"`
	Created   bool      `json:"created"`
}

type Executor interface {
	Execute(context.Context, Operation) error
}
