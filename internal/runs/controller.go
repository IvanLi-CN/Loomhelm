package runs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type CommandTransport interface {
	SendCommand(context.Context, protocol.Command) (protocol.CommandAck, error)
	ReconcileCommand(context.Context, protocol.Command) (protocol.Reconciliation, error)
}

type GenerationResolver func(context.Context, string) (string, error)

type ControllerConfig struct {
	Generation        string
	ResolveGeneration GenerationResolver
	RunID             func(protocol.Command, string) string
}

// Controller is the durable RunController adapter. The transport callback is
// deliberately narrower than Gateway or Connector so the parent composition
// can select either boundary without moving host handles into persistence.
type Controller struct {
	store             *Store
	transport         CommandTransport
	generation        string
	resolveGeneration GenerationResolver
	runID             func(protocol.Command, string) string
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
	return &Controller{
		store:             store,
		transport:         transport,
		generation:        config.Generation,
		resolveGeneration: config.ResolveGeneration,
		runID:             runID,
	}, nil
}

func (c *Controller) AcceptCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	if c == nil || c.store == nil || c.transport == nil {
		return protocol.CommandAck{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("run controller context must not be nil")
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.CommandAck{}, err
	}
	generation, err := c.currentGeneration(ctx, command.SessionID)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	intent := CommandIntent{Command: command, Generation: generation}
	if command.Kind == protocol.CommandKindRunSend {
		if command.RunID == nil || strings.TrimSpace(*command.RunID) == "" {
			runID := c.runID(command, generation)
			if strings.TrimSpace(runID) == "" {
				return protocol.CommandAck{}, fmt.Errorf("%w: run id generator returned an empty id", ErrInvalidRun)
			}
			intent.Command.RunID = &runID
		}
		accepted, _, err := c.store.AcceptRun(ctx, intent, NewRunInput{
			ID:         optionalRunID(intent.Command.RunID),
			SessionID:  command.SessionID,
			CommandID:  command.CommandID,
			Generation: generation,
		})
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

func (c *Controller) LookupCommand(ctx context.Context, commandID string) (protocol.CommandAck, error) {
	if c == nil || c.store == nil {
		return protocol.CommandAck{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.CommandAck{}, errors.New("run controller context must not be nil")
	}
	record, err := c.store.Lookup(ctx, commandID)
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

func (c *Controller) ReconcileCommand(ctx context.Context, commandID string) (protocol.Reconciliation, error) {
	if c == nil || c.store == nil || c.transport == nil {
		return protocol.Reconciliation{}, errors.New("run controller is not initialized")
	}
	if ctx == nil {
		return protocol.Reconciliation{}, errors.New("run controller context must not be nil")
	}
	record, err := c.store.Lookup(ctx, commandID)
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	if isTerminalCommandState(record.State) {
		return terminalReconciliation(record), nil
	}
	if record.State != protocol.CommandStateUnknown {
		if _, err := c.store.MarkUnknown(ctx, commandID, record.Intent.Generation); err != nil {
			return protocol.Reconciliation{}, err
		}
		record, err = c.store.Lookup(ctx, commandID)
		if err != nil {
			return protocol.Reconciliation{}, err
		}
	}
	reconciliation, err := c.transport.ReconcileCommand(ctx, record.Intent.Command)
	if err != nil {
		return reconciliation, err
	}
	if reconciliation.CommandID == "" {
		reconciliation.CommandID = commandID
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
	_, reconcileErr := c.store.Reconcile(ctx, commandID, record.Intent.Generation, observation)
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

func (c *Controller) dispatchAccepted(ctx context.Context, intent CommandIntent, accepted AcceptResult) (protocol.CommandAck, error) {
	ack := accepted.Record.Ack()
	ack.Deduplicated = accepted.Deduplicated
	if accepted.Deduplicated {
		if accepted.Record.State == protocol.CommandStateUnknown {
			return ack, protocol.ErrUnknownCommandResult
		}
		return ack, nil
	}
	if accepted.Record.State != protocol.CommandStateAccepted {
		return ack, nil
	}
	if _, err := c.store.Transition(ctx, intent.Command.CommandID, intent.Generation, protocol.CommandStateExecuting, "", nil, nil); err != nil {
		return ack, err
	}
	sent, sendErr := c.transport.SendCommand(ctx, intent.Command)
	if sendErr != nil {
		return c.markCommandUnknown(ctx, intent, ack, sendErr)
	}
	if sent.CommandID != "" && sent.CommandID != intent.Command.CommandID {
		return c.markCommandUnknown(ctx, intent, ack, fmt.Errorf("transport returned command id %q for %q", sent.CommandID, intent.Command.CommandID))
	}
	next := sent.State
	if next == protocol.CommandStateAccepted {
		next = protocol.CommandStateExecuting
	}
	if !validCommandState(next) || next == protocol.CommandStateUnknown {
		if next == protocol.CommandStateUnknown {
			return c.markCommandUnknown(ctx, intent, ack, protocol.ErrUnknownCommandResult)
		}
		return c.markCommandUnknown(ctx, intent, ack, fmt.Errorf("transport returned unsupported command state %q", sent.State))
	}
	operationID := optionalStringValue(sent.OperationID)
	eventCursor := optionalStringValue(sent.EventCursor)
	record, err := c.store.Transition(ctx, intent.Command.CommandID, intent.Generation, next, operationID, sent.Result, sent.Error)
	if err != nil {
		return c.markCommandUnknown(ctx, intent, ack, err)
	}
	if eventCursor != "" {
		record, err = c.store.RecordCommandCursor(ctx, intent.Command.CommandID, intent.Generation, eventCursor)
		if err != nil {
			return c.markCommandUnknown(ctx, intent, ack, err)
		}
	}
	return record.Ack(), nil
}

func (c *Controller) markCommandUnknown(ctx context.Context, intent CommandIntent, fallback protocol.CommandAck, cause error) (protocol.CommandAck, error) {
	unknown, err := c.store.MarkUnknown(ctx, intent.Command.CommandID, intent.Generation)
	var runErr error
	if intent.Command.RunID != nil && strings.TrimSpace(*intent.Command.RunID) != "" {
		_, runErr = c.store.MarkRunUnknown(ctx, *intent.Command.RunID, intent.Generation, "", "command delivery outcome is unknown")
	}
	if err != nil {
		return fallback, errors.Join(protocol.ErrUnknownCommandResult, cause, err, runErr)
	}
	if runErr != nil {
		return unknown.Ack(), errors.Join(protocol.ErrUnknownCommandResult, cause, runErr)
	}
	return unknown.Ack(), errors.Join(protocol.ErrUnknownCommandResult, cause)
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

func defaultRunID(command protocol.Command, generation string) string {
	value := command.SessionID + "\x00" + command.CommandID + "\x00" + generation
	sum := sha256.Sum256([]byte(value))
	return "run-" + hex.EncodeToString(sum[:16])
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var _ protocol.RunController = (*Controller)(nil)
