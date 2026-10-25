package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/events"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrRunNotFound         = errors.New("run is not present in persistence")
	ErrRunConflict         = errors.New("run identity conflicts with persisted state")
	ErrStaleRunObservation = errors.New("run observation is stale")
)

type StoreConfig struct {
	Now func() time.Time
}

// Store is the durable execution boundary. Command acceptance is committed
// before a caller crosses a Gateway or Connector side-effect boundary; event
// application can then update the Run and task protection in the same commit.
type Store struct {
	pool   *pgxpool.Pool
	now    func() time.Time
	events *events.Store
}

func NewStore(pool *pgxpool.Pool, configs ...StoreConfig) *Store {
	now := time.Now
	if len(configs) > 0 && configs[0].Now != nil {
		now = configs[0].Now
	}
	return &Store{pool: pool, now: now, events: events.NewStore(pool, events.StoreConfig{Now: now})}
}

func (s *Store) Accept(ctx context.Context, intent CommandIntent) (AcceptResult, error) {
	if err := s.ready(ctx); err != nil {
		return AcceptResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcceptResult{}, fmt.Errorf("begin command acceptance: %w", err)
	}
	defer tx.Rollback(ctx)
	result, err := s.acceptTx(ctx, tx, intent)
	if err != nil {
		return AcceptResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptResult{}, fmt.Errorf("commit command acceptance: %w", err)
	}
	return result, nil
}

func (s *Store) AcceptForGeneration(ctx context.Context, currentGeneration string, intent CommandIntent) (AcceptResult, error) {
	if err := CheckCurrentGeneration(currentGeneration, intent.Generation); err != nil {
		return AcceptResult{}, err
	}
	return s.Accept(ctx, intent)
}

// AcceptRun commits a command and its pending Run identity together. This is
// the Server-side boundary used before a run is enqueued into River.
func (s *Store) AcceptRun(ctx context.Context, intent CommandIntent, input NewRunInput) (AcceptResult, Run, error) {
	if err := s.ready(ctx); err != nil {
		return AcceptResult{}, Run{}, err
	}
	if input.CommandID != intent.Command.CommandID || input.SessionID != intent.Command.SessionID || input.Generation != intent.Generation {
		return AcceptResult{}, Run{}, fmt.Errorf("%w: command and run identities do not match", ErrInvalidRun)
	}
	candidate, err := New(input)
	if err != nil {
		return AcceptResult{}, Run{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcceptResult{}, Run{}, fmt.Errorf("begin command and run acceptance: %w", err)
	}
	defer tx.Rollback(ctx)
	accepted, err := s.acceptTx(ctx, tx, intent)
	if err != nil {
		return AcceptResult{}, Run{}, err
	}
	if err := insertRunTx(ctx, tx, candidate, s.now); err != nil {
		return AcceptResult{}, Run{}, err
	}
	stored, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1`, candidate.ID))
	if err != nil {
		return AcceptResult{}, Run{}, fmt.Errorf("read accepted run: %w", err)
	}
	if !sameRunIdentity(candidate, stored) {
		return AcceptResult{}, Run{}, fmt.Errorf("%w: run %q", ErrRunConflict, candidate.ID)
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptResult{}, Run{}, fmt.Errorf("commit command and run acceptance: %w", err)
	}
	return accepted, stored, nil
}

func (s *Store) Lookup(ctx context.Context, commandID string) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	if strings.TrimSpace(commandID) == "" {
		return CommandRecord{}, fmt.Errorf("%w: command id is required", ErrCommandNotFound)
	}
	record, err := scanCommand(s.pool.QueryRow(ctx, commandQuery+` WHERE command.command_id = $1`, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, ErrCommandNotFound
	}
	return record, err
}

func (s *Store) Transition(ctx context.Context, commandID, generation string, next protocol.CommandState, operationID string, result json.RawMessage, apiError *protocol.ApiError) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin command transition: %w", err)
	}
	defer tx.Rollback(ctx)
	record, err := scanCommand(tx.QueryRow(ctx, commandQuery+` WHERE command.command_id = $1 FOR UPDATE`, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, ErrCommandNotFound
	}
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock command transition: %w", err)
	}
	if err := checkCommandGeneration(record, generation); err != nil {
		return CommandRecord{}, err
	}
	if !validCommandState(next) {
		return CommandRecord{}, fmt.Errorf("%w: unsupported command state %q", ErrCommandTransition, next)
	}
	if record.State == next {
		record.OperationID = operationID
		record.Result = append(json.RawMessage(nil), result...)
		record.Error = cloneAPIError(apiError)
		if err := updateCommandTx(ctx, tx, record, ""); err != nil {
			return CommandRecord{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CommandRecord{}, fmt.Errorf("commit idempotent command transition: %w", err)
		}
		return record, nil
	}
	if record.State == protocol.CommandStateUnknown {
		return CommandRecord{}, fmt.Errorf("%w: unknown command must be reconciled", ErrCommandNotUnknown)
	}
	if !allowedCommandTransition(record.State, next) {
		if isTerminalCommandState(record.State) {
			return CommandRecord{}, fmt.Errorf("%w: %s -> %s", ErrCommandTerminal, record.State, next)
		}
		return CommandRecord{}, fmt.Errorf("%w: %s -> %s", ErrCommandTransition, record.State, next)
	}
	record.State = next
	record.OperationID = operationID
	record.Result = append(json.RawMessage(nil), result...)
	record.Error = cloneAPIError(apiError)
	if err := updateCommandTx(ctx, tx, record, ""); err != nil {
		return CommandRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandRecord{}, fmt.Errorf("commit command transition: %w", err)
	}
	return record, nil
}

func (s *Store) RecordCommandCursor(ctx context.Context, commandID, generation, cursor string) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	if strings.TrimSpace(cursor) == "" {
		return CommandRecord{}, fmt.Errorf("%w: event cursor is required", ErrCommandTransition)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin command cursor update: %w", err)
	}
	defer tx.Rollback(ctx)
	record, err := scanCommand(tx.QueryRow(ctx, commandQuery+` WHERE command.command_id = $1 FOR UPDATE`, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, ErrCommandNotFound
	}
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock command cursor update: %w", err)
	}
	if err := checkCommandGeneration(record, generation); err != nil {
		return CommandRecord{}, err
	}
	record.EventCursor = cursor
	if err := updateCommandTx(ctx, tx, record, ""); err != nil {
		return CommandRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandRecord{}, fmt.Errorf("commit command cursor update: %w", err)
	}
	return record, nil
}

func (s *Store) MarkUnknown(ctx context.Context, commandID, generation string) (CommandRecord, error) {
	return s.Transition(ctx, commandID, generation, protocol.CommandStateUnknown, "", nil, nil)
}

func (s *Store) Reconcile(ctx context.Context, commandID, generation string, observation CommandObservation) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin command reconciliation: %w", err)
	}
	defer tx.Rollback(ctx)
	record, err := scanCommand(tx.QueryRow(ctx, commandQuery+` WHERE command.command_id = $1 FOR UPDATE`, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, ErrCommandNotFound
	}
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock command reconciliation: %w", err)
	}
	if err := checkCommandGeneration(record, generation); err != nil {
		return CommandRecord{}, err
	}
	if record.State != protocol.CommandStateUnknown {
		if isTerminalCommandState(record.State) {
			if err := tx.Commit(ctx); err != nil {
				return CommandRecord{}, fmt.Errorf("commit terminal reconciliation lookup: %w", err)
			}
			return record, nil
		}
		return CommandRecord{}, ErrCommandNotUnknown
	}
	record.ReconciliationState = observation.Reconciliation
	record.EventCursor = observation.EventCursor
	switch observation.Reconciliation {
	case protocol.ReconciliationStateUnknown:
		if err := updateCommandTx(ctx, tx, record, "unknown"); err != nil {
			return CommandRecord{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CommandRecord{}, fmt.Errorf("commit unresolved reconciliation: %w", err)
		}
		return record, fmt.Errorf("%w: command %q remains unknown", protocol.ErrUnknownCommandResult, commandID)
	case protocol.ReconciliationStateNotFound:
		observation.State = protocol.CommandStateRejected
	case protocol.ReconciliationStateConfirmed:
		if !validCommandState(observation.State) || observation.State == protocol.CommandStateAccepted || observation.State == protocol.CommandStateUnknown {
			return CommandRecord{}, fmt.Errorf("%w: confirmed observation needs executing or terminal state", ErrReconciliationUnknown)
		}
	default:
		return CommandRecord{}, fmt.Errorf("%w: unsupported reconciliation state %q", ErrReconciliationUnknown, observation.Reconciliation)
	}
	if !allowedReconciliationState(observation.State) {
		return CommandRecord{}, fmt.Errorf("%w: unknown -> %s", ErrCommandTransition, observation.State)
	}
	record.State = observation.State
	record.OperationID = observation.OperationID
	record.Result = append(json.RawMessage(nil), observation.Result...)
	record.Error = cloneAPIError(observation.Error)
	if err := updateCommandTx(ctx, tx, record, string(observation.Reconciliation)); err != nil {
		return CommandRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandRecord{}, fmt.Errorf("commit command reconciliation: %w", err)
	}
	return record, nil
}

func (s *Store) CreateRun(ctx context.Context, input NewRunInput) (Run, error) {
	if err := s.ready(ctx); err != nil {
		return Run{}, err
	}
	candidate, err := New(input)
	if err != nil {
		return Run{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Run{}, fmt.Errorf("begin run creation: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := insertRunTx(ctx, tx, candidate, s.now); err != nil {
		return Run{}, err
	}
	stored, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1`, candidate.ID))
	if err != nil {
		return Run{}, fmt.Errorf("read created run: %w", err)
	}
	if !sameRunIdentity(candidate, stored) {
		return Run{}, fmt.Errorf("%w: run %q", ErrRunConflict, candidate.ID)
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, fmt.Errorf("commit run creation: %w", err)
	}
	return stored, nil
}

func (s *Store) GetRun(ctx context.Context, runID string) (Run, error) {
	if err := s.ready(ctx); err != nil {
		return Run{}, err
	}
	if strings.TrimSpace(runID) == "" {
		return Run{}, fmt.Errorf("%w: run id is required", ErrInvalidRun)
	}
	run, err := scanRun(s.pool.QueryRow(ctx, runQuery+` WHERE run.id = $1`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrRunNotFound
	}
	return run, err
}

func (s *Store) Start(ctx context.Context, runID, generation, cursor string) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.Start(generation, cursor)
	})
}

func (s *Store) StartWithLease(ctx context.Context, runID, generation, cursor string, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.Start(generation, cursor)
	})
}

func (s *Store) RequestInterrupt(ctx context.Context, runID, generation string) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.RequestInterrupt(generation)
	})
}

func (s *Store) RequestInterruptWithLease(ctx context.Context, runID, generation string, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.RequestInterrupt(generation)
	})
}

func (s *Store) WaitForApproval(ctx context.Context, runID, generation, cursor string) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.WaitForApproval(generation, cursor)
	})
}

func (s *Store) WaitForApprovalWithLease(ctx context.Context, runID, generation, cursor string, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.WaitForApproval(generation, cursor)
	})
}

func (s *Store) ResumeAfterApproval(ctx context.Context, runID, generation, cursor string) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.ResumeAfterApproval(generation, cursor)
	})
}

func (s *Store) ResumeAfterApprovalWithLease(ctx context.Context, runID, generation, cursor string, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.ResumeAfterApproval(generation, cursor)
	})
}

func (s *Store) ObserveTerminal(ctx context.Context, runID, generation string, status protocol.RunStatus, cursor, reason string) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.ObserveTerminal(generation, status, cursor, reason)
	})
}

func (s *Store) ObserveTerminalWithLease(ctx context.Context, runID, generation string, status protocol.RunStatus, cursor, reason string, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.ObserveTerminal(generation, status, cursor, reason)
	})
}

func (s *Store) MarkRunUnknown(ctx context.Context, runID, generation, cursor, reason string) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.MarkUnknown(generation, cursor, reason)
	})
}

func (s *Store) MarkRunUnknownWithLease(ctx context.Context, runID, generation, cursor, reason string, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.MarkUnknown(generation, cursor, reason)
	})
}

func (s *Store) ReconcileRun(ctx context.Context, runID, generation string, observation Observation) (Run, error) {
	return s.transitionRun(ctx, runID, nil, func(current Run) (Run, error) {
		return current.Reconcile(generation, observation)
	})
}

func (s *Store) ReconcileRunWithLease(ctx context.Context, runID, generation string, observation Observation, lease DurableLeaseIdentity) (Run, error) {
	return s.transitionRun(ctx, runID, &lease, func(current Run) (Run, error) {
		return current.Reconcile(generation, observation)
	})
}

func (s *Store) applyObservedRun(ctx context.Context, expected Run, generation string, observation Observation, lease *DurableLeaseIdentity) (Run, error) {
	return s.transitionRunExpected(ctx, expected.ID, lease, &expected, func(current Run) (Run, error) {
		return applyRunObservation(current, generation, observation)
	})
}

// ApplyEvent appends a host observation and applies the Run state transition in
// the same PostgreSQL transaction. A failed transition rolls back the event,
// allowing the Gateway's cursor to remain replayable after reconnect.
func (s *Store) ApplyEvent(ctx context.Context, generation string, input protocol.Event) (protocol.Event, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.Event{}, err
	}
	if strings.TrimSpace(generation) == "" {
		return protocol.Event{}, fmt.Errorf("%w: event generation is required", ErrStaleGeneration)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return protocol.Event{}, fmt.Errorf("begin execution event application: %w", err)
	}
	defer tx.Rollback(ctx)
	var sessionGeneration string
	if err := tx.QueryRow(ctx, `
		SELECT generation
		FROM execution_sessions
		WHERE id = $1
		FOR UPDATE
	`, input.SessionID).Scan(&sessionGeneration); errors.Is(err, pgx.ErrNoRows) {
		return protocol.Event{}, events.ErrEventSessionNotFound
	} else if err != nil {
		return protocol.Event{}, fmt.Errorf("lock event session generation: %w", err)
	}
	if sessionGeneration != generation {
		return protocol.Event{}, fmt.Errorf("%w: event belongs to generation %q", ErrStaleGeneration, sessionGeneration)
	}
	appended, err := events.AppendTx(ctx, tx, input, s.now)
	if err != nil {
		return protocol.Event{}, err
	}
	if appended.Deduplicated {
		if err := tx.Commit(ctx); err != nil {
			return protocol.Event{}, fmt.Errorf("commit duplicate execution event: %w", err)
		}
		return appended.Event, nil
	}
	if input.RunID != nil && strings.TrimSpace(*input.RunID) != "" {
		current, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1 FOR UPDATE`, *input.RunID))
		if errors.Is(err, pgx.ErrNoRows) {
			return protocol.Event{}, ErrRunNotFound
		}
		if err != nil {
			return protocol.Event{}, fmt.Errorf("lock run for event application: %w", err)
		}
		if err := current.CheckGeneration(generation); err != nil {
			return protocol.Event{}, err
		}
		updated, applyErr := applyRunEvent(current, generation, appended.Event)
		if applyErr != nil {
			return protocol.Event{}, applyErr
		}
		if updated != current {
			if updated.UpdatedAt == "" {
				updated.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
			}
			if updated.Status == protocol.RunStatusRunning && current.StartedAt == "" {
				updated.StartedAt = updated.UpdatedAt
			}
			if terminalRunStatus(updated.Status) && current.FinishedAt == "" {
				updated.FinishedAt = updated.UpdatedAt
			}
			if err := updateRunTx(ctx, tx, updated); err != nil {
				return protocol.Event{}, err
			}
			if err := refreshTaskProtectionTx(ctx, tx, updated.SessionID); err != nil {
				return protocol.Event{}, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return protocol.Event{}, fmt.Errorf("commit execution event application: %w", err)
	}
	return appended.Event, nil
}

func (s *Store) ReadEvents(ctx context.Context, query protocol.EventQuery) (protocol.EventPage, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.EventPage{}, err
	}
	return s.events.Read(ctx, query)
}

func (s *Store) transitionRun(ctx context.Context, runID string, lease *DurableLeaseIdentity, apply func(Run) (Run, error)) (Run, error) {
	return s.transitionRunExpected(ctx, runID, lease, nil, apply)
}

func (s *Store) transitionRunExpected(ctx context.Context, runID string, lease *DurableLeaseIdentity, expected *Run, apply func(Run) (Run, error)) (Run, error) {
	if err := s.ready(ctx); err != nil {
		return Run{}, err
	}
	if apply == nil {
		return Run{}, fmt.Errorf("%w: transition callback is required", ErrInvalidRun)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Run{}, fmt.Errorf("begin run transition: %w", err)
	}
	defer tx.Rollback(ctx)
	current, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1 FOR UPDATE`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrRunNotFound
	}
	if err != nil {
		return Run{}, fmt.Errorf("lock run for transition: %w", err)
	}
	if lease != nil {
		if err := leaseMatchesRun(current, *lease); err != nil {
			return Run{}, err
		}
		if err := checkLeaseTx(ctx, tx, *lease); err != nil {
			return Run{}, err
		}
	}
	if expected != nil && *expected != current {
		return Run{}, fmt.Errorf("%w: run %q changed after observation", ErrStaleRunObservation, current.ID)
	}
	updated, err := apply(current)
	if err != nil {
		return Run{}, err
	}
	if updated == current {
		if err := tx.Commit(ctx); err != nil {
			return Run{}, fmt.Errorf("commit idempotent run transition: %w", err)
		}
		return current, nil
	}
	updated.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	if updated.Status == protocol.RunStatusRunning && current.StartedAt == "" {
		updated.StartedAt = updated.UpdatedAt
	}
	if terminalRunStatus(updated.Status) && current.FinishedAt == "" {
		updated.FinishedAt = updated.UpdatedAt
	}
	if err := updateRunTx(ctx, tx, updated); err != nil {
		return Run{}, err
	}
	if err := refreshTaskProtectionTx(ctx, tx, updated.SessionID); err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, fmt.Errorf("commit run transition: %w", err)
	}
	return updated, nil
}

func leaseMatchesRun(current Run, lease DurableLeaseIdentity) error {
	if err := validateLeaseIdentity(lease); err != nil {
		return err
	}
	if lease.RunID != current.ID || lease.SessionID != current.SessionID || lease.Generation != current.Generation {
		return fmt.Errorf("%w: lease identity does not belong to run %q", ErrLeaseLost, current.ID)
	}
	return nil
}

func checkLeaseTx(ctx context.Context, tx pgx.Tx, identity DurableLeaseIdentity) error {
	if err := validateLeaseIdentity(identity); err != nil {
		return err
	}
	var marker int
	err := tx.QueryRow(ctx, `
		SELECT 1
		FROM execution_control_leases
		WHERE lease_key = $1
		  AND session_id = $2
		  AND run_id = $3
		  AND generation = $4
		  AND owner_id = $5
		  AND candidate_source_sha = $6
		  AND artifact_digest = $7
		  AND expires_at > CURRENT_TIMESTAMP
		FOR SHARE
	`, identity.LeaseKey, identity.SessionID, identity.RunID, identity.Generation, identity.OwnerID, identity.CandidateSourceSHA, identity.ArtifactDigest).Scan(&marker)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("check control lease for run transition: %w", err)
	}
	return nil
}

func applyRunEvent(current Run, generation string, event protocol.Event) (Run, error) {
	cursor := event.Cursor
	switch event.Type {
	case protocol.EventTypeRunStarted:
		return current.Start(generation, cursor)
	case protocol.EventTypeApprovalRequested:
		if current.Status == protocol.RunStatusWaitingApproval {
			return current, nil
		}
		return current.WaitForApproval(generation, cursor)
	case protocol.EventTypeRunCompleted:
		return current.ObserveTerminal(generation, protocol.RunStatusCompleted, cursor, "")
	case protocol.EventTypeRunFailed:
		return current.ObserveTerminal(generation, protocol.RunStatusFailed, cursor, "")
	case protocol.EventTypeRunInterrupted:
		return current.ObserveTerminal(generation, protocol.RunStatusInterrupted, cursor, "")
	case protocol.EventTypeReconciliationRequired:
		return current.MarkUnknown(generation, cursor, "reconciliation required by observed event")
	default:
		if terminalRunStatus(current.Status) {
			return current, nil
		}
		current.LastCursor = cursor
		return current, nil
	}
}

func applyRunObservation(current Run, generation string, observation Observation) (Run, error) {
	if err := current.CheckGeneration(generation); err != nil {
		return Run{}, err
	}
	switch observation.Reconciliation {
	case protocol.ReconciliationStateUnknown:
		if terminalRunStatus(current.Status) || current.Status == protocol.RunStatusUnknown {
			return current, nil
		}
		return current.MarkUnknown(generation, observation.Cursor, firstNonEmpty(observation.Reason, "execution outcome is unknown"))
	case protocol.ReconciliationStateNotFound:
		if terminalRunStatus(current.Status) {
			return current, nil
		}
		if current.Status == protocol.RunStatusUnknown {
			return current.Reconcile(generation, observation)
		}
		if current.Status == protocol.RunStatusPending {
			return Run{}, fmt.Errorf("%w: not_found cannot terminate a pending run", ErrInvalidObservation)
		}
		return current.ObserveTerminal(generation, protocol.RunStatusFailed, observation.Cursor, firstNonEmpty(observation.Reason, "execution was not found during observation"))
	case protocol.ReconciliationStateConfirmed:
		switch current.Status {
		case protocol.RunStatusPending:
			if observation.Status != protocol.RunStatusRunning {
				return Run{}, fmt.Errorf("%w: pending run requires a running observation, got %q", ErrInvalidObservation, observation.Status)
			}
			return current.Start(generation, observation.Cursor)
		case protocol.RunStatusRunning:
			switch observation.Status {
			case protocol.RunStatusRunning:
				return current, nil
			case protocol.RunStatusWaitingApproval:
				return current.WaitForApproval(generation, observation.Cursor)
			case protocol.RunStatusCompleted, protocol.RunStatusFailed, protocol.RunStatusInterrupted:
				return current.ObserveTerminal(generation, observation.Status, observation.Cursor, observation.Reason)
			default:
				return Run{}, fmt.Errorf("%w: running run cannot become %q", ErrInvalidObservation, observation.Status)
			}
		case protocol.RunStatusWaitingApproval:
			switch observation.Status {
			case protocol.RunStatusWaitingApproval:
				return current, nil
			case protocol.RunStatusCompleted, protocol.RunStatusFailed, protocol.RunStatusInterrupted:
				return current.ObserveTerminal(generation, observation.Status, observation.Cursor, observation.Reason)
			default:
				return Run{}, fmt.Errorf("%w: waiting-approval run cannot become %q", ErrInvalidObservation, observation.Status)
			}
		case protocol.RunStatusUnknown:
			return current.Reconcile(generation, observation)
		default:
			return current, nil
		}
	default:
		return Run{}, fmt.Errorf("%w: unsupported reconciliation state %q", ErrInvalidObservation, observation.Reconciliation)
	}
}

func insertRunTx(ctx context.Context, tx pgx.Tx, candidate Run, now func() time.Time) error {
	createdAt := candidate.CreatedAt
	if createdAt == "" {
		createdAt = now().UTC().Format(time.RFC3339Nano)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO execution_runs (
			id, session_id, command_id, generation, status, interrupt_state,
			last_cursor, terminal_reason, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, CURRENT_TIMESTAMP)
		ON CONFLICT (id) DO NOTHING
	`, candidate.ID, candidate.SessionID, candidate.CommandID, candidate.Generation, candidate.Status, candidate.Interrupt, candidate.LastCursor, candidate.TerminalReason, createdAt)
	if err != nil {
		return fmt.Errorf("persist run: %w", err)
	}
	return nil
}

func sameRunIdentity(left, right Run) bool {
	return left.ID == right.ID && left.SessionID == right.SessionID && left.CommandID == right.CommandID && left.Generation == right.Generation
}

func updateRunTx(ctx context.Context, tx pgx.Tx, run Run) error {
	_, err := tx.Exec(ctx, `
		UPDATE execution_runs
		SET status = $2,
		    interrupt_state = $3,
		    last_cursor = $4,
		    terminal_reason = $5,
		    started_at = NULLIF($6, '')::timestamptz,
		    finished_at = NULLIF($7, '')::timestamptz,
		    updated_at = $8::timestamptz
		WHERE id = $1 AND generation = $9
	`, run.ID, run.Status, run.Interrupt, run.LastCursor, run.TerminalReason, run.StartedAt, run.FinishedAt, run.UpdatedAt, run.Generation)
	if err != nil {
		return fmt.Errorf("persist run transition: %w", err)
	}
	return nil
}

func refreshTaskProtectionTx(ctx context.Context, tx pgx.Tx, sessionID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE task_execution_refs AS ref
		SET active_execution = EXISTS (
			SELECT 1
			FROM tasks AS task
			JOIN execution_runs AS run ON run.session_id = task.session_id
			WHERE task.id = ref.task_id
			  AND task.session_id = $1
			  AND run.status IN ('pending', 'running', 'waiting_approval', 'unknown')
		),
		retained_history = EXISTS (
			SELECT 1
			FROM tasks AS task
			JOIN execution_runs AS run ON run.session_id = task.session_id
			WHERE task.id = ref.task_id
			  AND task.session_id = $1
		),
		updated_at = CURRENT_TIMESTAMP
		WHERE ref.task_id IN (SELECT id FROM tasks WHERE session_id = $1)
	`, sessionID)
	if err != nil {
		return fmt.Errorf("refresh task execution protection: %w", err)
	}
	return nil
}

const runQuery = `
	SELECT run.id, run.session_id, run.command_id, run.generation,
	       run.status, run.interrupt_state, run.last_cursor,
	       run.terminal_reason, run.created_at, run.started_at,
	       run.finished_at, run.updated_at
	FROM execution_runs AS run
`

func scanRun(row interface{ Scan(...any) error }) (Run, error) {
	var run Run
	var createdAt, updatedAt time.Time
	var startedAt, finishedAt *time.Time
	if err := row.Scan(
		&run.ID, &run.SessionID, &run.CommandID, &run.Generation,
		&run.Status, &run.Interrupt, &run.LastCursor, &run.TerminalReason,
		&createdAt, &startedAt, &finishedAt, &updatedAt,
	); err != nil {
		return Run{}, err
	}
	run.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	run.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	if startedAt != nil {
		run.StartedAt = startedAt.UTC().Format(time.RFC3339Nano)
	}
	if finishedAt != nil {
		run.FinishedAt = finishedAt.UTC().Format(time.RFC3339Nano)
	}
	return run, nil
}

const commandQuery = `
	SELECT command.command_id, command.session_id, command.run_id,
	       command.generation, command.kind, command.issued_at,
	       command.payload, command.digest, command.state, command.received_at,
	       command.operation_id, command.result, command.error,
	       command.event_cursor, command.reconciliation_state
	FROM execution_commands AS command
`

func (s *Store) acceptTx(ctx context.Context, tx pgx.Tx, intent CommandIntent) (AcceptResult, error) {
	if err := ValidateIntent(intent); err != nil {
		return AcceptResult{}, err
	}
	if intent.ReceivedAt == "" {
		intent.ReceivedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	digest, err := Fingerprint(intent)
	if err != nil {
		return AcceptResult{}, err
	}
	commandResult, err := tx.Exec(ctx, `
		INSERT INTO execution_commands (
			command_id, session_id, run_id, generation, kind, issued_at,
			payload, digest, state, received_at
		)
		VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, 'accepted', $9)
		ON CONFLICT (command_id) DO NOTHING
	`, intent.Command.CommandID, intent.Command.SessionID, optionalRunID(intent.Command.RunID), intent.Generation, intent.Command.Kind, intent.Command.IssuedAt, []byte(intent.Command.Payload), digest, intent.ReceivedAt)
	if err != nil {
		return AcceptResult{}, fmt.Errorf("persist command intent: %w", err)
	}
	record, err := scanCommand(tx.QueryRow(ctx, commandQuery+` WHERE command.command_id = $1 FOR UPDATE`, intent.Command.CommandID))
	if err != nil {
		return AcceptResult{}, fmt.Errorf("read accepted command: %w", err)
	}
	if record.Intent.Generation != intent.Generation {
		return AcceptResult{}, fmt.Errorf("%w: command %q belongs to generation %q", ErrStaleGeneration, intent.Command.CommandID, record.Intent.Generation)
	}
	if record.Digest != digest {
		return AcceptResult{}, fmt.Errorf("%w: command %q has a different payload or identity", protocol.ErrIdempotencyConflict, intent.Command.CommandID)
	}
	return AcceptResult{Record: record, Deduplicated: commandResult.RowsAffected() == 0}, nil
}

func scanCommand(row interface{ Scan(...any) error }) (CommandRecord, error) {
	var record CommandRecord
	var runID *string
	var kind, digest, state, issuedAt, receivedAt, operationID, eventCursor, reconciliationState string
	var payload []byte
	var resultPayload, errorPayload []byte
	if err := row.Scan(
		&record.Intent.Command.CommandID, &record.Intent.Command.SessionID, &runID,
		&record.Intent.Generation, &kind, &issuedAt, &payload, &digest, &state,
		&receivedAt, &operationID, &resultPayload, &errorPayload, &eventCursor, &reconciliationState,
	); err != nil {
		return CommandRecord{}, err
	}
	record.Intent.Command.Kind = protocol.CommandKind(kind)
	record.Intent.Command.IssuedAt = issuedAt
	record.Intent.Command.Payload = append(json.RawMessage(nil), payload...)
	record.Intent.Command.RunID = runID
	record.Digest = digest
	record.State = protocol.CommandState(state)
	record.ReceivedAt = receivedAt
	record.Intent.ReceivedAt = receivedAt
	record.OperationID = operationID
	record.EventCursor = eventCursor
	record.ReconciliationState = protocol.ReconciliationState(reconciliationState)
	record.Result = append(json.RawMessage(nil), resultPayload...)
	if len(errorPayload) > 0 {
		var apiError protocol.ApiError
		if err := json.Unmarshal(errorPayload, &apiError); err != nil {
			return CommandRecord{}, fmt.Errorf("decode command error: %w", err)
		}
		record.Error = &apiError
	}
	return record, nil
}

func updateCommandTx(ctx context.Context, tx pgx.Tx, record CommandRecord, reconciliationState string) error {
	var errorPayload []byte
	if record.Error != nil {
		var err error
		errorPayload, err = json.Marshal(record.Error)
		if err != nil {
			return fmt.Errorf("encode command error: %w", err)
		}
	}
	if reconciliationState == "" {
		reconciliationState = string(record.ReconciliationState)
	}
	_, err := tx.Exec(ctx, `
		UPDATE execution_commands
		SET state = $2,
		    operation_id = $3,
		    result = $4,
		    error = $5,
		    event_cursor = $6,
		    reconciliation_state = $7,
		    reconciled_at = CASE WHEN $7 <> '' THEN CURRENT_TIMESTAMP ELSE reconciled_at END,
		    updated_at = CURRENT_TIMESTAMP
		WHERE command_id = $1 AND generation = $8
	`, record.Intent.Command.CommandID, record.State, record.OperationID, []byte(record.Result), errorPayload, record.EventCursor, reconciliationState, record.Intent.Generation)
	if err != nil {
		return fmt.Errorf("persist command state: %w", err)
	}
	return nil
}

func checkCommandGeneration(record CommandRecord, generation string) error {
	if strings.TrimSpace(generation) == "" {
		return fmt.Errorf("%w: generation is required", ErrStaleGeneration)
	}
	if record.Intent.Generation != generation {
		return fmt.Errorf("%w: got %q, command belongs to %q", ErrStaleGeneration, generation, record.Intent.Generation)
	}
	return nil
}

func optionalRunID(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *Store) ready(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("run store database is not configured")
	}
	if ctx == nil {
		return errors.New("run context must not be nil")
	}
	return nil
}
