package connector

import (
	"context"
	"errors"

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
	return c.adapter.ReconcileCommand(ctx, session, commandID)
}

var _ protocol.RunController = (*Controller)(nil)
