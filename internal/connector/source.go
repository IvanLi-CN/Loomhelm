package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

var (
	ErrSourceCapabilityUnsupported = errors.New("Codex source capability is unsupported")
	ErrSourceInvalidParams         = errors.New("Codex source request parameters are invalid")
	ErrSourceHistoryIncomplete     = errors.New("Codex source history is incomplete")
	ErrSourceNotificationOverflow  = errors.New("Codex source notification queue exceeded its memory limit")
)

const (
	SourceMethodThreadList        = "thread/list"
	SourceMethodThreadRead        = "thread/read"
	SourceMethodThreadTurnsList   = "thread/turns/list"
	SourceMethodThreadItemsList   = "thread/items/list"
	SourceMethodProjectList       = "project/list"
	SourceMethodAttachmentList    = "thread/attachment/list"
	SourceMethodSetThreadName     = "thread/name/set"
	SourceMethodSync              = "source/sync"
	SourceNotificationName        = "thread/name/updated"
	SourceMethodThreadArchived    = "thread/archived"
	SourceMethodThreadDeleted     = "thread/deleted"
	SourceMethodThreadUnavailable = "thread/unavailable"
)

// SourceRPCError preserves the app-server error code and method. Callers can
// distinguish an unsupported capability from a transport failure without
// exposing the raw error to an API consumer.
type SourceRPCError struct {
	Method  string
	Code    int
	Message string
}

func (e *SourceRPCError) Error() string {
	return fmt.Sprintf("Codex app-server %s failed with code %d: %s", e.Method, e.Code, e.Message)
}

func (e *SourceRPCError) Unwrap() error {
	if e == nil {
		return nil
	}
	if e.Code == -32602 {
		return ErrSourceInvalidParams
	}
	if isCapabilityUnsupported(e.Code, e.Message) {
		return ErrSourceCapabilityUnsupported
	}
	return nil
}

func isCapabilityUnsupported(code int, message string) bool {
	if code == -32601 {
		return true
	}
	if code == -32602 {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(message))
	return code == -32600 &&
		(strings.Contains(lower, "requires") && strings.Contains(lower, "capability"))
}

type SourceThread struct {
	ID           string
	Name         *string
	Preview      string
	CWD          string
	ProjectID    string
	ParentThread string
	SourceKind   string
	Status       string
	Archived     bool
	CreatedAt    string
	UpdatedAt    string
	Raw          json.RawMessage
}

type SourceProject struct {
	ID        string
	Name      string
	CWD       string
	CreatedAt string
	UpdatedAt string
	Raw       json.RawMessage
}

type SourceHistoryEvent struct {
	ID         string
	Source     string
	Sequence   int64
	Type       string
	Raw        json.RawMessage
	Fallback   string
	OccurredAt string
}

type SourceFileMaterial struct {
	Path        string
	ContentType string
	Size        int64
	SHA256      string
	Bytes       []byte
	ContentRef  string
	Complete    bool
	Raw         json.RawMessage
}

type SourceHistorySnapshot struct {
	Thread             SourceThread
	Events             []SourceHistoryEvent
	Files              []SourceFileMaterial
	HistoryComplete    bool
	FilesComplete      bool
	UnsupportedMethods []string
	AsOf               time.Time
	RawThread          json.RawMessage
}

type SourceListOptions struct {
	Cursor   string
	Limit    int
	Archived *bool
}

type SourcePage[T any] struct {
	Items     []T
	Next      string
	RawResult json.RawMessage
}

type SourceNotificationKind string

const (
	SourceNotificationTitle       SourceNotificationKind = "title_updated"
	SourceNotificationArchived    SourceNotificationKind = "archived"
	SourceNotificationDeleted     SourceNotificationKind = "deleted"
	SourceNotificationUnavailable SourceNotificationKind = "unavailable"
)

type SourceNotification struct {
	Kind           SourceNotificationKind
	ThreadID       string
	Title          *string
	Raw            json.RawMessage
	EventID        string
	SourceIdentity string
}

// SourceClient is the read/import and title-write boundary for one
// Host-local app-server transport. It never starts or resumes a thread.
type SourceClient struct {
	transport      RPCTransport
	handshake      AppServerHandshake
	capMu          sync.RWMutex
	noticeMu       sync.Mutex
	seenNotice     map[string]struct{}
	pendingNotice  *SourceNotification
	pendingNotices []SourceNotification
	noticeEvents   chan RPCMessage
	noticeErrors   chan error
	noticePumpDone chan struct{}
}

func NewSourceClient(ctx context.Context, transport RPCTransport, client ClientInfo) (*SourceClient, error) {
	if ctx == nil {
		return nil, errors.New("Codex source context must not be nil")
	}
	if transport == nil {
		return nil, errors.New("Codex source transport must not be nil")
	}
	if client.Name == "" {
		client.Name = "loomhelm_connector_source"
	}
	if client.Title == "" {
		client.Title = "Loomhelm Codex Source"
	}
	if client.Version == "" {
		client.Version = "dev"
	}
	handshake, err := initializeAppServer(ctx, transport, client)
	if err != nil {
		return nil, err
	}
	source := &SourceClient{
		transport:      transport,
		handshake:      handshake,
		seenNotice:     make(map[string]struct{}),
		noticeEvents:   make(chan RPCMessage, 256),
		noticeErrors:   make(chan error, 1),
		noticePumpDone: make(chan struct{}),
	}
	go source.pumpNotifications()
	return source, nil
}

func (c *SourceClient) Handshake() AppServerHandshake {
	if c == nil {
		return AppServerHandshake{}
	}
	c.capMu.RLock()
	defer c.capMu.RUnlock()
	return cloneHandshake(c.handshake)
}

func (c *SourceClient) Capability(method string) CapabilityState {
	if c == nil {
		return CapabilityUnknown
	}
	c.capMu.RLock()
	defer c.capMu.RUnlock()
	if state, ok := c.handshake.Capabilities[method]; ok {
		return state
	}
	return CapabilityUnknown
}

func (c *SourceClient) Close() error {
	if c == nil || c.transport == nil {
		return nil
	}
	return c.transport.Close()
}

func (c *SourceClient) DiscoverProjects(ctx context.Context, options SourceListOptions) (SourcePage[SourceProject], error) {
	params := pageParams(options)
	result, err := c.call(ctx, SourceMethodProjectList, params)
	if err != nil {
		return SourcePage[SourceProject]{}, err
	}
	items, next, err := decodeProjectPage(result)
	if err != nil {
		return SourcePage[SourceProject]{}, fmt.Errorf("decode Codex project/list response: %w", err)
	}
	return SourcePage[SourceProject]{Items: items, Next: next, RawResult: append(json.RawMessage(nil), result...)}, nil
}

func (c *SourceClient) DiscoverThreads(ctx context.Context, options SourceListOptions) (SourcePage[SourceThread], error) {
	params := pageParams(options)
	result, err := c.call(ctx, SourceMethodThreadList, params)
	if err != nil {
		return SourcePage[SourceThread]{}, err
	}
	items, next, err := decodeThreadPage(result)
	if err != nil {
		return SourcePage[SourceThread]{}, fmt.Errorf("decode Codex thread/list response: %w", err)
	}
	return SourcePage[SourceThread]{Items: items, Next: next, RawResult: append(json.RawMessage(nil), result...)}, nil
}

// Sync performs a bounded cold discovery and returns an explicit source
// snapshot. A thread with incomplete history remains in the payload so the
// persistence layer can retain its raw material while keeping it out of
// project-visible bindings.
func (c *SourceClient) Sync(ctx context.Context, operationID string) (protocol.CodexSourceSnapshot, error) {
	if c == nil {
		return protocol.CodexSourceSnapshot{}, ErrTransportClosed
	}
	handshake := c.Handshake()
	snapshot := protocol.CodexSourceSnapshot{
		OperationID:      strings.TrimSpace(operationID),
		State:            protocol.CodexSourceStateOnline,
		SyncState:        protocol.CodexSyncStateComplete,
		Build:            handshake.Build,
		ProtocolVersion:  handshake.ProtocolVersion,
		Capabilities:     supportedCapabilities(handshake.Capabilities),
		CapabilityStates: capabilityStates(handshake.Capabilities),
		AsOf:             time.Now().UTC(),
		Projects:         make([]protocol.CodexSourceProjectSnapshot, 0),
		Threads:          make([]protocol.CodexSourceThreadSnapshot, 0),
	}
	projects, projectErr := c.discoverAllProjects(ctx)
	if projectErr != nil && !errors.Is(projectErr, ErrSourceCapabilityUnsupported) {
		return protocol.CodexSourceSnapshot{}, projectErr
	}
	if projectErr != nil {
		snapshot.SyncState = protocol.CodexSyncStatePartial
		snapshot.Error = projectErr.Error()
	}
	for _, project := range projects {
		snapshot.Projects = append(snapshot.Projects, protocol.CodexSourceProjectSnapshot{
			ProjectID: project.ID,
			Name:      project.Name,
			CWD:       project.CWD,
			AsOf:      snapshot.AsOf,
		})
	}
	threads, threadErr := c.discoverAllThreads(ctx)
	if threadErr != nil && !errors.Is(threadErr, ErrSourceCapabilityUnsupported) {
		return protocol.CodexSourceSnapshot{}, threadErr
	}
	if threadErr != nil {
		snapshot.SyncState = protocol.CodexSyncStatePartial
		if snapshot.Error == "" {
			snapshot.Error = threadErr.Error()
		}
	}
	threadSnapshots := make([]protocol.CodexSourceThreadSnapshot, len(threads))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	// Full turn/item history is fetched lazily by the conversation endpoint;
	// the source sync deadline is reserved for a complete, responsive thread
	// inventory. Keeping this at zero avoids blocking synchronization on very
	// large historical rollouts.
	const maxDetailedThreads = 1
	for index, thread := range threads {
		index, thread := index, thread
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			var history SourceHistorySnapshot
			var readErr error
			if index < maxDetailedThreads {
				history, readErr = c.ReadHistory(ctx, thread.ID)
			} else {
				history = SourceHistorySnapshot{Thread: thread, HistoryComplete: false, FilesComplete: false, AsOf: time.Now().UTC(), RawThread: append(json.RawMessage(nil), thread.Raw...)}
			}
			if history.Thread.ID == "" {
				history.Thread = thread
			}
			threadSnapshot := sourceThreadSnapshot(history.Thread, history)
			if readErr != nil {
				threadSnapshot.Error = readErr.Error()
				if errors.Is(readErr, ErrSourceHistoryIncomplete) {
					threadSnapshot.HistoryState = protocol.CodexHistoryStatePartial
				} else {
					threadSnapshot.HistoryState = protocol.CodexHistoryStateFailed
				}
				snapshot.SyncState = protocol.CodexSyncStatePartial
				if snapshot.Error == "" {
					snapshot.Error = readErr.Error()
				}
			}
			threadSnapshots[index] = threadSnapshot
		}()
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return protocol.CodexSourceSnapshot{}, err
	}
	snapshot.Threads = append(snapshot.Threads, threadSnapshots...)
	// History and attachment reads can discover capabilities that initialize
	// did not advertise. Persist the post-discovery states, including explicit
	// unsupported methods, with the same snapshot.
	finalHandshake := c.Handshake()
	snapshot.Capabilities = supportedCapabilities(finalHandshake.Capabilities)
	snapshot.CapabilityStates = capabilityStates(finalHandshake.Capabilities)
	return snapshot, nil
}

func (c *SourceClient) discoverAllProjects(ctx context.Context) ([]SourceProject, error) {
	current, err := c.DiscoverProjects(ctx, SourceListOptions{Limit: 100})
	if err != nil {
		return nil, err
	}
	return current.Items, nil
}

func (c *SourceClient) discoverAllThreads(ctx context.Context) ([]SourceThread, error) {
	result := make([]SourceThread, 0)
	seen := make(map[string]struct{})
	for _, archived := range []bool{false, true} {
		cursor := ""
		completed := false
		for page := 0; page < 1; page++ {
			current, err := c.DiscoverThreads(ctx, SourceListOptions{Cursor: cursor, Limit: 100, Archived: boolPointer(archived)})
			if err != nil {
				return nil, err
			}
			for _, thread := range current.Items {
				thread.Archived = archived
				if _, exists := seen[thread.ID]; exists {
					continue
				}
				seen[thread.ID] = struct{}{}
				result = append(result, thread)
			}
			completed = true
		}
		if !completed {
			return nil, errors.New("Codex thread/list exceeded the pagination limit")
		}
	}
	return result, nil
}

func sourceThreadSnapshot(thread SourceThread, history SourceHistorySnapshot) protocol.CodexSourceThreadSnapshot {
	status := sourceThreadStatus(thread)
	sourceKind := protocol.CodexThreadSourceKindMain
	if strings.TrimSpace(thread.SourceKind) == "subagent" || strings.TrimSpace(thread.ParentThread) != "" {
		sourceKind = protocol.CodexThreadSourceKindSubagent
	}
	historyState := protocol.CodexHistoryStateComplete
	if !history.HistoryComplete {
		historyState = protocol.CodexHistoryStatePartial
	}
	filesComplete := history.FilesComplete
	result := protocol.CodexSourceThreadSnapshot{
		ThreadID:       thread.ID,
		ProjectID:      optionalString(thread.ProjectID),
		ParentThreadID: optionalString(thread.ParentThread),
		SourceKind:     sourceKind,
		CodexTitle:     thread.Name,
		Preview:        thread.Preview,
		CWD:            thread.CWD,
		SourceStatus:   status,
		HistoryState:   historyState,
		FilesComplete:  filesComplete,
		LastActivityAt: parseSourceTime(thread.UpdatedAt, history.AsOf),
		RawThread:      append(json.RawMessage(nil), history.RawThread...),
		Events:         make([]protocol.CodexSourceHistoryEvent, 0, len(history.Events)),
		Files:          make([]protocol.CodexSourceFileMaterial, 0, len(history.Files)),
	}
	for _, event := range history.Events {
		result.Events = append(result.Events, protocol.CodexSourceHistoryEvent{
			EventID:          event.ID,
			Sequence:         event.Sequence,
			EventType:        event.Type,
			RawPayload:       append(json.RawMessage(nil), event.Raw...),
			ReadableFallback: event.Fallback,
			OccurredAt:       parseSourceTime(event.OccurredAt, history.AsOf),
		})
	}
	for _, file := range history.Files {
		result.Files = append(result.Files, protocol.CodexSourceFileMaterial{
			Path: file.Path, ContentType: file.ContentType, Size: file.Size, SHA256: file.SHA256,
			Content: append([]byte(nil), file.Bytes...), ContentRef: file.ContentRef, Complete: file.Complete,
		})
	}
	return result
}

func sourceThreadStatus(thread SourceThread) protocol.CodexSourceStatus {
	if thread.Archived {
		return protocol.CodexSourceStatusArchived
	}
	switch strings.ToLower(strings.TrimSpace(thread.Status)) {
	case "archived":
		return protocol.CodexSourceStatusArchived
	case "deleted":
		return protocol.CodexSourceStatusDeleted
	case "unavailable", "not_found", "not-found":
		return protocol.CodexSourceStatusUnavailable
	default:
		return protocol.CodexSourceStatusActive
	}
}

func supportedCapabilities(capabilities map[string]CapabilityState) []string {
	result := make([]string, 0, len(capabilities))
	for method, state := range capabilities {
		if state == CapabilitySupported {
			result = append(result, method)
		}
	}
	sort.Strings(result)
	return result
}

func capabilityStates(capabilities map[string]CapabilityState) map[string]string {
	result := make(map[string]string, len(capabilities))
	for method, state := range capabilities {
		result[method] = string(state)
	}
	return result
}

func parseSourceTime(value string, fallback time.Time) time.Time {
	if parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
		return parsed.UTC()
	}
	return fallback.UTC()
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func boolPointer(value bool) *bool { return &value }

func (c *SourceClient) SetTitle(ctx context.Context, threadID, title string) error {
	if strings.TrimSpace(threadID) == "" || strings.TrimSpace(title) == "" {
		return errors.New("Codex thread id and title must not be empty")
	}
	_, err := c.call(ctx, SourceMethodSetThreadName, map[string]any{
		"threadId": threadID,
		"name":     title,
	})
	if err == nil {
		c.setCapability(SourceMethodSetThreadName, CapabilitySupported)
	}
	return err
}

type SourceRetryPolicy struct {
	MaxAttempts int
	InitialWait time.Duration
}

func (c *SourceClient) SetTitleWithRetry(ctx context.Context, threadID, title string, policy SourceRetryPolicy) error {
	if policy.MaxAttempts < 1 {
		policy.MaxAttempts = 3
	}
	if policy.InitialWait <= 0 {
		policy.InitialWait = 100 * time.Millisecond
	}
	var lastErr error
	wait := policy.InitialWait
	for attempt := 0; attempt < policy.MaxAttempts; attempt++ {
		lastErr = c.SetTitle(ctx, threadID, title)
		if lastErr == nil {
			return nil
		}
		if errors.Is(lastErr, ErrSourceCapabilityUnsupported) {
			return lastErr
		}
		if attempt+1 == policy.MaxAttempts {
			break
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if wait < 2*time.Second {
			wait *= 2
		}
	}
	return lastErr
}

func (c *SourceClient) ReadHistory(ctx context.Context, threadID string) (SourceHistorySnapshot, error) {
	if strings.TrimSpace(threadID) == "" {
		return SourceHistorySnapshot{}, errors.New("Codex thread id must not be empty")
	}
	threadResult, err := c.call(ctx, SourceMethodThreadRead, map[string]any{"threadId": threadID})
	if err != nil {
		return SourceHistorySnapshot{}, err
	}
	thread, err := decodeThreadResult(threadResult)
	if err != nil {
		return SourceHistorySnapshot{}, fmt.Errorf("decode Codex thread/read response: %w", err)
	}
	snapshot := SourceHistorySnapshot{Thread: thread, HistoryComplete: true, FilesComplete: true, RawThread: append(json.RawMessage(nil), threadResult...), AsOf: time.Now().UTC()}
	turnsUnsupported := false
	itemsUnsupported := false
	historyReadFailed := false
	historySourceAvailable := false

	turns, turnsErr := c.readTurns(ctx, threadID)
	if turnsErr != nil {
		if errors.Is(turnsErr, ErrSourceCapabilityUnsupported) {
			snapshot.UnsupportedMethods = append(snapshot.UnsupportedMethods, SourceMethodThreadTurnsList)
			turnsUnsupported = true
		} else {
			historyReadFailed = true
		}
	} else {
		snapshot.Events = append(snapshot.Events, turns...)
		historySourceAvailable = true
	}
	items, itemsErr := c.readItems(ctx, threadID)
	if itemsErr != nil {
		if !errors.Is(itemsErr, ErrSourceCapabilityUnsupported) {
			historyReadFailed = true
		}
		if errors.Is(itemsErr, ErrSourceCapabilityUnsupported) {
			snapshot.UnsupportedMethods = append(snapshot.UnsupportedMethods, SourceMethodThreadItemsList)
			itemsUnsupported = true
		}
	} else {
		snapshot.Events = mergeHistoryEvents(snapshot.Events, items)
		historySourceAvailable = true
	}
	snapshot.HistoryComplete = !historyReadFailed && historySourceAvailable && !(turnsUnsupported && itemsUnsupported)
	files, filesErr := c.readFiles(ctx, threadID)
	if filesErr != nil {
		snapshot.FilesComplete = false
		if errors.Is(filesErr, ErrSourceCapabilityUnsupported) {
			snapshot.UnsupportedMethods = append(snapshot.UnsupportedMethods, SourceMethodAttachmentList)
		}
	} else {
		snapshot.Files = files
		for _, file := range files {
			if !file.Complete {
				snapshot.FilesComplete = false
				break
			}
		}
	}
	if !snapshot.HistoryComplete || !snapshot.FilesComplete {
		return snapshot, fmt.Errorf("%w: history_complete=%t files_complete=%t", ErrSourceHistoryIncomplete, snapshot.HistoryComplete, snapshot.FilesComplete)
	}
	return snapshot, nil
}

func (c *SourceClient) NextNotification(ctx context.Context) (SourceNotification, error) {
	if c == nil || c.transport == nil {
		return SourceNotification{}, ErrTransportClosed
	}
	for {
		c.noticeMu.Lock()
		if c.pendingNotice != nil {
			pending := cloneSourceNotification(*c.pendingNotice)
			c.noticeMu.Unlock()
			return pending, nil
		}
		for len(c.pendingNotices) > 0 {
			notification := c.pendingNotices[0]
			c.pendingNotices = c.pendingNotices[1:]
			key := notificationKey(notification)
			if _, seen := c.seenNotice[key]; seen {
				continue
			}
			c.pendingNotice = &notification
			c.noticeMu.Unlock()
			return notification, nil
		}
		c.noticeMu.Unlock()
		select {
		case <-ctx.Done():
			return SourceNotification{}, ctx.Err()
		case err := <-c.noticeErrors:
			if err == nil {
				return SourceNotification{}, ErrTransportClosed
			}
			return SourceNotification{}, err
		case message, ok := <-c.noticeEvents:
			if !ok {
				return SourceNotification{}, ErrTransportClosed
			}
			notification, ok := parseSourceNotification(message)
			if !ok {
				continue
			}
			c.noticeMu.Lock()
			key := notificationKey(notification)
			_, seen := c.seenNotice[key]
			if seen {
				c.noticeMu.Unlock()
				continue
			}
			c.pendingNotice = &notification
			c.noticeMu.Unlock()
			return notification, nil
		}
	}
}

// pumpNotifications drains the transport event stream while RPC calls are in
// flight. JSON-RPC responses are already delivered to their waiters, so only
// source notifications need to cross the SourceClient boundary. Keeping this
// consumer alive prevents a cold history read from filling the transport's
// shared event queue with responses that Sync does not otherwise inspect.
func (c *SourceClient) pumpNotifications() {
	defer close(c.noticePumpDone)
	defer close(c.noticeEvents)
	events := c.transport.Events()
	if events == nil {
		c.noticeErrors <- ErrTransportClosed
		return
	}
	for message := range events {
		if _, ok := parseSourceNotification(message); !ok {
			continue
		}
		select {
		case c.noticeEvents <- message:
		default:
			select {
			case c.noticeErrors <- ErrSourceNotificationOverflow:
			default:
			}
			_ = c.transport.Close()
			return
		}
	}
}

// MarkNotificationDelivered advances the source cursor only after the
// platform gateway accepted the notification. A failed gateway write can be
// retried after reconnect without losing the source event.
func (c *SourceClient) MarkNotificationDelivered(notification SourceNotification) {
	if c == nil {
		return
	}
	key := notificationKey(notification)
	c.noticeMu.Lock()
	defer c.noticeMu.Unlock()
	c.seenNotice[key] = struct{}{}
	if c.pendingNotice != nil && notificationKey(*c.pendingNotice) == key {
		c.pendingNotice = nil
	}
	for index, pending := range c.pendingNotices {
		if notificationKey(pending) == key {
			c.pendingNotices = append(c.pendingNotices[:index], c.pendingNotices[index+1:]...)
			break
		}
	}
}

type sourceNotificationHandoff struct {
	pending *SourceNotification
	queued  []SourceNotification
}

// takeNotificationHandoff closes the old transport before draining its
// bounded notification queue. The runtime can then move both the in-flight
// notification and every unread queued event to the replacement client.
func (c *SourceClient) takeNotificationHandoff(ctx context.Context) sourceNotificationHandoff {
	if c == nil {
		return sourceNotificationHandoff{}
	}
	_ = c.Close()
	select {
	case <-c.noticePumpDone:
	case <-ctx.Done():
	}

	handoff := sourceNotificationHandoff{queued: make([]SourceNotification, 0)}
	c.noticeMu.Lock()
	if c.pendingNotice != nil {
		pending := cloneSourceNotification(*c.pendingNotice)
		handoff.pending = &pending
		c.pendingNotice = nil
	}
	c.noticeMu.Unlock()
	for {
		select {
		case message, ok := <-c.noticeEvents:
			if !ok {
				return handoff
			}
			notification, ok := parseSourceNotification(message)
			if ok {
				handoff.queued = append(handoff.queued, notification)
			}
		default:
			return handoff
		}
	}
}

func (c *SourceClient) enqueueNotificationHandoff(handoff sourceNotificationHandoff) {
	if c == nil {
		return
	}
	c.noticeMu.Lock()
	defer c.noticeMu.Unlock()
	if handoff.pending != nil {
		pending := cloneSourceNotification(*handoff.pending)
		c.pendingNotice = &pending
	}
	c.pendingNotices = append(c.pendingNotices, handoff.queued...)
}

func (c *SourceClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c == nil || c.transport == nil {
		return nil, ErrTransportClosed
	}
	result, err := c.transport.Call(ctx, method, mustRawJSON(params))
	if err != nil {
		return nil, err
	}
	if result.Error != nil {
		if isCapabilityUnsupported(result.Error.Code, result.Error.Message) {
			c.setCapability(method, CapabilityUnsupported)
		}
		return nil, &SourceRPCError{Method: method, Code: result.Error.Code, Message: result.Error.Message}
	}
	if len(json.RawMessage(result.Result)) == 0 || !json.Valid(result.Result) {
		return nil, fmt.Errorf("Codex app-server %s returned an invalid result", method)
	}
	c.setCapability(method, CapabilitySupported)
	return append(json.RawMessage(nil), result.Result...), nil
}

func (c *SourceClient) setCapability(method string, state CapabilityState) {
	c.capMu.Lock()
	defer c.capMu.Unlock()
	c.handshake.Capabilities[method] = state
}

func pageParams(options SourceListOptions) map[string]any {
	params := make(map[string]any)
	if options.Cursor != "" {
		params["cursor"] = options.Cursor
	}
	if options.Limit > 0 {
		params["limit"] = options.Limit
	}
	if options.Archived != nil {
		params["archived"] = *options.Archived
	}
	return params
}

func (c *SourceClient) readTurns(ctx context.Context, threadID string) ([]SourceHistoryEvent, error) {
	var events []SourceHistoryEvent
	cursor := ""
	for page := 0; page < 100; page++ {
		params := map[string]any{"threadId": threadID, "itemsView": "full", "sortDirection": "asc", "limit": 100}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := c.call(ctx, SourceMethodThreadTurnsList, params)
		if err != nil {
			return nil, err
		}
		values, next, err := decodeRawPage(result, "turns")
		if err != nil {
			return nil, err
		}
		for _, value := range values {
			events = append(events, rawHistoryEvent(value, int64(len(events)+1), "turn"))
		}
		if next == "" {
			return events, nil
		}
		if next == cursor {
			return nil, errors.New("Codex thread/turns/list returned a repeated cursor")
		}
		cursor = next
	}
	return nil, errors.New("Codex thread/turns/list exceeded the pagination limit")
}

func (c *SourceClient) readItems(ctx context.Context, threadID string) ([]SourceHistoryEvent, error) {
	var events []SourceHistoryEvent
	cursor := ""
	for page := 0; page < 100; page++ {
		params := map[string]any{"threadId": threadID, "sortDirection": "asc", "limit": 100}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := c.call(ctx, SourceMethodThreadItemsList, params)
		if err != nil {
			return nil, err
		}
		values, next, err := decodeRawPage(result, "items")
		if err != nil {
			return nil, err
		}
		for _, value := range values {
			events = append(events, rawHistoryEvent(value, int64(len(events)+1), "item"))
		}
		if next == "" {
			return events, nil
		}
		if next == cursor {
			return nil, errors.New("Codex thread/items/list returned a repeated cursor")
		}
		cursor = next
	}
	return nil, errors.New("Codex thread/items/list exceeded the pagination limit")
}

func (c *SourceClient) readFiles(ctx context.Context, threadID string) ([]SourceFileMaterial, error) {
	files := make([]SourceFileMaterial, 0)
	cursor := ""
	for page := 0; page < 100; page++ {
		params := map[string]any{"threadId": threadID, "limit": 100}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := c.call(ctx, SourceMethodAttachmentList, params)
		if err != nil {
			return nil, err
		}
		values, next, err := decodeRawPage(result, "attachments")
		if err != nil {
			return nil, err
		}
		for _, value := range values {
			file, err := decodeFileMaterial(value)
			if err != nil {
				return nil, err
			}
			files = append(files, file)
		}
		if next == "" {
			return files, nil
		}
		if next == cursor {
			return nil, errors.New("Codex thread/attachment/list returned a repeated cursor")
		}
		cursor = next
	}
	return nil, errors.New("Codex thread/attachment/list exceeded the pagination limit")
}

func initializeSourceCapabilities(value map[string]CapabilityState) {
	for _, method := range []string{
		SourceMethodThreadList,
		SourceMethodThreadRead,
		SourceMethodThreadTurnsList,
		SourceMethodThreadItemsList,
		SourceMethodProjectList,
		SourceMethodAttachmentList,
		SourceMethodSetThreadName,
	} {
		if _, ok := value[method]; !ok {
			value[method] = CapabilityUnknown
		}
	}
}

func parseAppServerHandshake(raw json.RawMessage) (AppServerHandshake, error) {
	var payload struct {
		ProtocolVersion string `json:"protocolVersion"`
		ServerInfo      struct {
			Name    string `json:"name"`
			Title   string `json:"title"`
			Version string `json:"version"`
			Build   string `json:"build"`
		} `json:"serverInfo"`
		UserAgent    string                     `json:"userAgent"`
		Build        string                     `json:"build"`
		Version      string                     `json:"version"`
		Capabilities map[string]json.RawMessage `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return AppServerHandshake{}, fmt.Errorf("decode app-server initialize result: %w", err)
	}
	capabilities := make(map[string]CapabilityState)
	experimental := false
	for key, value := range payload.Capabilities {
		var enabled bool
		if json.Unmarshal(value, &enabled) == nil && enabled {
			capabilities[key] = CapabilitySupported
			if key == "experimentalApi" {
				experimental = true
			}
			continue
		}
		capabilities[key] = CapabilityUnknown
	}
	initializeSourceCapabilities(capabilities)
	userAgentBuild, userAgentVersion := userAgentIdentity(payload.UserAgent)
	build := firstNonEmpty(payload.ServerInfo.Build, payload.Build, userAgentBuild)
	if strings.TrimSpace(build) == "" {
		return AppServerHandshake{}, errors.New("app-server initialize did not provide an exact build")
	}
	return AppServerHandshake{
		ProtocolVersion: payload.ProtocolVersion,
		ServerName:      firstNonEmpty(payload.ServerInfo.Name, payload.UserAgent),
		ServerTitle:     payload.ServerInfo.Title,
		ServerVersion:   firstNonEmpty(payload.ServerInfo.Version, userAgentVersion),
		Build:           build,
		ExperimentalAPI: experimental,
		Capabilities:    capabilities,
		Raw:             append(json.RawMessage(nil), raw...),
	}, nil
}

func userAgentIdentity(userAgent string) (build, version string) {
	value := strings.TrimSpace(userAgent)
	for _, prefix := range []string{"Codex Desktop/", "Codex/", "codex-cli "} {
		index := strings.Index(value, prefix)
		if index < 0 {
			continue
		}
		remainder := value[index+len(prefix):]
		end := len(remainder)
		if space := strings.IndexAny(remainder, " (,"); space >= 0 {
			end = space
		}
		version = strings.TrimSpace(remainder[:end])
		if version != "" {
			return prefix + version, version
		}
	}
	// Host-local app-server builds may use the negotiated client originator as
	// the user-agent prefix. Preserve that exact observed identity even when
	// its prefix is not one of the known Codex variants.
	return value, ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func decodeThreadPage(raw json.RawMessage) ([]SourceThread, string, error) {
	values, next, err := decodeRawPage(raw, "threads")
	if err != nil {
		return nil, "", err
	}
	items := make([]SourceThread, 0, len(values))
	for _, value := range values {
		item, err := decodeThread(value)
		if err != nil {
			return nil, "", err
		}
		items = append(items, item)
	}
	return items, next, nil
}

func decodeProjectPage(raw json.RawMessage) ([]SourceProject, string, error) {
	values, next, err := decodeRawPage(raw, "projects")
	if err != nil {
		return nil, "", err
	}
	items := make([]SourceProject, 0, len(values))
	for _, value := range values {
		var item struct {
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			CWD       string          `json:"cwd"`
			CreatedAt json.RawMessage `json:"createdAt"`
			UpdatedAt json.RawMessage `json:"updatedAt"`
		}
		if err := json.Unmarshal(value, &item); err != nil || strings.TrimSpace(item.ID) == "" {
			return nil, "", errors.New("Codex project item has no id")
		}
		items = append(items, SourceProject{ID: item.ID, Name: item.Name, CWD: item.CWD, CreatedAt: timestampText(item.CreatedAt), UpdatedAt: timestampText(item.UpdatedAt), Raw: append(json.RawMessage(nil), value...)})
	}
	return items, next, nil
}

func decodeThreadResult(raw json.RawMessage) (SourceThread, error) {
	var envelope struct {
		Thread json.RawMessage `json:"thread"`
	}
	if json.Unmarshal(raw, &envelope) != nil || len(envelope.Thread) == 0 {
		return SourceThread{}, errors.New("Codex thread response has no thread")
	}
	return decodeThread(envelope.Thread)
}

func decodeThread(raw json.RawMessage) (SourceThread, error) {
	var item struct {
		ID           string          `json:"id"`
		Name         *string         `json:"name"`
		Preview      string          `json:"preview"`
		FirstMessage string          `json:"firstUserMessage"`
		CWD          string          `json:"cwd"`
		ProjectID    string          `json:"projectId"`
		ParentID     string          `json:"parentThreadId"`
		SourceKind   string          `json:"sourceKind"`
		Status       json.RawMessage `json:"status"`
		Archived     bool            `json:"archived"`
		CreatedAt    json.RawMessage `json:"createdAt"`
		UpdatedAt    json.RawMessage `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &item); err != nil || strings.TrimSpace(item.ID) == "" {
		return SourceThread{}, errors.New("Codex thread item has no id")
	}
	status := string(item.Status)
	if json.Valid(item.Status) {
		var statusText string
		if json.Unmarshal(item.Status, &statusText) == nil {
			status = statusText
		} else {
			var statusObject struct {
				Type      string `json:"type"`
				State     string `json:"state"`
				Status    string `json:"status"`
				Archived  bool   `json:"archived"`
				Deleted   bool   `json:"deleted"`
				Available *bool  `json:"available"`
			}
			if json.Unmarshal(item.Status, &statusObject) == nil {
				switch {
				case statusObject.Deleted:
					status = "deleted"
				case statusObject.Archived:
					status = "archived"
				case statusObject.Available != nil && !*statusObject.Available:
					status = "unavailable"
				default:
					status = firstNonEmpty(statusObject.Type, statusObject.State, statusObject.Status)
				}
			}
		}
	}
	return SourceThread{ID: item.ID, Name: item.Name, Preview: firstNonEmpty(item.Preview, item.FirstMessage), CWD: item.CWD, ProjectID: item.ProjectID, ParentThread: item.ParentID, SourceKind: item.SourceKind, Status: status, Archived: item.Archived, CreatedAt: timestampText(item.CreatedAt), UpdatedAt: timestampText(item.UpdatedAt), Raw: append(json.RawMessage(nil), raw...)}, nil
}

func timestampText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var seconds float64
	if json.Unmarshal(raw, &seconds) == nil {
		return time.Unix(int64(seconds), int64((seconds-float64(int64(seconds)))*float64(time.Second))).UTC().Format(time.RFC3339Nano)
	}
	return ""
}

func decodeRawPage(raw json.RawMessage, field string) ([]json.RawMessage, string, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, "", err
	}
	pageField := field
	if _, ok := object[pageField]; !ok {
		if _, ok := object["data"]; ok {
			pageField = "data"
		} else if _, ok := object["items"]; ok {
			pageField = "items"
		} else {
			return nil, "", fmt.Errorf("Codex %s response has no page data", field)
		}
	}
	if bytes.Equal(bytes.TrimSpace(object[pageField]), []byte("null")) {
		return nil, "", fmt.Errorf("Codex %s response has null page data", field)
	}
	var page struct {
		Data        []json.RawMessage `json:"data"`
		Items       []json.RawMessage `json:"items"`
		Threads     []json.RawMessage `json:"threads"`
		Projects    []json.RawMessage `json:"projects"`
		Turns       []json.RawMessage `json:"turns"`
		Attachments []json.RawMessage `json:"attachments"`
		NextCursor  *string           `json:"nextCursor"`
		NextSnake   *string           `json:"next_cursor"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, "", err
	}
	var values []json.RawMessage
	switch field {
	case "items":
		values = page.Items
	case "threads":
		values = page.Threads
	case "projects":
		values = page.Projects
	case "turns":
		values = page.Turns
	case "attachments":
		values = page.Attachments
	default:
		return nil, "", fmt.Errorf("unsupported Codex page field %q", field)
	}
	if pageField == "data" {
		values = page.Data
	}
	if values == nil {
		return nil, "", fmt.Errorf("Codex %s response has malformed page data", field)
	}
	next := ""
	if page.NextCursor != nil {
		next = strings.TrimSpace(*page.NextCursor)
	} else if page.NextSnake != nil {
		next = strings.TrimSpace(*page.NextSnake)
	}
	return values, next, nil
}

func rawHistoryEvent(raw json.RawMessage, sequence int64, fallbackType string) SourceHistoryEvent {
	var value struct {
		ID        string          `json:"id"`
		Type      string          `json:"type"`
		CreatedAt json.RawMessage `json:"createdAt"`
	}
	_ = json.Unmarshal(raw, &value)
	id := strings.TrimSpace(value.ID)
	if id == "" {
		// Keep same-source repeated payloads distinct by occurrence, then let
		// mergeHistoryEvents collapse the same payload across turns/items.
		digest := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%s", fallbackType, sequence, raw)))
		id = "codex-" + hex.EncodeToString(digest[:12])
	}
	eventType := firstNonEmpty(value.Type, fallbackType)
	return SourceHistoryEvent{ID: id, Source: fallbackType, Sequence: sequence, Type: eventType, Raw: append(json.RawMessage(nil), raw...), Fallback: eventType, OccurredAt: timestampText(value.CreatedAt)}
}

func mergeHistoryEvents(left, right []SourceHistoryEvent) []SourceHistoryEvent {
	seen := make(map[string]struct{}, len(left)+len(right))
	seenPayloadSource := make(map[string]string, len(left)+len(right))
	result := make([]SourceHistoryEvent, 0, len(left)+len(right))
	for _, event := range append(append([]SourceHistoryEvent(nil), left...), right...) {
		if _, ok := seen[event.ID]; ok {
			continue
		}
		payloadKey := historyEventPayloadKey(event.Raw)
		if priorSource, ok := seenPayloadSource[payloadKey]; ok && priorSource != "" && event.Source != "" && priorSource != event.Source {
			continue
		}
		seen[event.ID] = struct{}{}
		if event.Source != "" {
			seenPayloadSource[payloadKey] = event.Source
		}
		result = append(result, event)
	}
	sort.SliceStable(result, func(leftIndex, rightIndex int) bool {
		leftEvent, rightEvent := result[leftIndex], result[rightIndex]
		leftOccurredAt, leftKnown := parseHistoryEventTime(leftEvent.OccurredAt)
		rightOccurredAt, rightKnown := parseHistoryEventTime(rightEvent.OccurredAt)
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftKnown && !leftOccurredAt.Equal(rightOccurredAt) {
			return leftOccurredAt.Before(rightOccurredAt)
		}
		if leftEvent.Sequence != rightEvent.Sequence {
			return leftEvent.Sequence < rightEvent.Sequence
		}
		return leftEvent.ID < rightEvent.ID
	})
	for index := range result {
		result[index].Sequence = int64(index + 1)
	}
	return result
}

func historyEventPayloadKey(raw json.RawMessage) string {
	var compact bytes.Buffer
	if json.Compact(&compact, raw) == nil {
		raw = compact.Bytes()
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func parseHistoryEventTime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, false
	}
	return parsed.UTC(), true
}

func decodeFileMaterial(raw json.RawMessage) (SourceFileMaterial, error) {
	var value struct {
		Path        string `json:"path"`
		Name        string `json:"name"`
		ContentType string `json:"contentType"`
		Size        int64  `json:"size"`
		SHA256      string `json:"sha256"`
		ContentRef  string `json:"contentRef"`
		Content     string `json:"content"`
		ContentB64  string `json:"contentBytes"`
		Complete    *bool  `json:"complete"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return SourceFileMaterial{}, err
	}
	path := firstNonEmpty(value.Path, value.Name)
	if path == "" {
		return SourceFileMaterial{}, errors.New("Codex attachment has no path")
	}
	var content []byte
	if value.ContentB64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(value.ContentB64)
		if err != nil {
			return SourceFileMaterial{}, fmt.Errorf("decode Codex attachment bytes: %w", err)
		}
		content = decoded
	} else if value.Content != "" {
		content = []byte(value.Content)
	}
	if value.Size < 0 {
		return SourceFileMaterial{}, errors.New("Codex attachment size must not be negative")
	}
	if value.Size == 0 && len(content) > 0 {
		value.Size = int64(len(content))
	} else if value.Size > 0 && int64(len(content)) > 0 && value.Size != int64(len(content)) {
		return SourceFileMaterial{}, fmt.Errorf("Codex attachment size %d does not match %d decoded bytes", value.Size, len(content))
	}
	if value.SHA256 != "" && len(content) > 0 {
		digest := sha256.Sum256(content)
		if !strings.EqualFold(value.SHA256, hex.EncodeToString(digest[:])) {
			return SourceFileMaterial{}, errors.New("Codex attachment sha256 does not match decoded bytes")
		}
	}
	complete := value.Complete == nil && (value.ContentRef != "" || len(content) > 0)
	if value.Complete != nil {
		complete = *value.Complete
	}
	return SourceFileMaterial{Path: path, ContentType: value.ContentType, Size: value.Size, SHA256: value.SHA256, Bytes: content, ContentRef: value.ContentRef, Complete: complete, Raw: append(json.RawMessage(nil), raw...)}, nil
}

func parseSourceNotification(message RPCMessage) (SourceNotification, bool) {
	var params struct {
		ThreadID        string          `json:"threadId"`
		Name            *string         `json:"name"`
		ThreadName      *string         `json:"threadName"`
		EventID         string          `json:"eventId"`
		EventIDSnake    string          `json:"event_id"`
		Sequence        json.RawMessage `json:"sequence"`
		SequenceSnake   json.RawMessage `json:"eventSequence"`
		SequenceSnakeID json.RawMessage `json:"event_sequence"`
	}
	if !message.IsNotification() || strings.TrimSpace(message.Method) == "" {
		return SourceNotification{}, false
	}
	if json.Unmarshal(message.Params, &params) != nil || strings.TrimSpace(params.ThreadID) == "" {
		return SourceNotification{}, false
	}
	var kind SourceNotificationKind
	switch message.Method {
	case SourceNotificationName:
		kind = SourceNotificationTitle
	case SourceMethodThreadArchived:
		kind = SourceNotificationArchived
	case SourceMethodThreadDeleted:
		kind = SourceNotificationDeleted
	case SourceMethodThreadUnavailable:
		kind = SourceNotificationUnavailable
	default:
		return SourceNotification{}, false
	}
	title := params.ThreadName
	if title == nil {
		title = params.Name
	}
	if kind == SourceNotificationTitle && (title == nil || strings.TrimSpace(*title) == "") {
		return SourceNotification{}, false
	}
	sourceIdentity := firstNonEmpty(params.EventID, params.EventIDSnake)
	if sourceIdentity == "" {
		for _, candidate := range []json.RawMessage{params.Sequence, params.SequenceSnake, params.SequenceSnakeID} {
			if len(candidate) == 0 || string(candidate) == "null" {
				continue
			}
			var text string
			if json.Unmarshal(candidate, &text) == nil {
				sourceIdentity = strings.TrimSpace(text)
			} else if json.Valid(candidate) {
				sourceIdentity = strings.TrimSpace(string(candidate))
			}
			if sourceIdentity != "" {
				break
			}
		}
	}
	notification := SourceNotification{Kind: kind, ThreadID: params.ThreadID, Title: title, Raw: append(json.RawMessage(nil), message.Raw...), SourceIdentity: sourceIdentity}
	notification.EventID = notificationKey(notification)
	return notification, true
}

func notificationKey(notification SourceNotification) string {
	if identity := strings.TrimSpace(notification.SourceIdentity); identity != "" {
		return notification.ThreadID + ":" + string(notification.Kind) + ":source:" + identity
	}
	digest := sha256.Sum256(notification.Raw)
	return notification.ThreadID + ":" + string(notification.Kind) + ":" + hex.EncodeToString(digest[:])
}

func cloneSourceNotification(notification SourceNotification) SourceNotification {
	cloned := notification
	cloned.Raw = append(json.RawMessage(nil), notification.Raw...)
	if notification.Title != nil {
		title := *notification.Title
		cloned.Title = &title
	}
	return cloned
}

// SourceRuntime owns reconnection boundaries. Each reconnect creates a fresh
// initialize handshake and cold-reads the requested threads before callers can
// treat the source snapshot as current.
type SourceRuntime struct {
	factory    TransportFactory
	client     ClientInfo
	mu         sync.Mutex
	transport  RPCTransport
	source     *SourceClient
	seenNotice map[string]struct{}
}

func NewSourceRuntime(factory TransportFactory, client ClientInfo) (*SourceRuntime, error) {
	if factory == nil {
		return nil, errors.New("Codex source transport factory must not be nil")
	}
	return &SourceRuntime{factory: factory, client: client, seenNotice: make(map[string]struct{})}, nil
}

func (r *SourceRuntime) Connect(ctx context.Context) (*SourceClient, error) {
	if r == nil {
		return nil, ErrTransportClosed
	}
	transport, err := r.factory(ctx)
	if err != nil {
		return nil, err
	}
	source, err := NewSourceClient(ctx, transport, r.client)
	if err != nil {
		_ = transport.Close()
		return nil, err
	}
	r.mu.Lock()
	source.noticeMu.Lock()
	source.seenNotice = r.seenNotice
	source.noticeMu.Unlock()
	previousSource := r.source
	var handoff sourceNotificationHandoff
	if previousSource != nil {
		handoff = previousSource.takeNotificationHandoff(ctx)
		source.enqueueNotificationHandoff(handoff)
	}
	r.transport = transport
	r.source = source
	r.mu.Unlock()
	return source, nil
}

// ConnectOnly establishes the daemon-backed source client without performing
// a cold history read. Reconnection recovery uses this path; explicit source
// synchronization owns the bounded full discovery operation.
func (r *SourceRuntime) ConnectOnly(ctx context.Context) (*SourceClient, error) {
	return r.Connect(ctx)
}

func (r *SourceRuntime) ReconnectAndRecover(ctx context.Context, threadIDs []string) (*SourceClient, *protocol.CodexSourceSnapshot, []SourceHistorySnapshot, error) {
	source, err := r.Connect(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	if len(threadIDs) == 0 {
		snapshot, err := source.Sync(ctx, fmt.Sprintf("reconnect-%d", time.Now().UnixNano()))
		if err != nil {
			return source, nil, nil, err
		}
		snapshot.Recovery = true
		return source, &snapshot, nil, nil
	}
	snapshots := make([]SourceHistorySnapshot, 0, len(threadIDs))
	for _, threadID := range threadIDs {
		snapshot, readErr := source.ReadHistory(ctx, threadID)
		if readErr != nil {
			return source, nil, snapshots, readErr
		}
		snapshots = append(snapshots, snapshot)
	}
	return source, nil, snapshots, nil
}
