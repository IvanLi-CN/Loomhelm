package runs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var ErrDraftRecoveryRequired = errors.New("draft command recovery is required")

type CommandTransport interface {
	SendCommand(context.Context, protocol.Command) (protocol.CommandAck, error)
	ReconcileCommand(context.Context, protocol.Command) (protocol.Reconciliation, error)
}

type GenerationResolver func(context.Context, string) (string, error)

// DraftCommandLifecycle is the narrow durable seam between Run command
// admission/recovery and the private draft store. Implementations must keep
// PrepareCommandTx free of external side effects; FinalizeCommand is safe to
// retry and must never send a command.
type DraftCommandLifecycle interface {
	PrepareCommandTx(context.Context, pgx.Tx, drafts.CommandDraftInput) error
	FinalizeCommand(context.Context, string, bool) (drafts.CommandDraftResult, error)
}

type ControllerConfig struct {
	Generation         string
	ResolveGeneration  GenerationResolver
	RunID              func(protocol.Command, string) string
	DraftCommands      DraftCommandLifecycle
	OwnerID            string
	CandidateSourceSHA string
	ArtifactDigest     string
	LeaseTTL           time.Duration
}

// Controller is the durable RunController adapter. The transport callback is
// deliberately narrower than Gateway or Connector so the parent composition
// can select either boundary without moving host handles into persistence.
type Controller struct {
	store              *Store
	transport          CommandTransport
	generation         string
	resolveGeneration  GenerationResolver
	runID              func(protocol.Command, string) string
	draftCommands      DraftCommandLifecycle
	ownerID            string
	candidateSourceSHA string
	artifactDigest     string
	leaseTTL           time.Duration
	activeMu           sync.Mutex
	activeCommands     map[string]int
}

func NewController(store *Store, transport CommandTransport, config ControllerConfig) (*Controller, error) {
	if store == nil {
		return nil, errors.New("run controller store is required")
	}
	if transport == nil {
		return nil, errors.New("run controller transport is required")
	}
	if strings.TrimSpace(config.Generation) == "" && config.ResolveGeneration == nil {
		return nil, errors.New("run controller generation or resolver is required")
	}
	runID := config.RunID
	if runID == nil {
		runID = defaultRunID
	}
	ownerID := strings.TrimSpace(config.OwnerID)
	if ownerID == "" {
		generatedOwnerID, err := newControllerOwnerID()
		if err != nil {
			return nil, fmt.Errorf("generate controller owner id: %w", err)
		}
		ownerID = generatedOwnerID
	}
	return &Controller{
		store:              store,
		transport:          transport,
		generation:         config.Generation,
		resolveGeneration:  config.ResolveGeneration,
		runID:              runID,
		draftCommands:      config.DraftCommands,
		ownerID:            ownerID,
		candidateSourceSHA: firstNonEmpty(config.CandidateSourceSHA, "unknown-source"),
		artifactDigest:     firstNonEmpty(config.ArtifactDigest, "unknown-artifact"),
		leaseTTL:           positiveDuration(config.LeaseTTL, defaultControlLeaseTTL),
		activeCommands:     make(map[string]int),
	}, nil
}

func (c *Controller) AcceptCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	return c.acceptCommand(ctx, command, nil)
}

// AcceptCommandWithDraft admits a Run send while binding the exact draft
// revision carried by the command. The binding is durable before transport
// delivery; a later ACK or reconciliation fact finalizes it without replaying
// the command.
func (c *Controller) AcceptCommandWithDraft(ctx context.Context, command protocol.Command, draft drafts.CommandDraftInput) (protocol.CommandAck, error) {
	if c == nil || c.draftCommands == nil {
		return protocol.CommandAck{}, fmt.Errorf("%w: draft command lifecycle is required", ErrDraftRecoveryRequired)
	}
	if command.Kind != protocol.CommandKindRunSend {
		return protocol.CommandAck{}, fmt.Errorf("%w: draft binding requires %q", ErrInvalidCommand, protocol.CommandKindRunSend)
	}
	if draft.CommandID != command.CommandID || draft.SessionID != command.SessionID {
		return protocol.CommandAck{}, fmt.Errorf("%w: command and draft identities do not match", ErrInvalidCommand)
	}
	return c.acceptCommand(ctx, command, &draft)
}

func (c *Controller) acceptCommand(ctx context.Context, command protocol.Command, draft *drafts.CommandDraftInput) (protocol.CommandAck, error) {
	if c == nil || c.store == nil || c.transport == nil {
		return protocol.CommandAck{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("run controller context must not be nil")
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, err
	}
	release := c.trackActiveCommand(command.CommandID)
	defer release()
	generation, err := c.currentGeneration(ctx, command.SessionID)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	intent := CommandIntent{Command: command, Generation: generation}
	if draft != nil {
		revision := draft.ExpectedRevision
		intent.DraftRevision = &revision
		intent.DraftOwnerID = draft.OwnerUserID
	}
	if command.Kind == protocol.CommandKindRunSend {
		if command.RunID == nil || strings.TrimSpace(*command.RunID) == "" {
			runID := c.runID(command, generation)
			if strings.TrimSpace(runID) == "" {
				return protocol.CommandAck{}, fmt.Errorf("%w: run id generator returned an empty id", ErrInvalidRun)
			}
			intent.Command.RunID = &runID
		}
		lease := c.leaseForIntent(intent)
		var mutation CommandAdmissionMutation
		if draft != nil {
			mutation = func(mutationCtx context.Context, tx pgx.Tx, _ AcceptResult) error {
				return c.draftCommands.PrepareCommandTx(mutationCtx, tx, *draft)
			}
		}
		accepted, _, err := c.store.AcceptRunWithLeaseAndMutation(ctx, intent, NewRunInput{
			ID:         optionalRunID(intent.Command.RunID),
			SessionID:  command.SessionID,
			CommandID:  command.CommandID,
			Generation: generation,
		}, *lease, mutation)
		if err != nil {
			return protocol.CommandAck{}, err
		}
		return c.dispatchAccepted(ctx, intent, accepted)
	}
	if command.Kind == protocol.CommandKindRunInterrupt {
		lease := c.leaseForIntent(intent)
		accepted, err := c.store.AcceptInterruptWithLease(ctx, intent, *lease)
		if err != nil {
			return protocol.CommandAck{}, err
		}
		return c.dispatchAccepted(ctx, intent, accepted)
	}
	accepted, err := c.store.AcceptForGeneration(ctx, generation, intent)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	return c.dispatchAccepted(ctx, intent, accepted)
}

// AcceptInterruptCommand admits an interrupt through the atomic Run-control
// boundary. The command ledger row and the Run interrupt reservation commit
// before transport delivery, preserving reconciliation across process exits.
func (c *Controller) AcceptInterruptCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	if c == nil || c.store == nil || c.transport == nil {
		return protocol.CommandAck{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("run controller context must not be nil")
	}
	if command.Kind != protocol.CommandKindRunInterrupt {
		return protocol.CommandAck{}, fmt.Errorf("%w: interrupt admission requires %q", ErrInvalidCommand, protocol.CommandKindRunInterrupt)
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, err
	}
	release := c.trackActiveCommand(command.CommandID)
	defer release()
	generation, err := c.currentGeneration(ctx, command.SessionID)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	intent := CommandIntent{Command: command, Generation: generation}
	lease := c.leaseForIntent(intent)
	accepted, err := c.store.AcceptInterruptWithLease(ctx, intent, *lease)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	return c.dispatchAccepted(ctx, intent, accepted)
}

// AcceptApprovalCommand admits an approval through the atomic command and
// approval transaction. Transport delivery starts only after both durable
// writes commit, so a process exit leaves a command that can be reconciled.
func (c *Controller) AcceptApprovalCommand(ctx context.Context, command protocol.Command, resolver ApprovalTransactionResolver, request approvals.ResolveRequest) (protocol.CommandAck, error) {
	if c == nil || c.store == nil || c.transport == nil {
		return protocol.CommandAck{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("run controller context must not be nil")
	}
	if command.Kind != protocol.CommandKindRunApprove && command.Kind != protocol.CommandKindRunDeny {
		return protocol.CommandAck{}, fmt.Errorf("%w: approval admission requires an approval command kind", ErrInvalidCommand)
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, err
	}
	release := c.trackActiveCommand(command.CommandID)
	defer release()
	generation, err := c.currentGeneration(ctx, command.SessionID)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	intent := CommandIntent{Command: command, Generation: generation}
	lease := c.leaseForIntent(intent)
	accepted, _, err := c.store.AcceptApprovalWithLease(ctx, resolver, intent, request, *lease)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	return c.dispatchAccepted(ctx, intent, accepted)
}

func (c *Controller) LookupCommand(ctx context.Context, platformSessionID, commandID string) (protocol.CommandAck, error) {
	if c == nil || c.store == nil {
		return protocol.CommandAck{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("run controller context must not be nil")
	}
	record, err := c.store.Lookup(ctx, platformSessionID, commandID)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	return record.Ack(), nil
}

func (c *Controller) ReadEvents(ctx context.Context, query protocol.EventQuery) (protocol.EventPage, error) {
	if c == nil || c.store == nil {
		return protocol.EventPage{}, errors.New("run controller is not initialized")
	}
	return c.store.ReadEvents(ctx, query)
}

func (c *Controller) ReconcileCommand(ctx context.Context, platformSessionID, commandID string) (protocol.Reconciliation, error) {
	if c == nil || c.store == nil || c.transport == nil {
		return protocol.Reconciliation{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.Reconciliation{}, errors.New("run controller context must not be nil")
	}
	record, err := c.store.Lookup(ctx, platformSessionID, commandID)
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	if isTerminalCommandState(record.State) {
		reconciliation := terminalReconciliation(record)
		if err := c.finalizeDraftCommand(ctx, record); err != nil {
			return reconciliation, err
		}
		return reconciliation, nil
	}
	if record.State == protocol.CommandStateExecuting && record.ReconciliationState == protocol.ReconciliationStateConfirmed {
		reconciliation := confirmedCommandReconciliation(record)
		if err := c.finalizeDraftCommand(ctx, record); err != nil {
			return reconciliation, err
		}
		return reconciliation, nil
	}
	lease := c.leaseForIntent(CommandIntent{Command: record.Intent.Command, Generation: record.Intent.Generation})
	if lease != nil {
		if _, err := c.store.AcquireLease(ctx, *lease, LeaseStoreConfig{TTL: c.leaseTTL}); err != nil {
			return protocol.Reconciliation{}, err
		}
		defer c.releaseLease(context.Background(), *lease)
		if unknownCommandPreservesRun(record.Intent.Command.Kind) {
			record, err = c.store.MarkUnknownWithLease(ctx, commandID, record.Intent.Generation, *lease)
		} else {
			record, err = c.store.MarkCommandAndRunUnknownWithLease(ctx, commandID, record.Intent.Generation, "command delivery outcome is unknown", *lease)
		}
	} else {
		if unknownCommandPreservesRun(record.Intent.Command.Kind) {
			record, err = c.store.MarkUnknown(ctx, commandID, record.Intent.Generation)
		} else {
			record, err = c.store.MarkCommandAndRunUnknown(ctx, commandID, record.Intent.Generation, "command delivery outcome is unknown")
		}
	}
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	if isTerminalCommandState(record.State) {
		reconciliation := terminalReconciliation(record)
		if err := c.finalizeDraftCommand(ctx, record); err != nil {
			return reconciliation, err
		}
		return reconciliation, nil
	}
	reconciliation, err := c.transport.ReconcileCommand(ctx, record.Intent.Command)
	if err != nil {
		return reconciliation, err
	}
	if reconciliation.CommandID == "" {
		return reconciliation, fmt.Errorf("transport returned an empty command id for %q", commandID)
	}
	if reconciliation.CommandID != commandID {
		return reconciliation, fmt.Errorf("transport returned command id %q for %q", reconciliation.CommandID, commandID)
	}
	observation := CommandObservation{EventCursor: optionalStringValue(reconciliation.EventCursor)}
	switch reconciliation.State {
	case protocol.ReconciliationStateConfirmed:
		observation.Reconciliation = reconciliation.State
		observation.State = protocol.CommandStateSucceeded
	case protocol.ReconciliationStateNotFound:
		observation.Reconciliation = reconciliation.State
		observation.State = protocol.CommandStateRejected
	case protocol.ReconciliationStateUnknown:
		observation.Reconciliation = reconciliation.State
	default:
		return reconciliation, fmt.Errorf("%w: unsupported reconciliation state %q", ErrReconciliationUnknown, reconciliation.State)
	}
	var reconciled CommandRecord
	var reconcileErr error
	if lease != nil {
		reconciled, reconcileErr = c.store.ReconcileWithLease(ctx, commandID, record.Intent.Generation, observation, *lease)
	} else {
		reconciled, reconcileErr = c.store.Reconcile(ctx, commandID, record.Intent.Generation, observation)
	}
	if reconcileErr == nil {
		reconcileErr = c.finalizeDraftCommand(ctx, reconciled)
	}
	return reconciliation, reconcileErr
}

func (c *Controller) currentGeneration(ctx context.Context, sessionID string) (string, error) {
	if c.resolveGeneration != nil {
		generation, err := c.resolveGeneration(ctx, sessionID)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(generation) == "" || generation != strings.TrimSpace(generation) {
			return "", fmt.Errorf("%w: resolver returned an invalid generation", ErrStaleGeneration)
		}
		return generation, nil
	}
	if strings.TrimSpace(c.generation) == "" {
		return "", fmt.Errorf("%w: controller generation is not configured", ErrStaleGeneration)
	}
	return c.generation, nil
}

func (c *Controller) finalizeDraftCommand(ctx context.Context, record CommandRecord) error {
	if c.draftCommands == nil {
		return nil
	}
	var delivered bool
	switch record.State {
	case protocol.CommandStateExecuting, protocol.CommandStateSucceeded:
		delivered = true
	case protocol.CommandStateFailed, protocol.CommandStateRejected:
		delivered = false
	default:
		return nil
	}
	if _, err := c.draftCommands.FinalizeCommand(ctx, record.Intent.Command.CommandID, delivered); err != nil {
		return errors.Join(ErrDraftRecoveryRequired, err)
	}
	return nil
}

func (c *Controller) dispatchAccepted(ctx context.Context, intent CommandIntent, accepted AcceptResult) (protocol.CommandAck, error) {
	ack := accepted.Record.Ack()
	ack.Deduplicated = accepted.Deduplicated
	if accepted.Deduplicated {
		if accepted.Record.State == protocol.CommandStateUnknown {
			return ack, protocol.ErrUnknownCommandResult
		}
		if accepted.Record.State == protocol.CommandStateAccepted || accepted.Record.State == protocol.CommandStateExecuting {
			if c.hasOtherActiveCommand(intent.Command.CommandID) {
				return ack, nil
			}
			return c.reconcileOrphanedCommand(ctx, accepted.Record)
		}
		return ack, c.finalizeDraftCommand(ctx, accepted.Record)
	}
	if accepted.Record.State != protocol.CommandStateAccepted {
		return ack, nil
	}
	lease := c.leaseForIntent(intent)
	if lease != nil {
		defer c.releaseLease(context.Background(), *lease)
	}
	var transitionErr error
	if lease != nil {
		_, transitionErr = c.store.TransitionWithLease(ctx, intent.Command.CommandID, intent.Generation, protocol.CommandStateExecuting, "", nil, nil, *lease)
	} else {
		_, transitionErr = c.store.Transition(ctx, intent.Command.CommandID, intent.Generation, protocol.CommandStateExecuting, "", nil, nil)
	}
	if transitionErr != nil {
		return ack, transitionErr
	}
	if lease != nil {
		if _, err := c.store.CheckLease(ctx, *lease); err != nil {
			return ack, err
		}
	}
	sent, sendErr := c.sendCommand(ctx, intent, lease)
	normalized, normalizeErr := normalizeTransportAck(intent.Command, sent)
	if normalizeErr == nil {
		record, factErr := c.store.RecordExactCommandAck(ctx, intent.Command.SessionID, normalized)
		if factErr == nil {
			if record.State == protocol.CommandStateExecuting {
				c.retainActiveCommand(intent.Command.CommandID)
			}
			result := record.Ack()
			result.Deduplicated = accepted.Deduplicated
			return result, errors.Join(sendErr, c.finalizeDraftCommand(ctx, record))
		}
		if errors.Is(factErr, ErrCommandFactConflict) {
			return ack, factErr
		}
		if sendErr == nil {
			return c.markCommandUnknown(ctx, intent, ack, factErr, lease)
		}
		return c.markCommandUnknown(ctx, intent, ack, errors.Join(factErr, sendErr), lease)
	}
	if sent.CommandID != "" || sendErr == nil {
		if sendErr == nil {
			return c.markCommandUnknown(ctx, intent, ack, normalizeErr, lease)
		}
	}
	if sendErr != nil {
		if errors.Is(sendErr, ErrLeaseLost) {
			return ack, errors.Join(protocol.ErrUnknownCommandResult, sendErr)
		}
		return c.markCommandUnknown(ctx, intent, ack, sendErr, lease)
	}
	return c.markCommandUnknown(ctx, intent, ack, errors.New("transport returned an invalid command acknowledgement"), lease)
}

func (c *Controller) reconcileOrphanedCommand(ctx context.Context, record CommandRecord) (protocol.CommandAck, error) {
	_, reconcileErr := c.ReconcileCommand(ctx, record.Intent.Command.SessionID, record.Intent.Command.CommandID)
	latest, lookupErr := c.store.Lookup(ctx, record.Intent.Command.SessionID, record.Intent.Command.CommandID)
	if lookupErr != nil {
		return record.Ack(), errors.Join(protocol.ErrUnknownCommandResult, reconcileErr, lookupErr)
	}
	ack := latest.Ack()
	ack.Deduplicated = true
	return ack, reconcileErr
}

func (c *Controller) trackActiveCommand(commandID string) func() {
	c.activeMu.Lock()
	if c.activeCommands == nil {
		c.activeCommands = make(map[string]int)
	}
	c.activeCommands[commandID]++
	c.activeMu.Unlock()
	return func() {
		c.activeMu.Lock()
		if count := c.activeCommands[commandID]; count <= 1 {
			delete(c.activeCommands, commandID)
		} else {
			c.activeCommands[commandID] = count - 1
		}
		c.activeMu.Unlock()
	}
}

func (c *Controller) retainActiveCommand(commandID string) {
	c.activeMu.Lock()
	if c.activeCommands == nil {
		c.activeCommands = make(map[string]int)
	}
	c.activeCommands[commandID]++
	c.activeMu.Unlock()
}

func (c *Controller) hasOtherActiveCommand(commandID string) bool {
	c.activeMu.Lock()
	defer c.activeMu.Unlock()
	return c.activeCommands[commandID] > 1
}

func (c *Controller) markCommandUnknown(ctx context.Context, intent CommandIntent, fallback protocol.CommandAck, cause error, lease *DurableLeaseIdentity) (protocol.CommandAck, error) {
	persistCtx, cancel := UnknownOutcomeContext(ctx)
	defer cancel()

	var unknown CommandRecord
	var err error
	if unknownCommandPreservesRun(intent.Command.Kind) {
		// Approval delivery can be unknown even after the public approval CAS
		// committed. Keep the command unknown and never replay it, but leave the
		// Run controllable so an explicit interrupt can still be delivered and a
		// native terminal event can establish the actual Run outcome.
		if lease != nil {
			unknown, err = c.store.TransitionWithLease(persistCtx, intent.Command.CommandID, intent.Generation, protocol.CommandStateUnknown, "", nil, nil, *lease)
		} else {
			unknown, err = c.store.Transition(persistCtx, intent.Command.CommandID, intent.Generation, protocol.CommandStateUnknown, "", nil, nil)
		}
	} else if lease != nil {
		unknown, err = c.store.MarkCommandAndRunUnknownWithLease(persistCtx, intent.Command.CommandID, intent.Generation, "command delivery outcome is unknown", *lease)
	} else {
		unknown, err = c.store.MarkCommandAndRunUnknown(persistCtx, intent.Command.CommandID, intent.Generation, "command delivery outcome is unknown")
	}
	if err != nil {
		return fallback, errors.Join(protocol.ErrUnknownCommandResult, cause, err)
	}
	return unknown.Ack(), errors.Join(protocol.ErrUnknownCommandResult, cause)
}

func unknownCommandPreservesRun(kind protocol.CommandKind) bool {
	return kind == protocol.CommandKindRunApprove || kind == protocol.CommandKindRunDeny
}

func (c *Controller) leaseForIntent(intent CommandIntent) *DurableLeaseIdentity {
	switch intent.Command.Kind {
	case protocol.CommandKindRunSend, protocol.CommandKindRunApprove, protocol.CommandKindRunDeny, protocol.CommandKindRunInterrupt:
	default:
		return nil
	}
	if intent.Command.RunID == nil || strings.TrimSpace(*intent.Command.RunID) == "" {
		return nil
	}
	return &DurableLeaseIdentity{
		LeaseKey:           RunLeaseKey(*intent.Command.RunID),
		SessionID:          intent.Command.SessionID,
		RunID:              *intent.Command.RunID,
		Generation:         intent.Generation,
		OwnerID:            c.ownerID,
		CandidateSourceSHA: c.candidateSourceSHA,
		ArtifactDigest:     c.artifactDigest,
	}
}

func (c *Controller) releaseLease(ctx context.Context, identity DurableLeaseIdentity) {
	if err := c.store.ReleaseLease(ctx, identity); err != nil && !errors.Is(err, ErrLeaseLost) {
		return
	}
}

func (c *Controller) sendCommand(ctx context.Context, intent CommandIntent, lease *DurableLeaseIdentity) (protocol.CommandAck, error) {
	if lease == nil {
		return c.transport.SendCommand(ctx, intent.Command)
	}
	leaseCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := make(chan struct{})
	leaseErrors := make(chan error, 1)
	interval := c.leaseTTL / 2
	if interval <= 0 {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	go func() {
		for {
			select {
			case <-ticker.C:
				heartbeatCtx, heartbeatCancel := context.WithTimeout(context.Background(), c.leaseTTL/4)
				_, err := c.store.RenewLease(heartbeatCtx, *lease, LeaseStoreConfig{TTL: c.leaseTTL})
				heartbeatCancel()
				if err != nil {
					select {
					case leaseErrors <- err:
					default:
					}
					cancel()
					return
				}
			case <-stop:
				return
			case <-leaseCtx.Done():
				return
			}
		}
	}()
	sent, sendErr := c.transport.SendCommand(leaseCtx, intent.Command)
	close(stop)
	var leaseErr error
	select {
	case leaseErr = <-leaseErrors:
	default:
	}
	if leaseErr != nil {
		return sent, errors.Join(ErrLeaseLost, leaseErr, sendErr)
	}
	return sent, sendErr
}

func normalizeTransportAck(command protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	if ack.CommandID == "" {
		return protocol.CommandAck{}, fmt.Errorf("transport returned an empty command id for %q", command.CommandID)
	}
	if ack.CommandID != command.CommandID {
		return protocol.CommandAck{}, fmt.Errorf("transport returned command id %q for %q", ack.CommandID, command.CommandID)
	}
	ack.CommandID = command.CommandID
	if command.RunID != nil {
		if ack.RunID != nil && *ack.RunID != *command.RunID {
			return protocol.CommandAck{}, fmt.Errorf("transport returned run id %q for %q", *ack.RunID, *command.RunID)
		}
		ack.RunID = cloneStringPointer(command.RunID)
	} else {
		ack.RunID = nil
	}
	if ack.State == protocol.CommandStateAccepted {
		ack.State = protocol.CommandStateExecuting
	}
	if !validCommandState(ack.State) || ack.State == protocol.CommandStateUnknown {
		return protocol.CommandAck{}, fmt.Errorf("transport returned unsupported command state %q", ack.State)
	}
	return ack, nil
}

func terminalReconciliation(record CommandRecord) protocol.Reconciliation {
	state := protocol.ReconciliationStateConfirmed
	if record.State == protocol.CommandStateFailed || record.State == protocol.CommandStateRejected {
		state = protocol.ReconciliationStateNotFound
	}
	return protocol.Reconciliation{
		CommandID:   record.Intent.Command.CommandID,
		EventCursor: optionalString(record.EventCursor),
		State:       state,
	}
}

func confirmedCommandReconciliation(record CommandRecord) protocol.Reconciliation {
	return protocol.Reconciliation{
		CommandID:   record.Intent.Command.CommandID,
		EventCursor: optionalString(record.EventCursor),
		State:       protocol.ReconciliationStateConfirmed,
	}
}

func defaultRunID(command protocol.Command, generation string) string {
	value := command.SessionID + "\x00" + command.CommandID + "\x00" + generation
	sum := sha256.Sum256([]byte(value))
	return "run-" + hex.EncodeToString(sum[:16])
}

func newControllerOwnerID() (string, error) {
	var suffix [16]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return "loomhelm-controller:" + hex.EncodeToString(suffix[:]), nil
}

func positiveDuration(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var _ protocol.RunController = (*Controller)(nil)
