package runs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/events"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrRunNotFound         = errors.New("run is not present in persistence")
	ErrRunConflict         = errors.New("run identity conflicts with persisted state")
	ErrStaleRunObservation = errors.New("run observation is stale")
	ErrApprovalEvent       = errors.New("approval event is invalid")
	ErrCommandFactConflict = errors.New("command acknowledgement fact conflicts with persistence")
)

type RunJobEnqueuer func(context.Context, pgx.Tx, RunJobArgs) error

type StoreConfig struct {
	Now             func() time.Time
	EnqueueRunJobTx RunJobEnqueuer
}

// Store is the durable execution boundary. Command acceptance is committed
// before a caller crosses a Gateway or Connector side-effect boundary; event
// application can then update the Run and task protection in the same commit.
type Store struct {
	pool          *pgxpool.Pool
	now           func() time.Time
	enqueueRunJob RunJobEnqueuer
	events        *events.Store
	approvalStore *approvals.Store
}

// ApprovalTransactionResolver applies an approval CAS to a transaction owned
// by the Run store. Keeping this interface narrow prevents the admission path
// from depending on the approval store's connection-pool lifecycle.
type ApprovalTransactionResolver interface {
	ResolveTx(context.Context, pgx.Tx, approvals.ResolveRequest) (approvals.Resolution, error)
}

func NewStore(pool *pgxpool.Pool, configs ...StoreConfig) *Store {
	now := time.Now
	if len(configs) > 0 && configs[0].Now != nil {
		now = configs[0].Now
	}
	var enqueueRunJob RunJobEnqueuer
	if len(configs) > 0 {
		enqueueRunJob = configs[0].EnqueueRunJobTx
	}
	return &Store{pool: pool, now: now, enqueueRunJob: enqueueRunJob, events: events.NewStore(pool, events.StoreConfig{Now: now}), approvalStore: approvals.NewStore(pool, approvals.StoreConfig{Now: now})}
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

// AcceptInterrupt commits the interrupt command and the Run's interrupt
// reservation together. A failed validation or commit rolls back both writes,
// so a retry cannot observe a consumed interrupt without a command ledger row.
func (s *Store) AcceptInterrupt(ctx context.Context, intent CommandIntent) (AcceptResult, error) {
	return s.acceptInterrupt(ctx, intent, nil)
}

func (s *Store) AcceptInterruptWithLease(ctx context.Context, intent CommandIntent, lease DurableLeaseIdentity) (AcceptResult, error) {
	return s.acceptInterrupt(ctx, intent, &lease)
}

func (s *Store) acceptInterrupt(ctx context.Context, intent CommandIntent, lease *DurableLeaseIdentity) (AcceptResult, error) {
	if err := s.ready(ctx); err != nil {
		return AcceptResult{}, err
	}
	if intent.Command.Kind != protocol.CommandKindRunInterrupt {
		return AcceptResult{}, fmt.Errorf("%w: interrupt admission requires %q", ErrInvalidCommand, protocol.CommandKindRunInterrupt)
	}
	if intent.Command.RunID == nil || strings.TrimSpace(*intent.Command.RunID) == "" {
		return AcceptResult{}, fmt.Errorf("%w: interrupt command requires run id", ErrInvalidCommand)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcceptResult{}, fmt.Errorf("begin interrupt acceptance: %w", err)
	}
	defer tx.Rollback(ctx)
	if lease != nil {
		if err := validateLeaseIdentity(*lease); err != nil {
			return AcceptResult{}, err
		}
	}
	accepted, err := s.acceptTx(ctx, tx, intent)
	if err != nil {
		return AcceptResult{}, err
	}
	if accepted.Deduplicated {
		if err := tx.Commit(ctx); err != nil {
			return AcceptResult{}, fmt.Errorf("commit duplicate interrupt acceptance: %w", err)
		}
		return accepted, nil
	}
	runID := *intent.Command.RunID
	if lease != nil {
		if _, err := acquireLeaseTx(ctx, tx, *lease, defaultControlLeaseTTL); err != nil {
			return AcceptResult{}, err
		}
	}
	current, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1 FOR UPDATE`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptResult{}, ErrRunNotFound
	}
	if err != nil {
		return AcceptResult{}, fmt.Errorf("lock run for interrupt acceptance: %w", err)
	}
	if current.SessionID != intent.Command.SessionID {
		return AcceptResult{}, fmt.Errorf("%w: run %q belongs to session %q", ErrRunConflict, current.ID, current.SessionID)
	}
	updated, err := current.RequestInterrupt(intent.Generation)
	if err != nil {
		return AcceptResult{}, err
	}
	updated.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	if err := updateRunTx(ctx, tx, updated); err != nil {
		return AcceptResult{}, err
	}
	if err := refreshTaskProtectionTx(ctx, tx, updated.SessionID); err != nil {
		return AcceptResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptResult{}, fmt.Errorf("commit command and interrupt acceptance: %w", err)
	}
	return accepted, nil
}

// AcceptApproval commits the approval command and its pending+revision CAS in
// one transaction. The command row is locked before the approval row so races
// on a shared command ID cannot consume a different approval.
func (s *Store) AcceptApproval(ctx context.Context, resolver ApprovalTransactionResolver, intent CommandIntent, request approvals.ResolveRequest) (AcceptResult, approvals.Resolution, error) {
	return s.acceptApproval(ctx, resolver, intent, request, nil)
}

func (s *Store) AcceptApprovalWithLease(ctx context.Context, resolver ApprovalTransactionResolver, intent CommandIntent, request approvals.ResolveRequest, lease DurableLeaseIdentity) (AcceptResult, approvals.Resolution, error) {
	return s.acceptApproval(ctx, resolver, intent, request, &lease)
}

func (s *Store) acceptApproval(ctx context.Context, resolver ApprovalTransactionResolver, intent CommandIntent, request approvals.ResolveRequest, lease *DurableLeaseIdentity) (AcceptResult, approvals.Resolution, error) {
	if err := s.ready(ctx); err != nil {
		return AcceptResult{}, approvals.Resolution{}, err
	}
	if resolver == nil {
		return AcceptResult{}, approvals.Resolution{}, errors.New("approval transaction resolver is required")
	}
	if err := validateApprovalCommandIntent(intent, request); err != nil {
		return AcceptResult{}, approvals.Resolution{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcceptResult{}, approvals.Resolution{}, fmt.Errorf("begin approval command acceptance: %w", err)
	}
	defer tx.Rollback(ctx)
	if lease != nil {
		if err := validateLeaseIdentity(*lease); err != nil {
			return AcceptResult{}, approvals.Resolution{}, err
		}
	}
	accepted, err := s.acceptTx(ctx, tx, intent)
	if err != nil {
		return AcceptResult{}, approvals.Resolution{}, err
	}
	if accepted.Deduplicated && accepted.Record.State == protocol.CommandStateUnknown {
		if err := tx.Commit(ctx); err != nil {
			return AcceptResult{}, approvals.Resolution{}, fmt.Errorf("commit unknown approval command lookup: %w", err)
		}
		return accepted, approvals.Resolution{}, nil
	}
	if lease != nil && !accepted.Deduplicated && !isTerminalCommandState(accepted.Record.State) {
		if _, err := acquireLeaseTx(ctx, tx, *lease, defaultControlLeaseTTL); err != nil {
			return AcceptResult{}, approvals.Resolution{}, err
		}
	}
	resolution, err := resolver.ResolveTx(ctx, tx, request)
	if err != nil {
		return AcceptResult{}, approvals.Resolution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptResult{}, approvals.Resolution{}, fmt.Errorf("commit approval command acceptance: %w", err)
	}
	return accepted, resolution, nil
}

// AcceptRun commits a command and its pending Run identity together. This is
// the Server-side boundary used before a run is enqueued into River.
func (s *Store) AcceptRun(ctx context.Context, intent CommandIntent, input NewRunInput) (AcceptResult, Run, error) {
	return s.acceptRun(ctx, intent, input, nil)
}

func (s *Store) AcceptRunWithLease(ctx context.Context, intent CommandIntent, input NewRunInput, lease DurableLeaseIdentity) (AcceptResult, Run, error) {
	return s.acceptRun(ctx, intent, input, &lease)
}

func (s *Store) acceptRun(ctx context.Context, intent CommandIntent, input NewRunInput, lease *DurableLeaseIdentity) (AcceptResult, Run, error) {
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
	if lease != nil {
		if err := validateLeaseIdentity(*lease); err != nil {
			return AcceptResult{}, Run{}, err
		}
	}
	if err := ValidateIntent(intent); err != nil {
		return AcceptResult{}, Run{}, err
	}
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
	if lease != nil && !accepted.Deduplicated {
		if _, err := acquireLeaseTx(ctx, tx, *lease, defaultControlLeaseTTL); err != nil {
			return AcceptResult{}, Run{}, err
		}
	}
	if !accepted.Deduplicated && s.enqueueRunJob != nil {
		if err := s.enqueueRunJob(ctx, tx, RunJobArgs{RunID: stored.ID, Generation: stored.Generation, LeaseKey: RunLeaseKey(stored.ID)}); err != nil {
			return AcceptResult{}, Run{}, fmt.Errorf("enqueue accepted run: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptResult{}, Run{}, fmt.Errorf("commit command and run acceptance: %w", err)
	}
	return accepted, stored, nil
}

func (s *Store) Lookup(ctx context.Context, platformSessionID, commandID string) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	if strings.TrimSpace(platformSessionID) == "" || strings.TrimSpace(commandID) == "" {
		return CommandRecord{}, fmt.Errorf("%w: platform session and command id are required", ErrCommandNotFound)
	}
	record, err := scanCommand(s.pool.QueryRow(ctx, commandQuery+` WHERE command.session_id = $1 AND command.command_id = $2`, platformSessionID, commandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, ErrCommandNotFound
	}
	return record, err
}

// RecordExactCommandAck persists a Connector ACK as a durable fact without
// using the command transition state machine. This is the path for a late ACK
// after in-memory delivery state has disappeared; it never changes the Run.
func (s *Store) RecordExactCommandAck(ctx context.Context, platformSessionID string, ack protocol.CommandAck) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	if strings.TrimSpace(platformSessionID) == "" || strings.TrimSpace(ack.CommandID) == "" || ack.CommandID != strings.TrimSpace(ack.CommandID) {
		return CommandRecord{}, fmt.Errorf("%w: platform session and command id are required", ErrCommandFactConflict)
	}
	if !validCommandState(ack.State) || ack.State == protocol.CommandStateUnknown {
		return CommandRecord{}, fmt.Errorf("%w: ACK state %q is not an exact fact", protocol.ErrUnknownCommandResult, ack.State)
	}
	effectiveState := ack.State
	if effectiveState == protocol.CommandStateAccepted {
		effectiveState = protocol.CommandStateExecuting
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin exact command ACK persistence: %w", err)
	}
	defer tx.Rollback(ctx)
	record, err := scanCommand(tx.QueryRow(ctx, commandQuery+` WHERE command.session_id = $1 AND command.command_id = $2 FOR UPDATE`, platformSessionID, ack.CommandID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, ErrCommandNotFound
	}
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock exact command ACK: %w", err)
	}
	if ack.RunID != nil && optionalRunID(record.Intent.Command.RunID) != *ack.RunID {
		return CommandRecord{}, fmt.Errorf("%w: ACK run id does not match command %q", ErrCommandFactConflict, ack.CommandID)
	}
	if err := validateCommandRunIdentityTx(ctx, tx, record); err != nil {
		return CommandRecord{}, err
	}
	incoming := cloneRecord(record)
	incoming.State = effectiveState
	incoming.OperationID = optionalStringValue(ack.OperationID)
	incoming.EventCursor = optionalStringValue(ack.EventCursor)
	incoming.Result = append(json.RawMessage(nil), ack.Result...)
	incoming.Error = cloneAPIError(ack.Error)
	incoming.ReconciliationState = ""
	if commandFactPresent(record) {
		if !sameCommandFact(record, incoming) {
			return CommandRecord{}, fmt.Errorf("%w: command %q already has a different exact ACK", ErrCommandFactConflict, ack.CommandID)
		}
		if err := tx.Commit(ctx); err != nil {
			return CommandRecord{}, fmt.Errorf("commit duplicate exact command ACK: %w", err)
		}
		return record, nil
	}
	if record.State != protocol.CommandStateUnknown && !allowedCommandTransition(record.State, effectiveState) && record.State != effectiveState {
		return CommandRecord{}, fmt.Errorf("%w: %s -> %s", ErrCommandFactConflict, record.State, effectiveState)
	}
	if isTerminalCommandState(record.State) && record.State != effectiveState {
		return CommandRecord{}, fmt.Errorf("%w: terminal command %q cannot become %q", ErrCommandFactConflict, ack.CommandID, effectiveState)
	}
	if err := updateCommandTx(ctx, tx, incoming, ""); err != nil {
		return CommandRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandRecord{}, fmt.Errorf("commit exact command ACK: %w", err)
	}
	return incoming, nil
}

func commandFactPresent(record CommandRecord) bool {
	return isTerminalCommandState(record.State) || record.OperationID != "" || record.EventCursor != "" || len(record.Result) > 0 || record.Error != nil
}

func sameCommandFact(left, right CommandRecord) bool {
	return left.State == right.State && left.OperationID == right.OperationID && left.EventCursor == right.EventCursor && bytes.Equal(left.Result, right.Result) && sameAPIError(left.Error, right.Error)
}

func sameAPIError(left, right *protocol.ApiError) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return bytes.Equal(leftJSON, rightJSON)
}

func validateCommandRunIdentityTx(ctx context.Context, tx pgx.Tx, record CommandRecord) error {
	runID := optionalRunID(record.Intent.Command.RunID)
	if runID == "" {
		return nil
	}
	var runSessionID, runCommandID, runGeneration string
	err := tx.QueryRow(ctx, `
		SELECT session_id, command_id, generation
		FROM execution_runs
		WHERE id = $1
		FOR SHARE
	`, runID).Scan(&runSessionID, &runCommandID, &runGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: command %q run %q is not persisted", ErrCommandFactConflict, record.Intent.Command.CommandID, runID)
	}
	if err != nil {
		return fmt.Errorf("validate exact command ACK run identity: %w", err)
	}
	identityMatches := runSessionID == record.Intent.Command.SessionID && runGeneration == record.Intent.Generation
	if record.Intent.Command.Kind == protocol.CommandKindRunSend {
		identityMatches = identityMatches && runCommandID == record.Intent.Command.CommandID
	}
	if !identityMatches {
		return fmt.Errorf("%w: command %q does not own run %q", ErrCommandFactConflict, record.Intent.Command.CommandID, runID)
	}
	return nil
}

func (s *Store) Transition(ctx context.Context, commandID, generation string, next protocol.CommandState, operationID string, result json.RawMessage, apiError *protocol.ApiError) (CommandRecord, error) {
	return s.transitionCommand(ctx, commandID, generation, next, operationID, result, apiError, nil)
}

func (s *Store) TransitionWithLease(ctx context.Context, commandID, generation string, next protocol.CommandState, operationID string, result json.RawMessage, apiError *protocol.ApiError, lease DurableLeaseIdentity) (CommandRecord, error) {
	return s.transitionCommand(ctx, commandID, generation, next, operationID, result, apiError, &lease)
}

func (s *Store) transitionCommand(ctx context.Context, commandID, generation string, next protocol.CommandState, operationID string, result json.RawMessage, apiError *protocol.ApiError, lease *DurableLeaseIdentity) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin command transition: %w", err)
	}
	defer tx.Rollback(ctx)
	record, _, err := lockCommandAndRun(ctx, tx, commandID)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock command transition: %w", err)
	}
	if err := checkCommandGeneration(record, generation); err != nil {
		return CommandRecord{}, err
	}
	if lease != nil {
		if err := leaseMatchesCommand(record, *lease); err != nil {
			return CommandRecord{}, err
		}
		if err := checkLeaseTx(ctx, tx, *lease); err != nil {
			return CommandRecord{}, err
		}
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

// MarkCommandAndRunUnknown converges a command and its associated Run in one
// transaction. The session is locked before the command so recovery and
// admission share one order, followed by the associated run and lease checks.
func (s *Store) MarkCommandAndRunUnknown(ctx context.Context, commandID, generation, reason string) (CommandRecord, error) {
	return s.markCommandAndRunUnknown(ctx, commandID, generation, reason, nil)
}

func (s *Store) MarkCommandAndRunUnknownWithLease(ctx context.Context, commandID, generation, reason string, lease DurableLeaseIdentity) (CommandRecord, error) {
	return s.markCommandAndRunUnknown(ctx, commandID, generation, reason, &lease)
}

func (s *Store) markCommandAndRunUnknown(ctx context.Context, commandID, generation, reason string, lease *DurableLeaseIdentity) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin command and run unknown transition: %w", err)
	}
	defer tx.Rollback(ctx)

	record, currentRun, err := lockCommandAndRun(ctx, tx, commandID)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock command and run unknown transition: %w", err)
	}
	if err := checkCommandGeneration(record, generation); err != nil {
		return CommandRecord{}, err
	}
	if lease != nil {
		if err := leaseMatchesCommand(record, *lease); err != nil {
			return CommandRecord{}, err
		}
	}

	if !isTerminalCommandState(record.State) && record.State != protocol.CommandStateUnknown {
		record.State = protocol.CommandStateUnknown
		record.OperationID = ""
		record.Result = nil
		record.Error = nil
		if err := updateCommandTx(ctx, tx, record, ""); err != nil {
			return CommandRecord{}, err
		}
	}

	runID := optionalRunID(record.Intent.Command.RunID)
	if runID != "" {
		current := *currentRun
		if lease != nil {
			if err := checkLeaseTx(ctx, tx, *lease); err != nil {
				return CommandRecord{}, err
			}
		}
		if isTerminalCommandState(record.State) {
			if err := tx.Commit(ctx); err != nil {
				return CommandRecord{}, fmt.Errorf("commit terminal command and run lookup: %w", err)
			}
			return record, nil
		}
		identityMatches := current.SessionID == record.Intent.Command.SessionID && current.Generation == record.Intent.Generation
		if record.Intent.Command.Kind == protocol.CommandKindRunSend {
			identityMatches = identityMatches && current.CommandID == record.Intent.Command.CommandID
		}
		if !identityMatches {
			return CommandRecord{}, fmt.Errorf("%w: command %q is not associated with run %q", ErrRunConflict, record.Intent.Command.CommandID, runID)
		}
		updated, err := current.MarkUnknown(generation, "", reason)
		if err != nil {
			return CommandRecord{}, err
		}
		if updated != current {
			updated.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
			if err := updateRunTx(ctx, tx, updated); err != nil {
				return CommandRecord{}, err
			}
		}
		if err := refreshTaskProtectionTx(ctx, tx, updated.SessionID); err != nil {
			return CommandRecord{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return CommandRecord{}, fmt.Errorf("commit command and run unknown transition: %w", err)
	}
	return record, nil
}

func (s *Store) Reconcile(ctx context.Context, commandID, generation string, observation CommandObservation) (CommandRecord, error) {
	return s.reconcile(ctx, commandID, generation, observation, nil)
}

func (s *Store) ReconcileWithLease(ctx context.Context, commandID, generation string, observation CommandObservation, lease DurableLeaseIdentity) (CommandRecord, error) {
	return s.reconcile(ctx, commandID, generation, observation, &lease)
}

func (s *Store) reconcile(ctx context.Context, commandID, generation string, observation CommandObservation, lease *DurableLeaseIdentity) (CommandRecord, error) {
	if err := s.ready(ctx); err != nil {
		return CommandRecord{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("begin command reconciliation: %w", err)
	}
	defer tx.Rollback(ctx)
	record, _, err := lockCommandAndRun(ctx, tx, commandID)
	if err != nil {
		return CommandRecord{}, fmt.Errorf("lock command reconciliation: %w", err)
	}
	if err := checkCommandGeneration(record, generation); err != nil {
		return CommandRecord{}, err
	}
	if lease != nil {
		if err := leaseMatchesCommand(record, *lease); err != nil {
			return CommandRecord{}, err
		}
		if err := checkLeaseTx(ctx, tx, *lease); err != nil {
			return CommandRecord{}, err
		}
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
	return s.applyObservedRunWithFence(ctx, expected, generation, observation, nil, lease)
}

func (s *Store) applyObservedRunWithFence(ctx context.Context, expected Run, generation string, observation Observation, deploymentFence func(context.Context, pgx.Tx) error, lease *DurableLeaseIdentity) (Run, error) {
	return s.transitionRunExpectedWithFence(ctx, expected.ID, lease, &expected, deploymentFence, func(current Run) (Run, error) {
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

// ApplyApprovalRequestedEvent appends an approval.requested event, moves the
// Run to waiting_approval, and persists its normalized Approval in one
// transaction. The payload remains opaque; callers provide the normalized
// CreateRequest after interpreting the external event.
//
// Lock order is execution_sessions -> execution_runs -> execution_approvals.
func (s *Store) ApplyApprovalRequestedEvent(ctx context.Context, generation string, input protocol.Event, request approvals.CreateRequest) (protocol.Event, approvals.Approval, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.Event{}, approvals.Approval{}, err
	}
	if err := validateApprovalRequestedEvent(generation, input, request); err != nil {
		return protocol.Event{}, approvals.Approval{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("begin approval event application: %w", err)
	}
	defer tx.Rollback(ctx)
	var sessionGeneration string
	if err := tx.QueryRow(ctx, `
		SELECT generation
		FROM execution_sessions
		WHERE id = $1
		FOR UPDATE
	`, input.SessionID).Scan(&sessionGeneration); errors.Is(err, pgx.ErrNoRows) {
		return protocol.Event{}, approvals.Approval{}, events.ErrEventSessionNotFound
	} else if err != nil {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("lock approval event session generation: %w", err)
	}
	if sessionGeneration != generation {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("%w: event belongs to generation %q", ErrStaleGeneration, sessionGeneration)
	}
	appended, err := events.AppendTx(ctx, tx, input, s.now)
	if err != nil {
		return protocol.Event{}, approvals.Approval{}, err
	}
	if appended.Event.EventID != request.RequestedEventID {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("%w: requested event id %q does not match event %q", approvals.ErrApprovalContext, request.RequestedEventID, appended.Event.EventID)
	}
	runID := *input.RunID
	current, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1 FOR UPDATE`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return protocol.Event{}, approvals.Approval{}, ErrRunNotFound
	}
	if err != nil {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("lock run for approval event application: %w", err)
	}
	if current.SessionID != input.SessionID {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("%w: run %q belongs to session %q", ErrRunConflict, current.ID, current.SessionID)
	}
	if err := current.CheckGeneration(generation); err != nil {
		return protocol.Event{}, approvals.Approval{}, err
	}
	if !appended.Deduplicated {
		updated, applyErr := applyRunEvent(current, generation, appended.Event)
		if applyErr != nil {
			return protocol.Event{}, approvals.Approval{}, applyErr
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
				return protocol.Event{}, approvals.Approval{}, err
			}
			if err := refreshTaskProtectionTx(ctx, tx, updated.SessionID); err != nil {
				return protocol.Event{}, approvals.Approval{}, err
			}
		}
	}
	created, err := s.approvalStore.CreateTx(ctx, tx, request)
	if err != nil {
		return protocol.Event{}, approvals.Approval{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return protocol.Event{}, approvals.Approval{}, fmt.Errorf("commit approval event application: %w", err)
	}
	return appended.Event, created, nil
}

func validateApprovalRequestedEvent(generation string, input protocol.Event, request approvals.CreateRequest) error {
	if strings.TrimSpace(generation) == "" {
		return fmt.Errorf("%w: event generation is required", ErrStaleGeneration)
	}
	if input.Type != protocol.EventTypeApprovalRequested {
		return fmt.Errorf("%w: got event type %q", ErrApprovalEvent, input.Type)
	}
	if input.RunID == nil || strings.TrimSpace(*input.RunID) == "" {
		return fmt.Errorf("%w: run id is required", ErrApprovalEvent)
	}
	if strings.TrimSpace(request.RequestedEventID) == "" {
		return fmt.Errorf("%w: requested event id is required", approvals.ErrInvalidApproval)
	}
	if request.NewInput.SessionID != input.SessionID || request.NewInput.RunID != *input.RunID {
		return fmt.Errorf("%w: approval and event identities differ", approvals.ErrApprovalContext)
	}
	if request.NewInput.Generation != generation {
		return fmt.Errorf("%w: got %q, want %q", approvals.ErrApprovalGeneration, request.NewInput.Generation, generation)
	}
	if input.EventID != "" && request.RequestedEventID != input.EventID {
		return fmt.Errorf("%w: requested event id %q does not match event %q", approvals.ErrApprovalContext, request.RequestedEventID, input.EventID)
	}
	return nil
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
	return s.transitionRunExpectedWithFence(ctx, runID, lease, expected, nil, apply)
}

func (s *Store) transitionRunExpectedWithFence(ctx context.Context, runID string, lease *DurableLeaseIdentity, expected *Run, deploymentFence func(context.Context, pgx.Tx) error, apply func(Run) (Run, error)) (Run, error) {
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
	if lease != nil {
		// A leased transition participates in the same session -> run -> lease
		// order as admission and event application.
		if err := lockLeaseBinding(ctx, tx, *lease); err != nil {
			return Run{}, err
		}
	}
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
	if deploymentFence != nil {
		if err := deploymentFence(ctx, tx); err != nil {
			return Run{}, err
		}
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

func leaseMatchesCommand(record CommandRecord, lease DurableLeaseIdentity) error {
	if err := validateLeaseIdentity(lease); err != nil {
		return err
	}
	if record.Intent.Command.RunID == nil || *record.Intent.Command.RunID == "" ||
		lease.SessionID != record.Intent.Command.SessionID ||
		lease.RunID != *record.Intent.Command.RunID ||
		lease.Generation != record.Intent.Generation {
		return fmt.Errorf("%w: lease identity does not belong to command %q", ErrLeaseLost, record.Intent.Command.CommandID)
	}
	return nil
}

func checkLeaseTx(ctx context.Context, tx pgx.Tx, identity DurableLeaseIdentity) error {
	if err := validateLeaseIdentity(identity); err != nil {
		return err
	}
	var expiresAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT expires_at
		FROM execution_control_leases
		WHERE lease_key = $1
		  AND session_id = $2
		  AND run_id = $3
		  AND generation = $4
		  AND owner_id = $5
		  AND candidate_source_sha = $6
		  AND artifact_digest = $7
		FOR SHARE
	`, identity.LeaseKey, identity.SessionID, identity.RunID, identity.Generation, identity.OwnerID, identity.CandidateSourceSHA, identity.ArtifactDigest).Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("check control lease for run transition: %w", err)
	}
	now, err := databaseClock(ctx, tx)
	if err != nil {
		return err
	}
	if !expiresAt.After(now) {
		return ErrLeaseLost
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

func lockSessionForRunAdmission(ctx context.Context, tx pgx.Tx, sessionID, generation string) error {
	var currentGeneration string
	err := tx.QueryRow(ctx, `
		SELECT generation
		FROM execution_sessions
		WHERE id = $1
		FOR UPDATE
	`, sessionID).Scan(&currentGeneration)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: session %q is not persisted", ErrRunConflict, sessionID)
	}
	if err != nil {
		return fmt.Errorf("lock session for run admission: %w", err)
	}
	if currentGeneration != generation {
		return fmt.Errorf("%w: session %q belongs to generation %q", ErrStaleGeneration, sessionID, currentGeneration)
	}
	return nil
}

// lockCommandAndRun establishes the shared session -> command -> run order
// used by admission, recovery, and leased command transitions. The initial
// identity read is intentionally unlocked so no path holds a command lock
// while waiting for its parent session row.
func lockCommandAndRun(ctx context.Context, tx pgx.Tx, commandID string) (CommandRecord, *Run, error) {
	var sessionID, generation string
	var runID *string
	err := tx.QueryRow(ctx, `
		SELECT session_id, run_id, generation
		FROM execution_commands
		WHERE command_id = $1
	`, commandID).Scan(&sessionID, &runID, &generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, nil, ErrCommandNotFound
	}
	if err != nil {
		return CommandRecord{}, nil, fmt.Errorf("read command identity: %w", err)
	}
	if err := lockSessionForRunAdmission(ctx, tx, sessionID, generation); err != nil {
		return CommandRecord{}, nil, err
	}
	record, err := scanCommand(tx.QueryRow(ctx, commandQuery+` WHERE command.command_id = $1 FOR UPDATE`, commandID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CommandRecord{}, nil, ErrCommandNotFound
		}
		return CommandRecord{}, nil, fmt.Errorf("lock command: %w", err)
	}
	if record.Intent.Command.SessionID != sessionID || record.Intent.Generation != generation {
		return CommandRecord{}, nil, fmt.Errorf("%w: command %q identity changed while locking", ErrCommandFactConflict, commandID)
	}
	if optionalRunID(record.Intent.Command.RunID) == "" {
		return record, nil, nil
	}
	current, err := scanRun(tx.QueryRow(ctx, runQuery+` WHERE run.id = $1 FOR UPDATE`, optionalRunID(record.Intent.Command.RunID)))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommandRecord{}, nil, ErrRunNotFound
	}
	if err != nil {
		return CommandRecord{}, nil, fmt.Errorf("lock associated run: %w", err)
	}
	if current.SessionID != record.Intent.Command.SessionID {
		return CommandRecord{}, nil, fmt.Errorf("%w: command %q is not associated with run %q", ErrRunConflict, commandID, current.ID)
	}
	if current.Generation != record.Intent.Generation {
		return CommandRecord{}, nil, fmt.Errorf("%w: run %q belongs to generation %q", ErrStaleGeneration, current.ID, current.Generation)
	}
	return record, &current, nil
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
	if err := lockSessionForRunAdmission(ctx, tx, intent.Command.SessionID, intent.Generation); err != nil {
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

func validateApprovalCommandIntent(intent CommandIntent, request approvals.ResolveRequest) error {
	if intent.Command.Kind != protocol.CommandKindRunApprove && intent.Command.Kind != protocol.CommandKindRunDeny {
		return fmt.Errorf("%w: approval admission requires an approval command kind", ErrInvalidCommand)
	}
	if intent.Command.CommandID != request.Request.CommandID {
		return fmt.Errorf("%w: command and approval identities do not match", ErrInvalidCommand)
	}
	if intent.Command.RunID == nil || strings.TrimSpace(*intent.Command.RunID) == "" || *intent.Command.RunID != request.RunID {
		return fmt.Errorf("%w: command and approval run identities do not match", ErrInvalidCommand)
	}
	if intent.Command.SessionID != request.SessionID || intent.Generation != request.Generation {
		return fmt.Errorf("%w: command and approval session identities do not match", ErrInvalidCommand)
	}
	if (intent.Command.Kind == protocol.CommandKindRunApprove) != (request.Request.Decision == protocol.ApprovalDecisionApprove) {
		return fmt.Errorf("%w: command kind and approval decision do not match", ErrInvalidCommand)
	}
	return nil
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
