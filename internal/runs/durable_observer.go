package runs

import (
	"context"
	"errors"
	"fmt"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const defaultDurableObserverLimit int64 = 64

// DurableObserver derives only bounded, persisted evidence. It never asks the
// native Gateway to resend a command and never treats an empty stream as a
// completed or not-found run.
type DurableObserver struct {
	store *Store
	limit int64
}

func NewDurableObserver(store *Store, limits ...int64) *DurableObserver {
	limit := defaultDurableObserverLimit
	if len(limits) > 0 && limits[0] > 0 {
		limit = limits[0]
	}
	return &DurableObserver{store: store, limit: limit}
}

func (o *DurableObserver) Observe(ctx context.Context, run Run) (RunObservation, error) {
	if ctx == nil {
		return RunObservation{}, errors.New("durable observer context must not be nil")
	}
	if o == nil || o.store == nil {
		return RunObservation{}, ErrObserverUnavailable
	}
	observation := RunObservation{
		SessionID:  run.SessionID,
		RunID:      run.ID,
		Generation: run.Generation,
		Cursor:     run.LastCursor,
	}
	page, err := o.store.ReadEvents(ctx, protocol.EventQuery{
		SessionID:   run.SessionID,
		RunID:       run.ID,
		AfterCursor: run.LastCursor,
		Limit:       o.limit,
	})
	if err != nil {
		return RunObservation{}, fmt.Errorf("read durable run evidence: %w", err)
	}
	var found bool
	for _, event := range page.Events {
		if event.Cursor != "" {
			observation.Cursor = event.Cursor
		}
		switch event.Type {
		case protocol.EventTypeRunStarted:
			observation.Reconciliation = protocol.ReconciliationStateConfirmed
			observation.Status = protocol.RunStatusRunning
			observation.Reason = "run.started is durably persisted"
			found = true
		case protocol.EventTypeApprovalRequested:
			observation.Reconciliation = protocol.ReconciliationStateConfirmed
			observation.Status = protocol.RunStatusWaitingApproval
			observation.Reason = "approval.requested is durably persisted"
			found = true
		case protocol.EventTypeRunCompleted:
			observation.Reconciliation = protocol.ReconciliationStateConfirmed
			observation.Status = protocol.RunStatusCompleted
			observation.Reason = "run.completed is durably persisted"
			found = true
		case protocol.EventTypeRunFailed:
			observation.Reconciliation = protocol.ReconciliationStateConfirmed
			observation.Status = protocol.RunStatusFailed
			observation.Reason = "run.failed is durably persisted"
			found = true
		case protocol.EventTypeRunInterrupted:
			observation.Reconciliation = protocol.ReconciliationStateConfirmed
			observation.Status = protocol.RunStatusInterrupted
			observation.Reason = "run.interrupted is durably persisted"
			found = true
		case protocol.EventTypeReconciliationRequired:
			observation.Reconciliation = protocol.ReconciliationStateUnknown
			observation.Status = ""
			observation.Reason = "reconciliation.required is durably persisted"
			found = true
		}
	}
	if found {
		return observation, nil
	}
	if run.Status == protocol.RunStatusRunning || run.Status == protocol.RunStatusWaitingApproval {
		observation.Reconciliation = protocol.ReconciliationStateConfirmed
		observation.Status = run.Status
		observation.Reason = "current durable Run state remains active"
		return observation, nil
	}
	command, commandErr := o.store.Lookup(ctx, run.CommandID)
	if commandErr == nil {
		switch command.State {
		case protocol.CommandStateExecuting, protocol.CommandStateSucceeded:
			return RunObservation{}, fmt.Errorf("%w: command %q has no durable native start evidence", ErrObserverUnavailable, run.CommandID)
		}
	} else if !errors.Is(commandErr, ErrCommandNotFound) {
		return RunObservation{}, fmt.Errorf("read durable run command evidence: %w", commandErr)
	}
	observation.Reconciliation = protocol.ReconciliationStateUnknown
	observation.Status = ""
	observation.Reason = "durable execution evidence is not yet available"
	return observation, nil
}

var _ Observer = (*DurableObserver)(nil)
