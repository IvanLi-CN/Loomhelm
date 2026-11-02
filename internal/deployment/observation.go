package deployment

import "time"

const (
	ObservationMeasured    = "measured"
	ObservationWarmingUp   = "warming_up"
	ObservationDegraded    = "degraded"
	ObservationStale       = "stale"
	ObservationUnavailable = "unavailable"
	ObservationUnknown     = "unknown"
)

// ComponentObservation is also the private loopback contract returned by a
// Server or Worker. It deliberately contains bounded counters and gauges only;
// request identities, URLs and user data never enter the deployment surface.
type ComponentObservation struct {
	State                 string    `json:"state"`
	Reason                string    `json:"reason,omitempty"`
	LoadState             string    `json:"load_state"`
	LoadReason            string    `json:"load_reason,omitempty"`
	ObservedAt            time.Time `json:"observed_at"`
	Live                  bool      `json:"live"`
	Ready                 bool      `json:"ready"`
	CandidateSourceSHA    string    `json:"candidate_source_sha,omitempty"`
	ArtifactDigest        string    `json:"artifact_digest,omitempty"`
	RequestsTotal         uint64    `json:"requests_total"`
	Responses4xx          uint64    `json:"responses_4xx"`
	Responses5xx          uint64    `json:"responses_5xx"`
	ActiveRequests        int64     `json:"active_requests"`
	ActiveMCPRequests     int64     `json:"active_mcp_requests"`
	ActiveGatewayRequests int64     `json:"active_gateway_requests"`
	QueueDepth            *int64    `json:"queue_depth,omitempty"`
	RunningJobs           *int64    `json:"running_jobs,omitempty"`
	WorkerCapacity        *int64    `json:"worker_capacity,omitempty"`
	WorkerGeneration      *int64    `json:"worker_generation,omitempty"`
}

type SlotTrafficObservation struct {
	State          string   `json:"state"`
	Reason         string   `json:"reason,omitempty"`
	RequestsTotal  uint64   `json:"requests_total"`
	RequestRate    *float64 `json:"request_rate,omitempty"`
	Share          *float64 `json:"share,omitempty"`
	ErrorRate      *float64 `json:"error_rate,omitempty"`
	ActiveRequests int64    `json:"active_requests"`
}

type SlotLoadObservation struct {
	State              string   `json:"state"`
	Reason             string   `json:"reason,omitempty"`
	HTTPActiveRequests int64    `json:"http_active_requests"`
	WorkerRunningJobs  *int64   `json:"worker_running_jobs,omitempty"`
	WorkerCapacity     *int64   `json:"worker_capacity,omitempty"`
	WorkerUtilization  *float64 `json:"worker_utilization,omitempty"`
}

type SlotObservation struct {
	Slot             string                 `json:"slot"`
	DesiredState     string                 `json:"desired_state"`
	CandidateID      string                 `json:"candidate_id,omitempty"`
	WorkerGeneration *int64                 `json:"worker_generation,omitempty"`
	Server           ComponentObservation   `json:"server"`
	Worker           ComponentObservation   `json:"worker"`
	Traffic          SlotTrafficObservation `json:"traffic"`
	Load             SlotLoadObservation    `json:"load"`
}

// Observation is a live controller sample. It is intentionally not durable
// business state; after a controller restart the first sample is warming_up
// until a second counter sample makes rates and shares measurable.
type Observation struct {
	State                      string            `json:"state"`
	Reason                     string            `json:"reason,omitempty"`
	ObservedAt                 time.Time         `json:"observed_at"`
	DesiredActiveSlot          string            `json:"desired_active_slot"`
	ObservedActiveSlot         string            `json:"observed_active_slot,omitempty"`
	ObservedActiveCandidateSHA string            `json:"observed_active_candidate_sha,omitempty"`
	MigrationState             string            `json:"migration_state"`
	SampleWindowSeconds        float64           `json:"sample_window_seconds"`
	TotalRequestRate           *float64          `json:"total_request_rate,omitempty"`
	TotalErrorRate             *float64          `json:"total_error_rate,omitempty"`
	SharedWorkerLoadState      string            `json:"shared_worker_load_state"`
	SharedWorkerLoadReason     string            `json:"shared_worker_load_reason,omitempty"`
	SharedWorkerQueueDepth     *int64            `json:"shared_worker_queue_depth,omitempty"`
	SharedWorkerRunningJobs    *int64            `json:"shared_worker_running_jobs,omitempty"`
	SharedWorkerCapacity       *int64            `json:"shared_worker_capacity,omitempty"`
	SharedWorkerUtilization    *float64          `json:"shared_worker_utilization,omitempty"`
	Slots                      []SlotObservation `json:"slots"`
}

type ObservationResponse struct {
	Observation Observation `json:"observation"`
}
