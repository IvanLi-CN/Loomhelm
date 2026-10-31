package runs

import (
	"errors"
	"fmt"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

var (
	ErrInvalidRun         = errors.New("run is invalid")
	ErrRunTransition      = errors.New("run transition is invalid")
	ErrRunTerminal        = errors.New("run is already terminal")
	ErrRunUnknown         = errors.New("run result is unknown")
	ErrInterruptRequested = errors.New("run interruption is already requested")
)

type InterruptState string

const (
	InterruptNone       InterruptState = "none"
	InterruptRequested  InterruptState = "requested"
	InterruptObserved   InterruptState = "observed"
	InterruptSuperseded InterruptState = "superseded"
)

type Run struct {
	ID             string
	SessionID      string
	CommandID      string
	Generation     string
	Status         protocol.RunStatus
	Interrupt      InterruptState
	LastCursor     string
	TerminalReason string
	CreatedAt      string
	StartedAt      string
	FinishedAt     string
	UpdatedAt      string
}

type NewRunInput struct {
	ID         string
	SessionID  string
	CommandID  string
	Generation string
}

type Observation struct {
	Reconciliation protocol.ReconciliationState
	Status         protocol.RunStatus
	Cursor         string
	Reason         string
}

func New(input NewRunInput) (Run, error) {
	if strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.SessionID) == "" || strings.TrimSpace(input.CommandID) == "" || strings.TrimSpace(input.Generation) == "" {
		return Run{}, fmt.Errorf("%w: id, session id, command id and generation are required", ErrInvalidRun)
	}
	return Run{
		ID:         input.ID,
		SessionID:  input.SessionID,
		CommandID:  input.CommandID,
		Generation: input.Generation,
		Status:     protocol.RunStatusPending,
		Interrupt:  InterruptNone,
	}, nil
}

func (r Run) CheckGeneration(generation string) error {
	if strings.TrimSpace(generation) == "" || generation != r.Generation {
		return fmt.Errorf("%w: got %q, run belongs to %q", ErrStaleGeneration, generation, r.Generation)
	}
	return nil
}

func (r Run) Start(generation, cursor string) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	if r.Status != protocol.RunStatusPending {
		if r.Status == protocol.RunStatusUnknown {
			return Run{}, ErrRunUnknown
		}
		return Run{}, fmt.Errorf("%w: %s -> running", ErrRunTransition, r.Status)
	}
	r.Status = protocol.RunStatusRunning
	r.LastCursor = cursor
	return r, nil
}

func (r Run) RequestInterrupt(generation string) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	switch r.Status {
	case protocol.RunStatusRunning, protocol.RunStatusWaitingApproval:
		if r.Interrupt == InterruptRequested {
			return Run{}, ErrInterruptRequested
		}
		if r.Interrupt == InterruptObserved || r.Interrupt == InterruptSuperseded {
			return Run{}, fmt.Errorf("%w: interruption has already been resolved", ErrRunTerminal)
		}
		r.Interrupt = InterruptRequested
		return r, nil
	case protocol.RunStatusUnknown:
		return Run{}, ErrRunUnknown
	case protocol.RunStatusPending:
		return Run{}, fmt.Errorf("%w: pending run has not started", ErrRunTransition)
	default:
		return Run{}, fmt.Errorf("%w: terminal run cannot be interrupted", ErrRunTerminal)
	}
}

func (r Run) WaitForApproval(generation, cursor string) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	if r.Status != protocol.RunStatusRunning {
		if r.Status == protocol.RunStatusUnknown {
			return Run{}, ErrRunUnknown
		}
		return Run{}, fmt.Errorf("%w: %s -> waiting_approval", ErrRunTransition, r.Status)
	}
	r.Status = protocol.RunStatusWaitingApproval
	r.LastCursor = cursor
	return r, nil
}

func (r Run) ResumeAfterApproval(generation, cursor string) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	if r.Status != protocol.RunStatusWaitingApproval {
		if r.Status == protocol.RunStatusUnknown {
			return Run{}, ErrRunUnknown
		}
		return Run{}, fmt.Errorf("%w: %s -> running", ErrRunTransition, r.Status)
	}
	r.Status = protocol.RunStatusRunning
	r.LastCursor = cursor
	return r, nil
}

func (r Run) ObserveTerminal(generation string, status protocol.RunStatus, cursor, reason string) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	if !terminalRunStatus(status) {
		return Run{}, fmt.Errorf("%w: %q is not a terminal run status", ErrRunTransition, status)
	}
	if terminalRunStatus(r.Status) {
		if r.Status == status {
			r.LastCursor = cursor
			return r, nil
		}
		return Run{}, fmt.Errorf("%w: %s cannot become %s", ErrRunTerminal, r.Status, status)
	}
	if r.Status == protocol.RunStatusPending {
		return Run{}, fmt.Errorf("%w: pending run has no observed execution", ErrRunTransition)
	}
	r.Status = status
	r.LastCursor = cursor
	r.TerminalReason = reason
	if status == protocol.RunStatusInterrupted {
		r.Interrupt = InterruptObserved
	} else if r.Interrupt == InterruptRequested {
		r.Interrupt = InterruptSuperseded
	}
	return r, nil
}

func (r Run) MarkUnknown(generation, cursor, reason string) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	if terminalRunStatus(r.Status) {
		return r, nil
	}
	if r.Status == protocol.RunStatusUnknown {
		return r, nil
	}
	r.Status = protocol.RunStatusUnknown
	r.LastCursor = cursor
	r.TerminalReason = reason
	return r, nil
}

func (r Run) Reconcile(generation string, observation Observation) (Run, error) {
	if err := r.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	if r.Status != protocol.RunStatusUnknown {
		if terminalRunStatus(r.Status) {
			return r, nil
		}
		return Run{}, ErrRunUnknown
	}
	switch observation.Reconciliation {
	case protocol.ReconciliationStateUnknown:
		return r, fmt.Errorf("%w: run %q remains unknown", protocol.ErrUnknownCommandResult, r.ID)
	case protocol.ReconciliationStateNotFound:
		return r.ObserveTerminal(generation, protocol.RunStatusFailed, observation.Cursor, firstNonEmpty(observation.Reason, "external run was not found during reconciliation"))
	case protocol.ReconciliationStateConfirmed:
		switch observation.Status {
		case protocol.RunStatusRunning:
			r.Status = protocol.RunStatusRunning
			r.LastCursor = observation.Cursor
			return r, nil
		case protocol.RunStatusWaitingApproval:
			r.Status = protocol.RunStatusWaitingApproval
			r.LastCursor = observation.Cursor
			return r, nil
		case protocol.RunStatusCompleted, protocol.RunStatusFailed, protocol.RunStatusInterrupted:
			return r.ObserveTerminal(generation, observation.Status, observation.Cursor, observation.Reason)
		default:
			return Run{}, fmt.Errorf("%w: confirmed observation has invalid status %q", ErrRunUnknown, observation.Status)
		}
	default:
		return Run{}, fmt.Errorf("%w: unsupported reconciliation state %q", ErrRunUnknown, observation.Reconciliation)
	}
}

func terminalRunStatus(status protocol.RunStatus) bool {
	return status == protocol.RunStatusCompleted || status == protocol.RunStatusFailed || status == protocol.RunStatusInterrupted
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
