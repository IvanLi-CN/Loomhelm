package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

type Connector struct {
	cfg       platform.Config
	logger    *slog.Logger
	lifecycle *platform.Lifecycle
	runMu     sync.Mutex

	journal             *connectorruntime.Journal
	artifactOutbox      *connectorruntime.ArtifactOutbox
	appGateway          *connectorruntime.Gateway
	adapter             *connectorruntime.Adapter
	controller          *connectorruntime.Controller
	platform            *gateway.Client
	sourceRuntime       *connectorruntime.SourceRuntime
	sourceLifecycleMu   sync.Mutex
	sourceMu            sync.Mutex
	source              *connectorruntime.SourceClient
	sourceNoticeMu      sync.Mutex
	pendingSourceNotice *connectorruntime.SourceNotification

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
	artifactOutbox, err := connectorruntime.OpenArtifactOutbox(cfg.ConnectorJournalPath + ".artifacts.jsonl")
	if err != nil {
		return nil, fmt.Errorf("open connector artifact outbox: %w", err)
	}
	closeArtifactOutbox := true
	defer func() {
		if closeArtifactOutbox {
			_ = artifactOutbox.Close()
		}
	}()

	appGateway, err := connectorruntime.NewGateway(connectorruntime.GatewayConfig{
		SocketPath: cfg.ConnectorAppServerSocket,
		Process: connectorruntime.ProcessTransportConfig{
			CommandPath: cfg.ConnectorAppServerCommand,
			WorkingDir:  cfg.ConnectorWorkingDir,
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
	adapter, err := connectorruntime.NewAdapter(appGateway, journal, connectorruntime.AdapterConfig{
		ArtifactOutbox: artifactOutbox,
		WorkingDir:     cfg.ConnectorWorkingDir,
	})
	if err != nil {
		return nil, fmt.Errorf("initialize connector Codex adapter: %w", err)
	}
	controller, err := connectorruntime.NewController(journal, adapter)
	if err != nil {
		return nil, fmt.Errorf("initialize connector controller: %w", err)
	}
	sourceRuntime, err := connectorruntime.NewSourceRuntime(func(factoryCtx context.Context) (connectorruntime.RPCTransport, error) {
		return connectorruntime.NewProcessTransport(context.WithoutCancel(factoryCtx), connectorruntime.ProcessTransportConfig{
			CommandPath: cfg.ConnectorAppServerCommand,
			WorkingDir:  cfg.ConnectorWorkingDir,
		})
	}, connectorruntime.ClientInfo{
		Name:    "loomhelm_connector_source",
		Title:   "Loomhelm Codex Source",
		Version: cfg.Version,
	})
	if err != nil {
		return nil, fmt.Errorf("initialize connector Codex source runtime: %w", err)
	}
	var platformClient *gateway.Client
	if credential, ok, credentialErr := connectorCredentialFromConfig(cfg); credentialErr != nil {
		return nil, fmt.Errorf("initialize connector platform credential: %w", credentialErr)
	} else if ok {
		platformClient, err = newConnectorPlatformClient(cfg, credential)
		if err != nil {
			return nil, err
		}
	}
	closeJournal = false
	closeArtifactOutbox = false
	return &Connector{
		cfg:            cfg,
		logger:         logger,
		lifecycle:      platform.NewLifecycle(),
		journal:        journal,
		artifactOutbox: artifactOutbox,
		appGateway:     appGateway,
		adapter:        adapter,
		controller:     controller,
		sourceRuntime:  sourceRuntime,
		platform:       platformClient,
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
	if c.platform == nil {
		credential, err := bootstrapConnectorCredential(ctx, c.cfg, c.logger)
		if err != nil {
			c.lifecycle.Stop()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), c.cfg.ShutdownTimeout)
			shutdownErr := c.closeResources(shutdownCtx)
			cancel()
			c.runMu.Unlock()
			return errors.Join(fmt.Errorf("bootstrap Connector credential: %w", err), shutdownErr)
		}
		c.platform, err = newConnectorPlatformClient(c.cfg, credential)
		if err != nil {
			c.lifecycle.Stop()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), c.cfg.ShutdownTimeout)
			shutdownErr := c.closeResources(shutdownCtx)
			cancel()
			c.runMu.Unlock()
			return errors.Join(err, shutdownErr)
		}
	}
	if err := c.lifecycle.Start(); err != nil {
		c.runMu.Unlock()
		return err
	}
	c.runMu.Unlock()

	serverURL, _ := url.Parse(c.cfg.ConnectorServerURL)
	c.logger.Info("connector started", "server_host", serverURL.Host)
	if err := c.recoverJournalSessions(ctx); err != nil && !errors.Is(err, context.Canceled) {
		c.logger.Warn("connector session recovery incomplete", "error_class", connectorRecoveryErrorClass(err))
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
			if isConnectorCredentialRejected(err) {
				if refreshErr := c.refreshPlatformCredential(ctx); refreshErr != nil {
					c.logger.Warn("connector credential recovery failed", "error_class", connectorRecoveryErrorClass(refreshErr))
				} else {
					c.logger.Info("connector credential recovered")
					delay = connectorInitialReconnectDelay
					continue
				}
			}
			c.logger.Warn("connector platform gateway connect failed", "error_class", connectorGatewayErrorClass(err), "retry_after", delay)
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
			c.logger.Warn("connector platform gateway close failed", "error_class", connectorGatewayErrorClass(closeErr))
		}
		if err != nil && !errors.Is(err, context.Canceled) && ctx.Err() == nil {
			c.logger.Warn("connector platform gateway disconnected", "error_class", connectorGatewayErrorClass(err), "retry_after", delay)
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

func (c *Connector) refreshPlatformCredential(ctx context.Context) error {
	credential, err := bootstrapConnectorCredential(ctx, c.cfg, c.logger)
	if err != nil {
		return err
	}
	client, err := newConnectorPlatformClient(c.cfg, credential)
	if err != nil {
		return err
	}
	c.platform = client
	return nil
}

func isConnectorCredentialRejected(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "status 401") ||
		strings.Contains(message, "status code: 401") ||
		strings.Contains(message, "status code 401") ||
		strings.Contains(message, "got 401")
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
	go func() { readResult <- c.readGatewayMessages(connectionCtx, connection) }()
	sourceRecovered := c.sourceRuntime == nil
	if c.sourceRuntime != nil {
		if err := c.recoverSource(connectionCtx, connection); err != nil {
			c.logger.Warn("initial Codex source recovery unavailable", "error_class", connectorRecoveryErrorClass(err))
		} else {
			sourceRecovered = true
		}
	}
	eventResult := make(chan error, 1)
	artifactResult := make(chan error, 1)
	heartbeatResult := make(chan error, 1)
	sourceResult := make(chan error, 1)
	go func() { eventResult <- c.deliverJournalEvents(connectionCtx, connection) }()
	go func() { artifactResult <- c.uploadPendingArtifacts(connectionCtx, connection) }()
	go func() { heartbeatResult <- c.sendGatewayHeartbeats(connectionCtx, connection) }()
	go func() { sourceResult <- c.deliverSourceNotifications(connectionCtx, connection, !sourceRecovered) }()
	select {
	case err := <-readResult:
		cancel()
		return err
	case err := <-eventResult:
		cancel()
		return err
	case err := <-artifactResult:
		cancel()
		return err
	case err := <-heartbeatResult:
		cancel()
		return err
	case err := <-sourceResult:
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
		case gateway.MessageSourceCommand:
			if err := c.handleGatewaySourceCommand(ctx, connection, message); err != nil {
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

func (c *Connector) handleGatewaySourceCommand(ctx context.Context, connection *gateway.ClientConnection, message gateway.Message) error {
	if message.SourceCommand == nil {
		return errors.New("Connector source command payload is missing")
	}
	command := *message.SourceCommand
	ack := gateway.SourceAck{OperationID: command.OperationID, State: "failed"}
	c.sourceLifecycleMu.Lock()
	source, err := c.sourceClientLocked(ctx)
	if err == nil {
		switch command.Method {
		case connectorruntime.SourceMethodSetThreadName:
			err = source.SetTitleWithRetry(ctx, command.ThreadID, command.Title, connectorruntime.SourceRetryPolicy{})
		case connectorruntime.SourceMethodSync:
			var snapshot protocol.CodexSourceSnapshot
			var payload json.RawMessage
			snapshot, err = source.Sync(ctx, command.OperationID)
			if err == nil {
				payload, err = json.Marshal(snapshot)
				ack.Payload = payload
			}
		default:
			err = fmt.Errorf("unsupported Connector source method %q", command.Method)
		}
	}
	c.sourceLifecycleMu.Unlock()
	if err == nil {
		ack.State = "succeeded"
	} else {
		ack.Error = &gateway.WireError{Code: connectorSourceErrorCode(err), Message: "Connector could not complete the Codex source operation"}
		if errors.Is(err, connectorruntime.ErrSourceCapabilityUnsupported) {
			ack.State = "unsupported"
		}
	}
	return connection.AcknowledgeSource(ctx, message.RequestID, ack)
}

func connectorSourceErrorCode(err error) string {
	switch {
	case errors.Is(err, connectorruntime.ErrSourceCapabilityUnsupported):
		return "unsupported_capability"
	case errors.Is(err, connectorruntime.ErrTransportClosed):
		return "source_unavailable"
	default:
		return "source_operation_failed"
	}
}

func (c *Connector) sourceClient(ctx context.Context) (*connectorruntime.SourceClient, error) {
	c.sourceLifecycleMu.Lock()
	defer c.sourceLifecycleMu.Unlock()
	return c.sourceClientLocked(ctx)
}

func (c *Connector) sourceClientLocked(ctx context.Context) (*connectorruntime.SourceClient, error) {
	c.sourceMu.Lock()
	defer c.sourceMu.Unlock()
	if c.source != nil {
		return c.source, nil
	}
	if c.sourceRuntime == nil {
		return nil, errors.New("Connector Codex source runtime is unavailable")
	}
	source, err := c.sourceRuntime.Connect(ctx)
	if err != nil {
		return nil, err
	}
	c.source = source
	return source, nil
}

func (c *Connector) resetSource(source *connectorruntime.SourceClient) {
	c.sourceMu.Lock()
	if c.source == source {
		c.source = nil
	}
	c.sourceMu.Unlock()
	if source != nil {
		_ = source.Close()
	}
}

func (c *Connector) recoverSource(ctx context.Context, connection *gateway.ClientConnection) error {
	c.sourceLifecycleMu.Lock()
	defer c.sourceLifecycleMu.Unlock()
	return c.recoverSourceLocked(ctx, connection)
}

func (c *Connector) recoverSourceLocked(ctx context.Context, connection *gateway.ClientConnection) error {
	if c.sourceRuntime == nil {
		return errors.New("Connector Codex source runtime is unavailable")
	}
	source, snapshot, _, err := c.sourceRuntime.ReconnectAndRecover(ctx, nil)
	if err != nil {
		c.sourceMu.Lock()
		c.source = nil
		c.sourceMu.Unlock()
		if source != nil {
			_ = source.Close()
		}
		return err
	}
	if snapshot != nil {
		snapshot.ConnectionGeneration = connection.Generation()
		payload, marshalErr := json.Marshal(snapshot)
		if marshalErr != nil {
			c.sourceMu.Lock()
			c.source = nil
			c.sourceMu.Unlock()
			_ = source.Close()
			return fmt.Errorf("encode recovered Codex source snapshot: %w", marshalErr)
		}
		if err := connection.SendSourceSnapshot(ctx, snapshot.OperationID, gateway.SourceAck{
			OperationID: snapshot.OperationID,
			State:       "succeeded",
			Payload:     payload,
		}); err != nil {
			c.sourceMu.Lock()
			c.source = nil
			c.sourceMu.Unlock()
			_ = source.Close()
			return fmt.Errorf("deliver recovered Codex source snapshot: %w", err)
		}
	}
	c.sourceMu.Lock()
	c.source = source
	c.sourceMu.Unlock()
	return nil
}

func (c *Connector) deliverSourceNotifications(ctx context.Context, connection *gateway.ClientConnection, sourceNeedsRecovery bool) error {
	for {
		if sourceNeedsRecovery {
			if recoverErr := c.recoverSource(ctx, connection); recoverErr == nil {
				sourceNeedsRecovery = false
				continue
			}
			if !waitConnectorRetry(ctx, connectorInitialReconnectDelay) {
				return ctx.Err()
			}
			continue
		}
		source, err := c.sourceClient(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !waitConnectorRetry(ctx, connectorInitialReconnectDelay) {
				return ctx.Err()
			}
			continue
		}
		c.sourceNoticeMu.Lock()
		pending := c.pendingSourceNotice
		c.sourceNoticeMu.Unlock()
		var notification connectorruntime.SourceNotification
		var notificationErr error
		if pending != nil {
			notification = *pending
		} else {
			notification, notificationErr = source.NextNotification(ctx)
		}
		if notificationErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if recoverErr := c.recoverSource(ctx, connection); recoverErr == nil {
				sourceNeedsRecovery = false
				continue
			}
			sourceNeedsRecovery = true
			if !waitConnectorRetry(ctx, connectorInitialReconnectDelay) {
				return ctx.Err()
			}
			continue
		}
		if err := connection.SendSourceNotification(ctx, gateway.SourceNotification{
			EventID:  notification.EventID,
			Kind:     string(notification.Kind),
			ThreadID: notification.ThreadID,
			Title:    notification.Title,
			Raw:      append(json.RawMessage(nil), notification.Raw...),
		}); err != nil {
			c.sourceNoticeMu.Lock()
			pendingCopy := notification
			c.pendingSourceNotice = &pendingCopy
			c.sourceNoticeMu.Unlock()
			return err
		}
		c.sourceNoticeMu.Lock()
		if pending != nil {
			c.pendingSourceNotice = nil
		}
		c.sourceNoticeMu.Unlock()
		source.MarkNotificationDelivered(notification)
	}
}

func (c *Connector) handleGatewayCommand(ctx context.Context, connection *gateway.ClientConnection, message gateway.Message) error {
	if message.Command == nil {
		return errors.New("platform gateway command payload is missing")
	}
	command := *message.Command
	ack, err := c.acceptPlatformCommand(ctx, command)
	if err != nil {
		c.logger.Warn("connector command was not completed", "command_id", command.CommandID, "kind", command.Kind, "error", connectorCommandErrorClass(err))
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
	ack.OperationID = platformOperationID(ack.OperationID)
	return connection.AcknowledgeForSession(ctx, command.SessionID, message.RequestID, ack)
}

func connectorCommandErrorClass(err error) string {
	if errors.Is(err, protocol.ErrUnknownCommandResult) {
		return "unknown_result"
	}
	return "command_rejected"
}

func connectorRecoveryErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	default:
		return "recovery_failed"
	}
}

func connectorGatewayErrorClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	default:
		return "gateway_error"
	}
}

// Adapter operation identities may use NUL as an internal generation
// separator. The public Gateway ACK is persisted in PostgreSQL TEXT, so keep
// the exact identity while encoding the boundary value as safe ASCII.
func platformOperationID(value *string) *string {
	if value == nil || !strings.ContainsRune(*value, '\x00') {
		return value
	}
	encoded := "loomhelm-op-" + base64.RawURLEncoding.EncodeToString([]byte(*value))
	return &encoded
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
		current := after[cursor.SessionID]
		if current == "" || connectorCursorBefore(cursor.Value, current) {
			after[cursor.SessionID] = cursor.Value
		}
	}
	ticker := time.NewTicker(connectorEventPollInterval)
	defer ticker.Stop()
	for {
		progressed, err := c.deliverJournalEventBatch(ctx, connection, after)
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

func (c *Connector) deliverJournalEventBatch(ctx context.Context, connection *gateway.ClientConnection, after map[string]string) (bool, error) {
	progressed := false
	for _, alias := range c.journal.SessionAliases() {
		for {
			page, err := c.journal.ReadMappedEvents(protocol.EventQuery{
				SessionID:   alias.PlatformSessionID,
				AfterCursor: after[alias.PlatformSessionID],
				Limit:       1000,
			})
			if errors.Is(err, protocol.ErrCursorExpired) {
				after[alias.PlatformSessionID] = ""
				continue
			}
			if err != nil {
				return progressed, fmt.Errorf("read mapped Connector events for platform session %q: %w", alias.PlatformSessionID, err)
			}
			if len(page.Events) == 0 {
				if page.HasMore && page.NextCursor != nil && *page.NextCursor != "" {
					cursor := *page.NextCursor
					if err := connection.SendHeartbeatForStream(ctx, alias.PlatformSessionID, "", cursor); err != nil {
						return progressed, err
					}
					after[alias.PlatformSessionID] = cursor
					progressed = true
					continue
				}
				break
			}
			for _, event := range page.Events {
				if err := connection.SendEvent(ctx, event); err != nil {
					return progressed, err
				}
				after[alias.PlatformSessionID] = event.Cursor
				progressed = true
			}
			if page.HasMore && page.NextCursor != nil && *page.NextCursor != "" && *page.NextCursor != after[alias.PlatformSessionID] {
				cursor := *page.NextCursor
				if err := connection.SendHeartbeatForStream(ctx, alias.PlatformSessionID, "", cursor); err != nil {
					return progressed, err
				}
				after[alias.PlatformSessionID] = cursor
				progressed = true
			}
			if !page.HasMore || page.NextCursor == nil || *page.NextCursor == "" {
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
	claimedAdapterSessions := make(map[string]struct{})
	for _, alias := range c.journal.SessionAliases() {
		claimedAdapterSessions[alias.AdapterSessionID] = struct{}{}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := c.recoverExplicitSession(ctx, alias); err != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf("recover Connector platform session %q: %w", alias.PlatformSessionID, err))
		}
	}
	for _, session := range c.journal.Sessions() {
		if _, claimed := claimedAdapterSessions[session.SessionID]; claimed {
			continue
		}
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

func (c *Connector) recoverExplicitSession(ctx context.Context, alias connectorruntime.SessionAlias) error {
	recoveryCtx, cancel := context.WithTimeout(ctx, connectorDialTimeoutFor(c.cfg.ShutdownTimeout))
	reconciliation, err := c.appGateway.ReconcileSession(recoveryCtx, alias.ExternalThreadRef)
	cancel()
	if err != nil {
		return err
	}
	if reconciliation.State != protocol.ReconciliationStateConfirmed {
		note := "unknown"
		if reconciliation.Note != nil {
			note = *reconciliation.Note
		}
		return fmt.Errorf("reconciliation remains %s: %s", reconciliation.State, note)
	}
	recovered, err := c.appGateway.RecoveredSession(alias.ExternalThreadRef)
	if err != nil {
		return err
	}
	if err := validateRecoveredGatewaySession(alias, recovered); err != nil {
		_ = c.appGateway.CloseSession(context.Background(), recovered)
		return err
	}
	bound, err := c.adapter.BindRecoveredSession(ctx, recovered, alias.ExternalThreadRef)
	if err != nil {
		_ = c.appGateway.CloseSession(context.Background(), recovered)
		return err
	}
	closeRecovered := true
	defer func() {
		if closeRecovered {
			_ = c.adapter.CloseSession(context.Background(), bound)
			_ = c.appGateway.CloseSession(context.Background(), recovered)
		}
	}()
	if err := validateRecoveredSessionIdentity(alias, recovered, bound); err != nil {
		return err
	}
	if err := c.RotateSessionIdentity(alias.PlatformSessionID, alias.CommandID, recovered, bound); err != nil {
		return err
	}
	closeRecovered = false
	return nil
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
	if c.artifactOutbox != nil {
		if err := c.artifactOutbox.Close(); err != nil {
			closeErrors = append(closeErrors, fmt.Errorf("close connector artifact outbox: %w", err))
		}
	}
	c.sourceLifecycleMu.Lock()
	c.sourceMu.Lock()
	source := c.source
	c.source = nil
	c.sourceMu.Unlock()
	if source != nil {
		if err := source.Close(); err != nil {
			closeErrors = append(closeErrors, fmt.Errorf("close connector Codex source: %w", err))
		}
	}
	c.sourceLifecycleMu.Unlock()
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
