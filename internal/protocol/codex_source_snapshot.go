package protocol

import (
	"encoding/json"
	"time"
)

// CodexSourceSnapshot is the internal, wire-neutral projection exchanged by
// the Host-local source adapter and the persistence service. It is separate
// from the public REST contract so a large source replay cannot accidentally
// become a browser API shape.
type CodexSourceSnapshot struct {
	OperationID          string                       `json:"operation_id"`
	HostID               string                       `json:"host_id"`
	ConnectionGeneration int64                        `json:"connection_generation,omitempty"`
	Recovery             bool                         `json:"recovery,omitempty"`
	State                CodexSourceState             `json:"state"`
	SyncState            CodexSyncState               `json:"sync_state"`
	Build                string                       `json:"build"`
	ProtocolVersion      string                       `json:"protocol_version"`
	Capabilities         []string                     `json:"capabilities"`
	CapabilityStates     map[string]string            `json:"capability_states"`
	Projects             []CodexSourceProjectSnapshot `json:"projects"`
	Threads              []CodexSourceThreadSnapshot  `json:"threads"`
	AsOf                 time.Time                    `json:"as_of"`
	Cursor               string                       `json:"cursor"`
	Error                string                       `json:"error"`
}

type CodexSourceProjectSnapshot struct {
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	CWD       string    `json:"cwd"`
	AsOf      time.Time `json:"as_of"`
}

type CodexSourceThreadSnapshot struct {
	ThreadID       string                    `json:"thread_id"`
	ProjectID      *string                   `json:"project_id,omitempty"`
	ParentThreadID *string                   `json:"parent_thread_id,omitempty"`
	SourceKind     CodexThreadSourceKind     `json:"source_kind"`
	CodexTitle     *string                   `json:"codex_title,omitempty"`
	Preview        string                    `json:"preview"`
	CWD            string                    `json:"cwd"`
	SourceStatus   CodexSourceStatus         `json:"source_status"`
	HistoryState   CodexHistoryState         `json:"history_state"`
	FilesComplete  bool                      `json:"files_complete"`
	Events         []CodexSourceHistoryEvent `json:"events"`
	Files          []CodexSourceFileMaterial `json:"files"`
	LastActivityAt time.Time                 `json:"last_activity_at"`
	Error          string                    `json:"error"`
	RawThread      json.RawMessage           `json:"raw_thread,omitempty"`
}

type CodexSourceHistoryEvent struct {
	EventID          string          `json:"event_id"`
	Sequence         int64           `json:"sequence"`
	EventType        string          `json:"event_type"`
	RawPayload       json.RawMessage `json:"raw_payload"`
	ReadableFallback string          `json:"readable_fallback"`
	OccurredAt       time.Time       `json:"occurred_at"`
}

type CodexSourceFileMaterial struct {
	Path        string `json:"path"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Content     []byte `json:"content,omitempty"`
	ContentRef  string `json:"content_ref,omitempty"`
	Complete    bool   `json:"complete"`
}
