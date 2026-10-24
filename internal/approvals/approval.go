// Package approvals owns versioned approval transitions. It does not perform
// authorization or send a transport response.
package approvals

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

var (
	ErrInvalidApproval    = errors.New("approval is invalid")
	ErrApprovalNotPending = errors.New("approval is not pending")
	ErrApprovalExpired    = errors.New("approval is expired")
	ErrApprovalResolved   = errors.New("approval is already resolved")
	ErrRevisionStale      = errors.New("approval revision is stale")
	ErrApprovalGeneration = errors.New("approval generation is stale")
	ErrApprovalContext    = errors.New("approval context does not match")
)

type Approval struct {
	protocol.Approval
	SessionID           string
	Generation          string
	ResolvedByCommandID string
}

type NewInput struct {
	ID          string
	RunID       string
	SessionID   string
	Generation  string
	Revision    int64
	Kind        string
	Summary     string
	RequestedAt string
}

type ResolveRequest struct {
	ApprovalID string
	RunID      string
	SessionID  string
	Generation string
	Request    protocol.ResolveApprovalRequest
}

type Resolution struct {
	Approval     Approval
	Deduplicated bool
}

func New(input NewInput) (Approval, error) {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.RunID) == "" || strings.TrimSpace(input.SessionID) == "" || strings.TrimSpace(input.Generation) == "" || strings.TrimSpace(input.Kind) == "" {
		return Approval{}, fmt.Errorf("%w: id, run id, session id, generation and kind are required", ErrInvalidApproval)
	}
	if input.Revision <= 0 {
		return Approval{}, fmt.Errorf("%w: revision must be positive", ErrInvalidApproval)
	}
	return Approval{
		Approval: protocol.Approval{
			ID:          input.ID,
			RunID:       input.RunID,
			Revision:    input.Revision,
			Kind:        input.Kind,
			Summary:     input.Summary,
			Status:      protocol.ApprovalStatusPending,
			RequestedAt: input.RequestedAt,
		},
		SessionID:  input.SessionID,
		Generation: input.Generation,
	}, nil
}

func (a Approval) AdvanceRevision(revision int64, summary, requestedAt string) (Approval, error) {
	if a.Status != protocol.ApprovalStatusPending {
		return Approval{}, ErrApprovalNotPending
	}
	if revision <= a.Revision {
		return Approval{}, fmt.Errorf("%w: got %d, current is %d", ErrRevisionStale, revision, a.Revision)
	}
	a.Revision = revision
	a.Summary = summary
	a.RequestedAt = requestedAt
	return a, nil
}

func (a Approval) Expire() (Approval, error) {
	if a.Status == protocol.ApprovalStatusExpired {
		return a, nil
	}
	if a.Status != protocol.ApprovalStatusPending {
		return Approval{}, ErrApprovalResolved
	}
	a.Status = protocol.ApprovalStatusExpired
	return a, nil
}

func (a Approval) Resolve(request ResolveRequest) (Resolution, error) {
	if err := a.validateRequest(request); err != nil {
		return Resolution{}, err
	}
	if a.Status == protocol.ApprovalStatusApproved || a.Status == protocol.ApprovalStatusDenied {
		if a.ResolvedByCommandID == request.Request.CommandID && decisionMatchesStatus(request.Request.Decision, a.Status) && request.Request.Revision == a.Revision {
			return Resolution{Approval: a, Deduplicated: true}, nil
		}
		return Resolution{}, ErrApprovalResolved
	}
	if a.Status == protocol.ApprovalStatusExpired {
		return Resolution{}, ErrApprovalExpired
	}
	if a.Status != protocol.ApprovalStatusPending {
		return Resolution{}, ErrApprovalNotPending
	}
	if request.Generation != a.Generation {
		return Resolution{}, fmt.Errorf("%w: got %q, approval belongs to %q", ErrApprovalGeneration, request.Generation, a.Generation)
	}
	if request.Request.Revision != a.Revision {
		return Resolution{}, fmt.Errorf("%w: got %d, current is %d", ErrRevisionStale, request.Request.Revision, a.Revision)
	}
	if request.Request.Decision == protocol.ApprovalDecisionApprove {
		a.Status = protocol.ApprovalStatusApproved
	} else {
		a.Status = protocol.ApprovalStatusDenied
	}
	a.ResolvedByCommandID = request.Request.CommandID
	return Resolution{Approval: a}, nil
}

func (a Approval) validateRequest(request ResolveRequest) error {
	if strings.TrimSpace(request.ApprovalID) == "" || request.ApprovalID != a.ID {
		return fmt.Errorf("%w: approval id", ErrApprovalContext)
	}
	if strings.TrimSpace(request.RunID) == "" || request.RunID != a.RunID {
		return fmt.Errorf("%w: run id", ErrApprovalContext)
	}
	if strings.TrimSpace(request.SessionID) == "" || request.SessionID != a.SessionID {
		return fmt.Errorf("%w: session id", ErrApprovalContext)
	}
	if strings.TrimSpace(request.Generation) == "" {
		return fmt.Errorf("%w: generation is required", ErrApprovalGeneration)
	}
	if strings.TrimSpace(request.Request.CommandID) == "" || strings.TrimSpace(request.Request.CommandID) != request.Request.CommandID {
		return fmt.Errorf("%w: command id is required", ErrInvalidApproval)
	}
	if request.Request.Revision <= 0 {
		return fmt.Errorf("%w: revision must be positive", ErrInvalidApproval)
	}
	switch request.Request.Decision {
	case protocol.ApprovalDecisionApprove, protocol.ApprovalDecisionDeny:
		return nil
	default:
		return fmt.Errorf("%w: unsupported decision %q", ErrInvalidApproval, request.Request.Decision)
	}
}

func decisionMatchesStatus(decision protocol.ApprovalDecision, status protocol.ApprovalStatus) bool {
	return (decision == protocol.ApprovalDecisionApprove && status == protocol.ApprovalStatusApproved) ||
		(decision == protocol.ApprovalDecisionDeny && status == protocol.ApprovalStatusDenied)
}

// Resolver is a process-local compare-and-set boundary for deterministic
// concurrency tests. Durable adapters must use a transactionally guarded
// pending+revision update; this type is not a persistence implementation.
type Resolver struct {
	mu       sync.Mutex
	approval Approval
}

func NewResolver(approval Approval) *Resolver {
	return &Resolver{approval: approval}
}

func (r *Resolver) Snapshot() Approval {
	if r == nil {
		return Approval{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.approval
}

func (r *Resolver) Resolve(request ResolveRequest) (Resolution, error) {
	if r == nil {
		return Resolution{}, ErrInvalidApproval
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	result, err := r.approval.Resolve(request)
	if err != nil {
		return Resolution{}, err
	}
	r.approval = result.Approval
	return result, nil
}

func (r *Resolver) Expire() (Approval, error) {
	if r == nil {
		return Approval{}, ErrInvalidApproval
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	approval, err := r.approval.Expire()
	if err != nil {
		return Approval{}, err
	}
	r.approval = approval
	return approval, nil
}
