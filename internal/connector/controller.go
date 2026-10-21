package connector

import (
	"context"
	"errors"
	"fmt"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// Controller binds the versioned RunController contract to the durable
// command/event journal and the host-owned Codex adapter.
type Controller struct {
	journal *Journal
	adapter *Adapter
}

func NewController(journal *Journal, adapter *Adapter) (*Controller, error) {
	if journal == nil {
		return nil, errors.New("connector journal must not be nil")
	}
	if adapter == nil {
		return nil, errors.New("codex adapter must not be nil")
	}
	return &Controller{journal: journal, adapter: adapter}, nil
}

func NewRunController(journal *Journal, adapter *Adapter) (*Controller, error) {
	return NewController(journal, adapter)
}

func (c *Controller) AcceptCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	session, ok := c.journal.Session(command.SessionID)
	if !ok {
		return protocol.CommandAck{}, errors.New("command session is not present in the journal")
	}
	return c.adapter.SendCommand(ctx, session, command)
}

func (c *Controller) LookupCommand(_ context.Context, commandID string) (protocol.CommandAck, error) {
	return c.journal.LookupCommand(commandID)
}

func (c *Controller) ReadEvents(_ context.Context, query protocol.EventQuery) (protocol.EventPage, error) {
	return c.journal.ReadEvents(query)
}

func (c *Controller) ReconcileCommand(ctx context.Context, commandID string) (protocol.Reconciliation, error) {
	command, _, err := c.journal.Command(commandID)
	if err != nil {
		return protocol.Reconciliation{}, err
	}
	session, ok := c.journal.Session(command.SessionID)
	if !ok {
		return protocol.Reconciliation{}, errors.New("command session is not present in the journal")
	}
	if err := c.ensureAdapterSession(ctx, session); err != nil {
		return protocol.Reconciliation{}, err
	}
	return c.adapter.ReconcileCommand(ctx, session, commandID)
}

func (c *Controller) ensureAdapterSession(ctx context.Context, session protocol.AdapterSession) error {
	c.adapter.recoveryMu.Lock()
	defer c.adapter.recoveryMu.Unlock()
	state := c.adapter.sessionState(session.SessionID)
	if state != nil && !state.closed.Load() && c.adapter.isCurrentState(state) {
		return nil
	}
	gateway, ok := c.adapter.provider.(*Gateway)
	if !ok {
		return fmt.Errorf("adapter session %q is not available after restart", session.SessionID)
	}
	if session.ExternalThreadRef == "" {
		return fmt.Errorf("adapter session %q has no recoverable thread identity", session.SessionID)
	}
	reconciliation, err := gateway.ReconcileSession(ctx, session.ExternalThreadRef)
	if err != nil {
		return err
	}
	if reconciliation.State != protocol.ReconciliationStateConfirmed {
		return fmt.Errorf("adapter session %q recovery remains unknown", session.SessionID)
	}
	recoveredGatewaySession, err := gateway.RecoveredSession(session.ExternalThreadRef)
	if err != nil {
		return err
	}
	transport, err := c.adapter.provider.TransportFor(ctx, recoveredGatewaySession)
	if err != nil {
		return err
	}
	_, err = c.adapter.bindRecoveredSessionLocked(recoveredGatewaySession, session.ExternalThreadRef, "thread/resume", c.adapter.recoveredSessionResult(session.ExternalThreadRef), transport)
	return err
}

var _ protocol.RunController = (*Controller)(nil)
