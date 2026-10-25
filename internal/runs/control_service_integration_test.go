package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

func TestNewControlServiceRequiresTransport(t *testing.T) {
	_, err := NewControlService(ControlServiceConfig{Controller: &Controller{store: &Store{}}})
	if !errors.Is(err, ErrControlServiceUnavailable) {
		t.Fatalf("missing transport error = %v, want %v", err, ErrControlServiceUnavailable)
	}
}

func TestPersistentControlServiceAuthorizesActualSessionAndDeduplicatesSubmit(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fixture := newControlFixture(t, db, 2)
	control := newControlServiceFixture(t, db, fixture)

	principal := auth.Principal{UserID: fixture.userID, ProjectScope: map[string]struct{}{fixture.projectA: {}}}
	request := protocol.SubmitRunRequest{CommandID: fixture.command + "-submit", Prompt: "preserve this exact prompt"}
	ackResponse, err := control.service.SubmitRun(ctx, principal, fixture.sessionIDs[0], request)
	if err != nil {
		t.Fatalf("submit run: %v", err)
	}
	ack := ackResponse.Ack
	if ack.State != protocol.CommandStateSucceeded || ack.RunID == nil || ack.Deduplicated {
		t.Fatalf("submit ack = %+v", ack)
	}
	if got := control.transport.sendCount(); got != 1 {
		t.Fatalf("transport sends after first submit = %d, want 1", got)
	}
	acceptedCommand := control.transport.command(0)
	if acceptedCommand.SessionID != fixture.sessionIDs[0] || acceptedCommand.RunID == nil {
		t.Fatalf("submitted command identity = %+v", acceptedCommand)
	}
	var submitted protocol.SubmitRunRequest
	if err := json.Unmarshal(acceptedCommand.Payload, &submitted); err != nil {
		t.Fatalf("decode submitted payload: %v", err)
	}
	if submitted != request {
		t.Fatalf("submitted payload = %+v, want %+v", submitted, request)
	}

	duplicateResponse, err := control.service.SubmitRun(ctx, principal, fixture.sessionIDs[0], request)
	if err != nil {
		t.Fatalf("duplicate submit run: %v", err)
	}
	duplicate := duplicateResponse.Ack
	if !duplicate.Deduplicated || duplicate.CommandID != ack.CommandID || duplicate.RunID == nil || *duplicate.RunID != *ack.RunID {
		t.Fatalf("duplicate submit ack = %+v", duplicate)
	}
	if got := control.transport.sendCount(); got != 1 {
		t.Fatalf("transport sends after duplicate submit = %d, want 1", got)
	}

	otherRequest := request
	otherRequest.CommandID = fixture.command + "-cross-project"
	if _, err := control.service.SubmitRun(ctx, principal, fixture.sessionIDs[1], otherRequest); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("cross-project submit error = %v, want %v", err, auth.ErrForbidden)
	}
	if got := control.transport.sendCount(); got != 1 {
		t.Fatalf("transport sends after unauthorized submit = %d, want 1", got)
	}
	if len(control.authorizer.calls()) != 3 {
		t.Fatalf("authorization calls = %+v, want submit, duplicate, cross-project", control.authorizer.calls())
	}
}

func TestPersistentControlServiceInterruptUsesRunOwnerAndCommandIdentity(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fixture := newControlFixture(t, db, 2)
	control := newControlServiceFixture(t, db, fixture)
	runStore := NewStore(db.Pool())
	run, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         fixture.run,
		SessionID:  fixture.sessionIDs[0],
		CommandID:  fixture.command + "-run",
		Generation: fixture.generation,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := runStore.Start(ctx, run.ID, fixture.generation, "cursor-started"); err != nil {
		t.Fatalf("start run: %v", err)
	}

	principal := auth.Principal{UserID: fixture.userID, ProjectScope: map[string]struct{}{fixture.projectA: {}}}
	reason := "stop this run"
	request := protocol.InterruptRunRequest{CommandID: fixture.command + "-interrupt", Reason: &reason}
	ackResponse, err := control.service.InterruptRun(ctx, principal, run.ID, request)
	if err != nil {
		t.Fatalf("interrupt run: %v", err)
	}
	ack := ackResponse.Ack
	if ack.State != protocol.CommandStateSucceeded || ack.RunID == nil || *ack.RunID != run.ID {
		t.Fatalf("interrupt ack = %+v", ack)
	}
	if got := control.transport.sendCount(); got != 1 {
		t.Fatalf("transport sends after interrupt = %d, want 1", got)
	}
	current, err := runStore.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("read interrupted run request: %v", err)
	}
	if current.Interrupt != InterruptRequested || current.SessionID != fixture.sessionIDs[0] {
		t.Fatalf("interrupt run state = %+v", current)
	}

	duplicateResponse, err := control.service.InterruptRun(ctx, principal, run.ID, request)
	if err != nil {
		t.Fatalf("duplicate interrupt: %v", err)
	}
	duplicate := duplicateResponse.Ack
	got := control.transport.sendCount()
	if !duplicate.Deduplicated || got != 1 {
		t.Fatalf("duplicate interrupt ack = %+v, sends = %d", duplicate, got)
	}

	otherRun, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         fixture.run + "-other",
		SessionID:  fixture.sessionIDs[1],
		CommandID:  fixture.command + "-other-run",
		Generation: fixture.generation,
	})
	if err != nil {
		t.Fatalf("create independent run: %v", err)
	}
	if _, err := runStore.Start(ctx, otherRun.ID, fixture.generation, "cursor-other-started"); err != nil {
		t.Fatalf("start independent run: %v", err)
	}
	otherRequest := protocol.InterruptRunRequest{CommandID: fixture.command + "-other-interrupt"}
	if _, err := control.service.InterruptRun(ctx, principal, otherRun.ID, otherRequest); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("independent-session interrupt error = %v, want %v", err, auth.ErrForbidden)
	}
	if got := control.transport.sendCount(); got != 1 {
		t.Fatalf("transport sends after unauthorized interrupt = %d, want 1", got)
	}
}

func TestPersistentControlServiceApprovalCASAndRevisionBoundaries(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fixture := newControlFixture(t, db, 1)
	control := newControlServiceFixture(t, db, fixture)
	runStore := NewStore(db.Pool())
	approvalStore := approvals.NewStore(db.Pool())
	run, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         fixture.run,
		SessionID:  fixture.sessionIDs[0],
		CommandID:  fixture.command + "-run",
		Generation: fixture.generation,
	})
	if err != nil {
		t.Fatalf("create approval run: %v", err)
	}
	if _, err := runStore.Start(ctx, run.ID, fixture.generation, "cursor-started"); err != nil {
		t.Fatalf("start approval run: %v", err)
	}
	if _, err := runStore.WaitForApproval(ctx, run.ID, fixture.generation, "cursor-approval"); err != nil {
		t.Fatalf("wait for approval: %v", err)
	}
	approval, err := approvalStore.Create(ctx, approvals.CreateRequest{
		NewInput: approvals.NewInput{
			ID:          fixture.approval,
			RunID:       run.ID,
			SessionID:   fixture.sessionIDs[0],
			Generation:  fixture.generation,
			Revision:    2,
			Kind:        "command",
			RequestedAt: "2026-10-25T00:00:00Z",
		},
		Context: json.RawMessage(`{"scope":"write"}`),
	})
	if err != nil {
		t.Fatalf("create approval: %v", err)
	}

	principal := auth.Principal{UserID: fixture.userID, ProjectScope: map[string]struct{}{fixture.projectA: {}}}
	unauthorized := auth.Principal{UserID: fixture.userID, ProjectScope: map[string]struct{}{fixture.projectB: {}}}
	if _, err := control.service.ResolveApproval(ctx, unauthorized, run.ID, approval.ID, protocol.ResolveApprovalRequest{
		CommandID: fixture.command + "-unauthorized",
		Decision:  protocol.ApprovalDecisionApprove,
		Revision:  2,
	}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("unauthorized approval error = %v, want %v", err, auth.ErrForbidden)
	}
	if got := control.transport.sendCount(); got != 0 {
		t.Fatalf("transport sends after unauthorized approval = %d, want 0", got)
	}
	stale := protocol.ResolveApprovalRequest{CommandID: fixture.command + "-stale", Decision: protocol.ApprovalDecisionApprove, Revision: 1}
	if _, err := control.service.ResolveApproval(ctx, principal, run.ID, approval.ID, stale); !errors.Is(err, approvals.ErrRevisionStale) {
		t.Fatalf("stale approval error = %v, want %v", err, approvals.ErrRevisionStale)
	}
	if got := control.transport.sendCount(); got != 0 {
		t.Fatalf("transport sends after stale approval = %d, want 0", got)
	}

	request := protocol.ResolveApprovalRequest{CommandID: fixture.command + "-approve", Decision: protocol.ApprovalDecisionApprove, Revision: 2}
	const attempts = 8
	responses := make(chan protocol.CommandAckResponse, attempts)
	errs := make(chan error, attempts)
	var group sync.WaitGroup
	for i := 0; i < attempts; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			response, err := control.service.ResolveApproval(ctx, principal, run.ID, approval.ID, request)
			responses <- response
			errs <- err
		}()
	}
	group.Wait()
	close(responses)
	close(errs)

	var successes, resolvedErrors int
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, approvals.ErrApprovalResolved):
			resolvedErrors++
		default:
			t.Fatalf("concurrent approval error = %v", err)
		}
	}
	var successfulAck bool
	for response := range responses {
		if response.Ack.State == protocol.CommandStateSucceeded {
			successfulAck = true
		}
	}
	if !successfulAck {
		t.Fatal("concurrent approval produced no successful ACK")
	}
	if successes == 0 || successes+resolvedErrors != attempts {
		t.Fatalf("concurrent approval results: successes=%d resolved=%d", successes, resolvedErrors)
	}
	if got := control.transport.sendCount(); got != 1 {
		t.Fatalf("transport sends after concurrent approval = %d, want 1", got)
	}
	stored, err := approvalStore.Get(ctx, approval.ID)
	if err != nil {
		t.Fatalf("read resolved approval: %v", err)
	}
	if stored.Status != protocol.ApprovalStatusApproved || stored.Revision != 2 || stored.ResolvedByCommandID != request.CommandID {
		t.Fatalf("resolved approval = %+v", stored)
	}

	duplicateResponse, err := control.service.ResolveApproval(ctx, principal, run.ID, approval.ID, request)
	if err != nil {
		t.Fatalf("duplicate approval: %v", err)
	}
	duplicate := duplicateResponse.Ack
	if !duplicate.Deduplicated || control.transport.sendCount() != 1 {
		t.Fatalf("duplicate approval ack = %+v, sends = %d", duplicate, control.transport.sendCount())
	}

	wrongRun := run.ID + "-wrong-url"
	if _, err := control.service.ResolveApproval(ctx, principal, wrongRun, approval.ID, request); !errors.Is(err, approvals.ErrApprovalContext) {
		t.Fatalf("approval URL run mismatch error = %v, want %v", err, approvals.ErrApprovalContext)
	}
}

func TestPersistentControlServiceEventCursorIsRunScoped(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fixture := newControlFixture(t, db, 2)
	control := newControlServiceFixture(t, db, fixture)
	runStore := NewStore(db.Pool())
	first, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         fixture.run,
		SessionID:  fixture.sessionIDs[0],
		CommandID:  fixture.command + "-run",
		Generation: fixture.generation,
	})
	if err != nil {
		t.Fatalf("create first event run: %v", err)
	}
	firstRunID := first.ID
	for _, eventType := range []protocol.EventType{protocol.EventTypeRunStarted, protocol.EventTypeMessageDelta, protocol.EventTypeItemCompleted} {
		if _, err := runStore.ApplyEvent(ctx, fixture.generation, protocol.Event{
			SessionID: fixture.sessionIDs[0],
			RunID:     &firstRunID,
			Type:      eventType,
			Source:    protocol.EventSourceHostObservation,
			Payload:   json.RawMessage(fmt.Sprintf(`{"type":%q}`, eventType)),
		}); err != nil {
			t.Fatalf("append %s: %v", eventType, err)
		}
	}
	second, err := runStore.CreateRun(ctx, NewRunInput{
		ID:         fixture.run + "-second",
		SessionID:  fixture.sessionIDs[1],
		CommandID:  fixture.command + "-second-run",
		Generation: fixture.generation,
	})
	if err != nil {
		t.Fatalf("create second event run: %v", err)
	}
	secondRunID := second.ID
	if _, err := runStore.ApplyEvent(ctx, fixture.generation, protocol.Event{
		SessionID: fixture.sessionIDs[1],
		RunID:     &secondRunID,
		Type:      protocol.EventTypeRunStarted,
		Source:    protocol.EventSourceHostObservation,
		Payload:   json.RawMessage(`{"type":"other"}`),
	}); err != nil {
		t.Fatalf("append independent event: %v", err)
	}

	principal := auth.Principal{UserID: fixture.userID, ProjectScope: map[string]struct{}{fixture.projectA: {}}}
	limit := int64(1)
	page, err := control.service.ListRunEvents(ctx, principal, first.ID, protocol.ListRunEventsQuery{Limit: &limit})
	if err != nil {
		t.Fatalf("list first event page: %v", err)
	}
	if len(page.Events) != 1 || !page.HasMore || page.NextCursor == nil {
		t.Fatalf("first event page = %+v", page)
	}
	page, err = control.service.ListRunEvents(ctx, principal, first.ID, protocol.ListRunEventsQuery{AfterCursor: page.NextCursor})
	if err != nil {
		t.Fatalf("list event page after cursor: %v", err)
	}
	if len(page.Events) != 2 || page.Events[0].RunID == nil || *page.Events[0].RunID != first.ID {
		t.Fatalf("second event page = %+v", page)
	}
	otherCursor := page.Events[0].Cursor
	if _, err := control.service.ListRunEvents(ctx, principal, second.ID, protocol.ListRunEventsQuery{AfterCursor: &otherCursor}); !errors.Is(err, protocol.ErrCursorExpired) {
		t.Fatalf("cross-run cursor error = %v, want %v", err, protocol.ErrCursorExpired)
	}
	if _, err := control.service.ListRunEvents(ctx, principal, second.ID, protocol.ListRunEventsQuery{}); !errors.Is(err, auth.ErrForbidden) {
		t.Fatalf("unauthorized independent event read = %v, want %v", err, auth.ErrForbidden)
	}
}

type controlFixture struct {
	userID     string
	projectA   string
	projectB   string
	sessionIDs []string
	threadIDs  []string
	command    string
	run        string
	approval   string
	generation string
}

func newControlFixture(t *testing.T, db *database.DB, sessionCount int) controlFixture {
	t.Helper()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	fixture := controlFixture{
		userID:     "e01-control-user-" + suffix,
		projectA:   "e01-control-project-a-" + suffix,
		projectB:   "e01-control-project-b-" + suffix,
		command:    "e01-control-command-" + suffix,
		run:        "e01-control-run-" + suffix,
		approval:   "e01-control-approval-" + suffix,
		generation: "generation-control-" + suffix,
	}
	for i := 0; i < sessionCount; i++ {
		fixture.sessionIDs = append(fixture.sessionIDs, fmt.Sprintf("e01-control-session-%d-%s", i, suffix))
		fixture.threadIDs = append(fixture.threadIDs, fmt.Sprintf("e01-control-thread-%d-%s", i, suffix))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject)
		VALUES ($1, $2, $3)
	`, fixture.userID, "e01-control-"+suffix, fixture.userID); err != nil {
		t.Fatalf("seed control user: %v", err)
	}
	for _, project := range []string{fixture.projectA, fixture.projectB} {
		if _, err := db.Pool().Exec(ctx, `
			INSERT INTO projects (id, name, created_by)
			VALUES ($1, $2, $3)
		`, project, project, fixture.userID); err != nil {
			t.Fatalf("seed control project %q: %v", project, err)
		}
	}
	sessionStore := sessions.NewStore(db.Pool())
	for i, sessionID := range fixture.sessionIDs {
		project := fixture.projectA
		if i > 0 {
			project = fixture.projectB
		}
		if _, err := sessionStore.Create(ctx, sessions.NewInput{
			ID:                sessionID,
			Path:              protocol.SessionPathNew,
			ProjectID:         project,
			ExternalThreadRef: fixture.threadIDs[i],
			Generation:        fixture.generation,
		}); err != nil {
			t.Fatalf("create control session %q: %v", sessionID, err)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, query := range []string{
			`DELETE FROM execution_approvals WHERE session_id = ANY($1::text[])`,
			`DELETE FROM execution_events WHERE session_id = ANY($1::text[])`,
			`DELETE FROM execution_runs WHERE session_id = ANY($1::text[])`,
			`DELETE FROM execution_commands WHERE session_id = ANY($1::text[])`,
			`DELETE FROM execution_sessions WHERE id = ANY($1::text[])`,
		} {
			if _, err := db.Pool().Exec(cleanupCtx, query, fixture.sessionIDs); err != nil {
				t.Errorf("cleanup control rows with query %q: %v", query, err)
			}
		}
		if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM projects WHERE id = ANY($1::text[])`, []string{fixture.projectA, fixture.projectB}); err != nil {
			t.Errorf("cleanup control projects: %v", err)
		}
		if _, err := db.Pool().Exec(cleanupCtx, `DELETE FROM auth_users WHERE id = $1`, fixture.userID); err != nil {
			t.Errorf("cleanup control user: %v", err)
		}
	})
	return fixture
}

type controlServiceFixture struct {
	service    *ControlService
	transport  *controlTransport
	authorizer *recordingAuthorizer
}

func newControlServiceFixture(t *testing.T, db *database.DB, fixture controlFixture) controlServiceFixture {
	t.Helper()
	transport := &controlTransport{}
	runStore := NewStore(db.Pool())
	sessionStore := sessions.NewStore(db.Pool())
	authorizer := &recordingAuthorizer{sessionStore: sessionStore}
	controller, err := NewController(runStore, transport, ControllerConfig{
		ResolveGeneration: func(ctx context.Context, sessionID string) (string, error) {
			session, err := sessionStore.Get(ctx, sessionID)
			if err != nil {
				return "", err
			}
			return session.Generation, nil
		},
	})
	if err != nil {
		t.Fatalf("create run controller: %v", err)
	}
	service, err := NewControlService(ControlServiceConfig{
		Controller: controller,
		Sessions:   sessionStore,
		Runs:       runStore,
		Approvals:  approvals.NewStore(db.Pool()),
		Authorize:  authorizer.Authorize,
		Now:        func() time.Time { return time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("create run control service: %v", err)
	}
	authorizer.allowedProject = fixture.projectA
	return controlServiceFixture{service: service, transport: transport, authorizer: authorizer}
}

type authorizationCall struct {
	sessionID string
	write     bool
}

type recordingAuthorizer struct {
	sessionStore   *sessions.Store
	allowedProject string
	mu             sync.Mutex
	records        []authorizationCall
}

func (a *recordingAuthorizer) Authorize(ctx context.Context, _ auth.Principal, sessionID string, write bool) error {
	a.mu.Lock()
	a.records = append(a.records, authorizationCall{sessionID: sessionID, write: write})
	a.mu.Unlock()
	session, err := a.sessionStore.Get(ctx, sessionID)
	if err != nil {
		return err
	}
	if session.ProjectID == nil || *session.ProjectID != a.allowedProject {
		return auth.ErrForbidden
	}
	return nil
}

func (a *recordingAuthorizer) calls() []authorizationCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]authorizationCall(nil), a.records...)
}

type controlTransport struct {
	mu       sync.Mutex
	commands []protocol.Command
}

func (t *controlTransport) SendCommand(_ context.Context, command protocol.Command) (protocol.CommandAck, error) {
	t.mu.Lock()
	t.commands = append(t.commands, cloneControlCommand(command))
	t.mu.Unlock()
	return protocol.CommandAck{CommandID: command.CommandID, RunID: command.RunID, State: protocol.CommandStateSucceeded}, nil
}

func (t *controlTransport) ReconcileCommand(_ context.Context, command protocol.Command) (protocol.Reconciliation, error) {
	return protocol.Reconciliation{CommandID: command.CommandID, State: protocol.ReconciliationStateConfirmed}, nil
}

func (t *controlTransport) sendCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.commands)
}

func (t *controlTransport) command(index int) protocol.Command {
	t.mu.Lock()
	defer t.mu.Unlock()
	return cloneControlCommand(t.commands[index])
}

func cloneControlCommand(command protocol.Command) protocol.Command {
	command.Payload = append(json.RawMessage(nil), command.Payload...)
	if command.RunID != nil {
		runID := *command.RunID
		command.RunID = &runID
	}
	return command
}
