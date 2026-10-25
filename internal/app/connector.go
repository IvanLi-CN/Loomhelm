package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const (
	connectorInitialReconnectDelay = 250 * time.Millisecond
	connectorMaxReconnectDelay     = 5 * time.Second
	connectorHeartbeatInterval     = 15 * time.Second
	connectorEventPollInterval     = 100 * time.Millisecond
	connectorDialTimeout           = 10 * time.Second
)

var errConnectorRunIdentityGap = errors.New("Connector event has no reliable platform Run ID mapping")

type Connector struct {
	cfg       platform.Config
	logger    *slog.Logger
	lifecycle *platform.Lifecycle
	runMu     sync.Mutex

	journal    *connectorruntime.Journal
	appGateway *connectorruntime.Gateway
	adapter    *connectorruntime.Adapter
	controller *connectorruntime.Controller
	platform   *gateway.Client

	connectionMu sync.Mutex
	connection   *gateway.ClientConnection
}

func NewConnector(cfg platform.Config, logger *slog.Logger) (*Connector, error) {
	if cfg.Component != platform.ComponentConnector {
		return nil, fmt.Errorf("connector requires component %q, got %q", platform.ComponentConnector, cfg.Component)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid connector configuration: %w", err)
	}
	if logger == nil {
		logger = platform.NewLogger(io.Discard, cfg.Component, cfg.Version)
	}

	journal, err := connectorruntime.OpenJournal(cfg.ConnectorJournalPath)
	if err != nil {
		return nil, fmt.Errorf("open connector journal: %w", err)
	}
	closeJournal := true
	defer func() {
		if closeJournal {
			_ = journal.Close()
		}
	}()

	appGateway, err := connectorruntime.NewGateway(connectorruntime.GatewayConfig{
		Process: connectorruntime.ProcessTransportConfig{
			CommandPath: cfg.ConnectorAppServerCommand,
		},
		ClientInfo: connectorruntime.ClientInfo{
			Name:    "loomhelm_connector",
			Title:   "Loomhelm Connector",
			Version: cfg.Version,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("initialize connector app-server gateway: %w", err)
	}
	adapter, err := connectorruntime.NewAdapter(appGateway, journal, connectorruntime.AdapterConfig{})
	if err != nil {
		return nil, fmt.Errorf("initialize connector Codex adapter: %w", err)
	}
	controller, err := connectorruntime.NewController(journal, adapter)
	if err != nil {
		return nil, fmt.Errorf("initialize connector controller: %w", err)
	}
	platformURL, err := connectorGatewayURL(cfg.ConnectorServerURL)
	if err != nil {
		return nil, fmt.Errorf("build connector gateway URL: %w", err)
	}
	platformClient, err := gateway.NewClient(gateway.ClientOptions{
		URL:    platformURL,
		HostID: cfg.ConnectorHostID,
		Token:  cfg.ConnectorToken,
	})
	if err != nil {
		return nil, fmt.Errorf("initialize connector platform gateway: %w", err)
	}
	closeJournal = false
	return &Connector{
		cfg:        cfg,
		logger:     logger,
		lifecycle:  platform.NewLifecycle(),
		journal:    journal,
		appGateway: appGateway,
		adapter:    adapter,
		controller: controller,
		platform:   platformClient,
	}, nil
}

func connectorGatewayURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", errors.New("connector server URL is malformed")
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("connector server URL must be credential-free HTTPS without query or fragment")
	}
	parsed.Scheme = "wss"
	basePath := strings.TrimRight(parsed.Path, "/")
	if basePath == "" {
		parsed.Path = connectorGatewayPath
	} else if basePath == connectorGatewayPath || strings.HasSuffix(basePath, connectorGatewayPath) {
		parsed.Path = basePath
	} else {
		parsed.Path = basePath + connectorGatewayPath
	}
	parsed.RawPath = ""
	return parsed.String(), nil
}

func (c *Connector) Run(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("connector context must not be nil")
	}
	c.runMu.Lock()
	if snapshot := c.lifecycle.Snapshot(); snapshot.State != platform.StateNew {
		c.runMu.Unlock()
		return fmt.Errorf("connector lifecycle already started in state %q", snapshot.State)
	}
	if err := ctx.Err(); err != nil {
		c.lifecycle.Stop()
		c.runMu.Unlock()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), c.cfg.ShutdownTimeout)
		_ = c.closeResources(shutdownCtx)
		cancel()
		return nil
	}
	if err := c.lifecycle.Start(); err != nil {
		c.runMu.Unlock()
		return err
	}
	c.runMu.Unlock()

	serverURL, _ := url.Parse(c.cfg.ConnectorServerURL)
	c.logger.Info("connector started", "server_host", serverURL.Host)
	if err := c.recoverJournalSessions(ctx); err != nil && !errors.Is(err, context.Canceled) {
		c.logger.Warn("connector session recovery incomplete", "error", err)
	}
	runErr := c.connectionLoop(ctx)
	if c.lifecycle.BeginDrain("context canceled") {
		c.logger.Info("connector entering drain", "reason", "context canceled")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), c.cfg.ShutdownTimeout)
	shutdownErr := c.closeResources(shutdownCtx)
	cancel()
	c.lifecycle.Stop()
	c.logger.Info("connector stopped")
	if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
		runErr = nil
	}
	return errors.Join(runErr, shutdownErr)
}

func (c *Connector) connectionLoop(ctx context.Context) error {
	delay := connectorInitialReconnectDelay
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		dialCtx, cancel := context.WithTimeout(ctx, connectorDialTimeoutFor(c.cfg.ShutdownTimeout))
		connection, err := c.platform.Connect(dialCtx)
		cancel()
		if err != nil {
			c.logger.Warn("connector platform gateway connect failed", "error", err, "retry_after", delay)
			if !waitConnectorRetry(ctx, delay) {
				return ctx.Err()
			}
			delay = nextConnectorRetry(delay)
			continue
		}
		delay = connectorInitialReconnectDelay
		c.setConnection(connection)
		c.logger.Info("connector platform gateway connected", "host_id", connection.HostID(), "generation", connection.Generation())
		err = c.serveConnection(ctx, connection)
		c.clearConnection(connection)
		if closeErr := connection.Close(); closeErr != nil && ctx.Err() == nil {
			c.logger.Warn("connector platform gateway close failed", "error", closeErr)
		}
		if err != nil && !errors.Is(err, context.Canceled) && ctx.Err() == nil {
			c.logger.Warn("connector platform gateway disconnected", "error", err, "retry_after", delay)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !waitConnectorRetry(ctx, delay) {
			return ctx.Err()
		}
		delay = nextConnectorRetry(delay)
	}
}

func connectorDialTimeoutFor(shutdownTimeout time.Duration) time.Duration {
	if shutdownTimeout > 0 && shutdownTimeout < connectorDialTimeout {
		return shutdownTimeout
	}
	return connectorDialTimeout
}

func nextConnectorRetry(delay time.Duration) time.Duration {
	if delay >= connectorMaxReconnectDelay/2 {
		return connectorMaxReconnectDelay
	}
	return delay * 2
}

func waitConnectorRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func (c *Connector) serveConnection(ctx context.Context, connection *gateway.ClientConnection) error {
	connectionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	readResult := make(chan error, 1)
	eventResult := make(chan error, 1)
	heartbeatResult := make(chan error, 1)
	go func() { readResult <- c.readGatewayMessages(connectionCtx, connection) }()
	go func() { eventResult <- c.deliverJournalEvents(connectionCtx, connection) }()
	go func() { heartbeatResult <- c.sendGatewayHeartbeats(connectionCtx, connection) }()
	select {
	case err := <-readResult:
		cancel()
		return err
	case err := <-eventResult:
		cancel()
		return err
	case err := <-heartbeatResult:
		cancel()
		return err
	case <-ctx.Done():
		cancel()
		_ = connection.Close()
		return ctx.Err()
	}
}

func (c *Connector) readGatewayMessages(ctx context.Context, connection *gateway.ClientConnection) error {
	for {
		message, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		switch message.Type {
		case gateway.MessageCommand:
			if err := c.handleGatewayCommand(ctx, connection, message); err != nil {
				return err
			}
		case gateway.MessageHeartbeatAck:
			continue
		case gateway.MessageError:
			if message.Error == nil {
				return errors.New("platform gateway returned an unspecified error")
			}
			return fmt.Errorf("platform gateway rejected the Connector: %s", message.Error.Code)
		default:
			return fmt.Errorf("unexpected platform gateway message %q", message.Type)
		}
	}
}

func (c *Connector) handleGatewayCommand(ctx context.Context, connection *gateway.ClientConnection, message gateway.Message) error {
	if message.Command == nil {
		return errors.New("platform gateway command payload is missing")
	}
	command := *message.Command
	ack, err := c.controller.AcceptCommand(ctx, command)
	if err != nil {
		c.logger.Warn("connector command was not completed", "command_id", command.CommandID, "kind", command.Kind, "error", err)
		if ack.CommandID == "" {
			ack.CommandID = command.CommandID
		}
		if ack.State == "" {
			ack.State = protocol.CommandStateRejected
			if errors.Is(err, protocol.ErrUnknownCommandResult) {
				ack.State = protocol.CommandStateUnknown
			}
		}
		if ack.Error == nil {
			code := protocol.ErrorCodeInvalidRequest
			safeMessage := "Connector could not execute the command"
			if errors.Is(err, protocol.ErrUnknownCommandResult) {
				code = protocol.ErrorCodeUnknownResult
				safeMessage = "command outcome is unknown"
			}
			ack.Error = &protocol.ApiError{Code: code, Message: safeMessage, RequestID: command.CommandID}
		}
	}
	ack.CommandID = command.CommandID
	if ack.ReceivedAt == "" {
		ack.ReceivedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	// The command envelope is the only reliable platform Run identity in this
	// boundary. Adapter ACKs may expose a native turn identity; never forward it
	// as the platform Run ID.
	if command.RunID == nil {
		ack.RunID = nil
	} else {
		runID := *command.RunID
		ack.RunID = &runID
	}
	return connection.Acknowledge(ctx, message.RequestID, ack)
}

func (c *Connector) sendGatewayHeartbeats(ctx context.Context, connection *gateway.ClientConnection) error {
	ticker := time.NewTicker(connectorHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := connection.SendHeartbeat(ctx, ""); err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (c *Connector) deliverJournalEvents(ctx context.Context, connection *gateway.ClientConnection) error {
	after := make(map[string]string)
	for _, cursor := range connection.ResumeCursors() {
		// This slice can only safely deliver session-level events. A run-level
		// cursor belongs to a platform Run stream and must not advance the
		// session-level replay position without an established identity mapping.
		if strings.TrimSpace(cursor.RunID) != "" {
			continue
		}
		current := after[cursor.SessionID]
		if current == "" || connectorCursorBefore(cursor.Value, current) {
			after[cursor.SessionID] = cursor.Value
		}
	}
	blocked := make(map[string]string)
	ticker := time.NewTicker(connectorEventPollInterval)
	defer ticker.Stop()
	for {
		progressed, err := c.deliverJournalEventBatch(ctx, connection, after, blocked)
		if err != nil {
			return err
		}
		if progressed {
			continue
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (c *Connector) deliverJournalEventBatch(ctx context.Context, connection *gateway.ClientConnection, after, blocked map[string]string) (bool, error) {
	progressed := false
	for _, session := range c.journal.Sessions() {
		for {
			page, err := c.journal.ReadEvents(protocol.EventQuery{
				SessionID:   session.SessionID,
				AfterCursor: after[session.SessionID],
				Limit:       1000,
			})
			if errors.Is(err, protocol.ErrCursorExpired) {
				after[session.SessionID] = ""
				continue
			}
			if err != nil {
				return progressed, fmt.Errorf("read Connector journal events for session %q: %w", session.SessionID, err)
			}
			if len(page.Events) == 0 {
				break
			}
			blockedSession := false
			for _, event := range page.Events {
				if event.RunID != nil && strings.TrimSpace(*event.RunID) != "" {
					if blocked[session.SessionID] != event.Cursor {
						blocked[session.SessionID] = event.Cursor
						c.logger.Warn("Connector event delivery is blocked by missing platform Run ID mapping", "session_id", event.SessionID, "event_id", event.EventID, "cursor", event.Cursor, "native_run_id", *event.RunID, "error", errConnectorRunIdentityGap)
					}
					blockedSession = true
					break
				}
				if err := connection.SendEvent(ctx, event); err != nil {
					return progressed, err
				}
				after[session.SessionID] = event.Cursor
				delete(blocked, session.SessionID)
				progressed = true
			}
			if blockedSession || !page.HasMore || page.NextCursor == nil || *page.NextCursor == "" {
				break
			}
		}
	}
	return progressed, nil
}

func connectorCursorBefore(left, right string) bool {
	leftSequence, leftOK := connectorCursorSequence(left)
	rightSequence, rightOK := connectorCursorSequence(right)
	if leftOK && rightOK {
		return leftSequence < rightSequence
	}
	return left < right
}

func connectorCursorSequence(cursor string) (int64, bool) {
	separator := strings.LastIndexByte(cursor, ':')
	if separator < 0 || separator == len(cursor)-1 {
		return 0, false
	}
	sequence, err := strconv.ParseInt(cursor[separator+1:], 10, 64)
	return sequence, err == nil
}

func (c *Connector) recoverJournalSessions(ctx context.Context) error {
	var recoveryErrors []error
	for _, session := range c.journal.Sessions() {
		if err := ctx.Err(); err != nil {
			return err
		}
		recoveryCtx, cancel := context.WithTimeout(ctx, connectorDialTimeoutFor(c.cfg.ShutdownTimeout))
		reconciliation, err := c.appGateway.ReconcileSession(recoveryCtx, session.ExternalThreadRef)
		cancel()
		if err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("recover Connector session %q: %w", session.SessionID, err))
			continue
		}
		if reconciliation.State != protocol.ReconciliationStateConfirmed {
			note := "unknown"
			if reconciliation.Note != nil {
				note = *reconciliation.Note
			}
			recoveryErrors = append(recoveryErrors, fmt.Errorf("recover Connector session %q remains %s: %s", session.SessionID, reconciliation.State, note))
			continue
		}
		recovered, err := c.appGateway.RecoveredSession(session.ExternalThreadRef)
		if err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("resolve recovered Connector session %q: %w", session.SessionID, err))
			continue
		}
		bound, err := c.adapter.BindRecoveredSession(ctx, recovered, session.ExternalThreadRef)
		if err != nil {
			_ = c.appGateway.CloseSession(context.Background(), recovered)
			recoveryErrors = append(recoveryErrors, fmt.Errorf("bind recovered Connector session %q: %w", session.SessionID, err))
			continue
		}
		if bound.SessionID != session.SessionID {
			_ = c.adapter.CloseSession(context.Background(), bound)
			_ = c.appGateway.CloseSession(context.Background(), recovered)
			recoveryErrors = append(recoveryErrors, fmt.Errorf("recovered Connector session %q changed identity to %q", session.SessionID, bound.SessionID))
		}
	}
	return errors.Join(recoveryErrors...)
}

func (c *Connector) closeResources(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	var closeErrors []error
	c.connectionMu.Lock()
	connection := c.connection
	c.connection = nil
	c.connectionMu.Unlock()
	if connection != nil {
		if err := connection.Close(); err != nil {
			closeErrors = append(closeErrors, fmt.Errorf("close platform gateway connection: %w", err))
		}
	}
	for _, session := range c.journal.Sessions() {
		if err := c.adapter.CloseSession(ctx, session); err != nil {
			closeErrors = append(closeErrors, fmt.Errorf("close adapter session %q: %w", session.SessionID, err))
		}
		recovered, err := c.appGateway.RecoveredSession(session.ExternalThreadRef)
		if err != nil {
			continue
		}
		if err := c.appGateway.CloseSession(ctx, recovered); err != nil {
			closeErrors = append(closeErrors, fmt.Errorf("close app-server session %q: %w", session.SessionID, err))
		}
	}
	if c.journal != nil {
		if err := c.journal.Close(); err != nil {
			closeErrors = append(closeErrors, fmt.Errorf("close connector journal: %w", err))
		}
	}
	return errors.Join(closeErrors...)
}

func (c *Connector) setConnection(connection *gateway.ClientConnection) {
	c.connectionMu.Lock()
	c.connection = connection
	c.connectionMu.Unlock()
}

func (c *Connector) clearConnection(connection *gateway.ClientConnection) {
	c.connectionMu.Lock()
	if c.connection == connection {
		c.connection = nil
	}
	c.connectionMu.Unlock()
}

func (c *Connector) Lifecycle() platform.LifecycleSnapshot {
	return c.lifecycle.Snapshot()
}
