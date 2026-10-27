package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
)

type fakeSessionCreationRecords struct {
	intents     map[string]sessions.CreationIntent
	sessions    map[string]sessions.Session
	unknown     int
	definite    []sessions.DefiniteFailureIntentInput
	activations []sessions.ActivationInput
}

func (f *fakeSessionCreationRecords) CreateIntent(_ context.Context, input sessions.CreationIntentInput) (sessions.CreationIntent, error) {
	if f.intents == nil {
		f.intents = make(map[string]sessions.CreationIntent)
	}
	for _, existing := range f.intents {
		if existing.CreatorUserID == input.CreatorUserID && existing.CommandID == input.CommandID {
			if string(existing.Parameters) != string(input.Parameters) {
				return sessions.CreationIntent{}, protocol.ErrIdempotencyConflict
			}
			return existing, nil
		}
	}
	intent := sessions.CreationIntent{
		SessionID:     input.SessionID,
		CommandID:     input.CommandID,
		CreatorUserID: input.CreatorUserID,
		HostID:        input.HostID,
		Path:          input.Path,
		ProjectID:     input.ProjectID,
		TaskID:        input.TaskID,
		Parameters:    append([]byte(nil), input.Parameters...),
		Summary:       input.Summary,
		State:         sessions.IntentStatePending,
	}
	f.intents[intent.SessionID] = intent
	return intent, nil
}

func (f *fakeSessionCreationRecords) MarkIntentUnknown(_ context.Context, input sessions.UnknownIntentInput) (sessions.CreationIntent, error) {
	f.unknown++
	intent := f.intents[input.SessionID]
	intent.State = sessions.IntentStateUnknown
	intent.UnknownReason = input.Reason
	f.intents[input.SessionID] = intent
	return intent, nil
}

func (f *fakeSessionCreationRecords) MarkIntentDefiniteFailure(_ context.Context, input sessions.DefiniteFailureIntentInput) (sessions.CreationIntent, error) {
	f.definite = append(f.definite, input)
	intent := f.intents[input.SessionID]
	return intent, nil
}

func (f *fakeSessionCreationRecords) ActivateIntent(_ context.Context, input sessions.ActivationInput) (sessions.Session, error) {
	f.activations = append(f.activations, input)
	intent, ok := f.intents[input.SessionID]
	if !ok {
		return sessions.Session{}, sessions.ErrSessionNotFound
	}
	intent.State = sessions.IntentStateConfirmed
	intent.ExternalThreadRef = input.ExternalThreadRef
	intent.ExecutionGeneration = input.ExecutionGeneration
	f.intents[input.SessionID] = intent
	active := sessions.Session{Session: protocol.Session{
		ID:                input.SessionID,
		ExternalThreadRef: input.ExternalThreadRef,
		Path:              intent.Path,
		State:             protocol.SessionStateActive,
		ProjectID:         stringPointer(intent.ProjectID),
		TaskID:            stringPointer(intent.TaskID),
	}, Generation: input.ExecutionGeneration}
	if f.sessions == nil {
		f.sessions = make(map[string]sessions.Session)
	}
	f.sessions[input.SessionID] = active
	return active, nil
}

func (f *fakeSessionCreationRecords) Get(_ context.Context, sessionID string) (sessions.Session, error) {
	session, ok := f.sessions[sessionID]
	if !ok {
		return sessions.Session{}, sessions.ErrSessionNotFound
	}
	return session, nil
}

type fakeSessionCreationHost struct {
	host  hosts.Host
	calls int
}

func (f *fakeSessionCreationHost) ConfiguredHost(context.Context) (hosts.Host, error) {
	f.calls++
	return f.host, nil
}

type fakeSessionCreationTransport struct {
	commands []protocol.Command
	ack      protocol.CommandAck
	err      error
}

func (f *fakeSessionCreationTransport) SendSessionCommand(_ context.Context, _ string, command protocol.Command) (protocol.CommandAck, error) {
	f.commands = append(f.commands, command)
	return f.ack, f.err
}

type fakeSessionInitialRun struct {
	requests []protocol.SubmitRunRequest
	err      error
}

func (f *fakeSessionInitialRun) SubmitRun(_ context.Context, _ auth.Principal, _ string, request protocol.SubmitRunRequest) (protocol.CommandAckResponse, error) {
	f.requests = append(f.requests, request)
	return protocol.CommandAckResponse{Ack: protocol.CommandAck{CommandID: request.CommandID, State: protocol.CommandStateAccepted}}, f.err
}

type fakeSessionCreationProjects struct{ write bool }

func (fakeSessionCreationProjects) CanReadProject(context.Context, auth.Principal, string) (bool, error) {
	return true, nil
}

func (f fakeSessionCreationProjects) CanWriteProject(context.Context, auth.Principal, string) (bool, error) {
	return f.write, nil
}

func TestSessionCreationUsesHostCommandThenRealInitialRun(t *testing.T) {
	prompt := "start with a real run"
	request := protocol.CreateSessionRequest{CommandID: "create-session-1", Path: protocol.SessionPathNew, Prompt: &prompt}
	records := &fakeSessionCreationRecords{}
	transport := &fakeSessionCreationTransport{ack: protocol.CommandAck{
		CommandID: "create-session-1",
		State:     protocol.CommandStateSucceeded,
		Result:    []byte(`{"external_thread_ref":"thread-1","generation":"generation-1"}`),
	}}
	initialRun := &fakeSessionInitialRun{}
	host := &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}
	service := newSessionCreationService(records, fakeSessionCreationProjects{write: true}, host, transport, initialRun)
	service.newID = func() (string, error) { return "session-1", nil }
	service.now = func() time.Time { return time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC) }

	session, err := service.CreateSession(context.Background(), auth.Principal{UserID: "user-1"}, request)
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "session-1" || session.ExternalThreadRef != "thread-1" || session.State != protocol.SessionStateActive {
		t.Fatalf("created session = %+v", session)
	}
	if len(transport.commands) != 1 || transport.commands[0].Kind != protocol.CommandKindSessionStart || transport.commands[0].SessionID != "session-1" {
		t.Fatalf("host commands = %+v", transport.commands)
	}
	if len(initialRun.requests) != 1 || initialRun.requests[0].CommandID != "create-session-1:initial" || initialRun.requests[0].Prompt != prompt {
		t.Fatalf("initial run requests = %+v", initialRun.requests)
	}
	if len(records.activations) != 1 || records.activations[0].ExecutionGeneration != "generation-1" {
		t.Fatalf("activations = %+v", records.activations)
	}
}

func TestSessionCreationWithEmptyPromptOnlyOpensSession(t *testing.T) {
	empty := ""
	request := protocol.CreateSessionRequest{CommandID: "create-session-empty", Path: protocol.SessionPathNew, Prompt: &empty}
	records := &fakeSessionCreationRecords{}
	transport := &fakeSessionCreationTransport{ack: protocol.CommandAck{
		CommandID: "create-session-empty",
		State:     protocol.CommandStateSucceeded,
		Result:    []byte(`{"external_thread_ref":"thread-empty","generation":"generation-empty"}`),
	}}
	initialRun := &fakeSessionInitialRun{}
	service := newSessionCreationService(records, fakeSessionCreationProjects{write: true}, &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}, transport, initialRun)
	service.newID = func() (string, error) { return "session-empty", nil }

	if _, err := service.CreateSession(context.Background(), auth.Principal{UserID: "user-1"}, request); err != nil {
		t.Fatal(err)
	}
	if len(initialRun.requests) != 0 {
		t.Fatalf("empty prompt submitted a run: %+v", initialRun.requests)
	}
}

func TestSessionCreationKeepsUnknownOutcomeUnknown(t *testing.T) {
	records := &fakeSessionCreationRecords{}
	transport := &fakeSessionCreationTransport{err: protocol.ErrUnknownCommandResult}
	service := newSessionCreationService(records, fakeSessionCreationProjects{write: true}, &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}, transport, nil)
	service.newID = func() (string, error) { return "session-unknown", nil }

	_, err := service.CreateSession(context.Background(), auth.Principal{UserID: "user-1"}, protocol.CreateSessionRequest{CommandID: "create-session-unknown", Path: protocol.SessionPathNew})
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("unknown creation error = %v", err)
	}
	if records.unknown != 1 || records.intents["session-unknown"].State != sessions.IntentStateUnknown {
		t.Fatalf("unknown intent state = %+v, mark count = %d", records.intents["session-unknown"], records.unknown)
	}
}

func TestSessionCreationKeepsDefiniteHostRejectionDefiniteAndIdempotent(t *testing.T) {
	for _, state := range []protocol.CommandState{protocol.CommandStateFailed, protocol.CommandStateRejected} {
		t.Run(string(state), func(t *testing.T) {
			records := &fakeSessionCreationRecords{}
			transport := &fakeSessionCreationTransport{ack: protocol.CommandAck{State: state}}
			service := newSessionCreationService(records, fakeSessionCreationProjects{write: true}, &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}, transport, nil)
			service.newID = func() (string, error) { return "session-definite-rejection", nil }
			request := protocol.CreateSessionRequest{CommandID: "create-session-definite-rejection", Path: protocol.SessionPathNew}

			for attempt := 0; attempt < 2; attempt++ {
				_, err := service.CreateSession(context.Background(), auth.Principal{UserID: "user-1"}, request)
				if err == nil || errors.Is(err, protocol.ErrUnknownCommandResult) || !strings.Contains(err.Error(), string(state)) {
					t.Fatalf("attempt %d error = %v, want definite %q rejection", attempt+1, err, state)
				}
			}
			if records.unknown != 0 {
				t.Fatalf("unknown marks = %d, want 0", records.unknown)
			}
			if len(records.definite) != 2 || records.definite[0].State != state || records.definite[1].State != state {
				t.Fatalf("definite failure records = %+v, want two %q records", records.definite, state)
			}
			if len(records.intents) != 1 || records.intents["session-definite-rejection"].State != sessions.IntentStatePending {
				t.Fatalf("rejected intent state = %+v", records.intents)
			}
			if len(transport.commands) != 2 || transport.commands[0].SessionID != transport.commands[1].SessionID || transport.commands[0].CommandID != transport.commands[1].CommandID {
				t.Fatalf("retry command identities = %+v, want one durable identity", transport.commands)
			}
		})
	}
}

func TestSessionCreationRetriesUnknownIntentThroughExactCommand(t *testing.T) {
	request := protocol.CreateSessionRequest{CommandID: "create-session-retry", Path: protocol.SessionPathNew}
	parameters, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	records := &fakeSessionCreationRecords{
		intents: map[string]sessions.CreationIntent{
			"session-existing-unknown": {
				SessionID:     "session-existing-unknown",
				CommandID:     request.CommandID,
				CreatorUserID: "user-1",
				HostID:        "host-1",
				Path:          protocol.SessionPathNew,
				Parameters:    parameters,
				State:         sessions.IntentStateUnknown,
			},
		},
	}
	transport := &fakeSessionCreationTransport{ack: protocol.CommandAck{
		State:  protocol.CommandStateSucceeded,
		Result: []byte(`{"external_thread_ref":"thread-recovered","generation":"generation-recovered"}`),
	}}
	host := &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}
	service := newSessionCreationService(records, fakeSessionCreationProjects{write: true}, host, transport, nil)
	service.newID = func() (string, error) { return "new-session-id-must-not-be-used", nil }

	created, err := service.CreateSession(context.Background(), auth.Principal{UserID: "user-1"}, request)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != "session-existing-unknown" || created.ExternalThreadRef != "thread-recovered" {
		t.Fatalf("reconciled session = %+v", created)
	}
	if len(transport.commands) != 1 || transport.commands[0].CommandID != request.CommandID || transport.commands[0].SessionID != "session-existing-unknown" {
		t.Fatalf("reconciliation commands = %+v", transport.commands)
	}
	if records.unknown != 0 || records.intents["session-existing-unknown"].State != sessions.IntentStateConfirmed {
		t.Fatalf("reconciled intent = %+v, mark count = %d", records.intents["session-existing-unknown"], records.unknown)
	}
}

func TestSessionCreationRejectsUnauthorizedProjectBeforeHostCommand(t *testing.T) {
	host := &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}
	transport := &fakeSessionCreationTransport{ack: protocol.CommandAck{State: protocol.CommandStateSucceeded}}
	records := &fakeSessionCreationRecords{}
	service := newSessionCreationService(records, fakeSessionCreationProjects{write: false}, host, transport, nil)
	projectID := "project-1"
	_, err := service.CreateSession(context.Background(), auth.Principal{UserID: "user-1"}, protocol.CreateSessionRequest{CommandID: "create-denied", Path: protocol.SessionPathNew, ProjectID: &projectID})
	if !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("unauthorized project error = %v", err)
	}
	if host.calls != 0 || len(transport.commands) != 0 || len(records.intents) != 0 {
		t.Fatalf("authorization crossed side-effect boundary: host=%d commands=%d intents=%d", host.calls, len(transport.commands), len(records.intents))
	}
}

func TestSessionCreationDifferentCommandIDsDoNotMergeIdenticalPrompts(t *testing.T) {
	prompt := "same prompt"
	transport := &fakeSessionCreationTransport{ack: protocol.CommandAck{State: protocol.CommandStateSucceeded, Result: []byte(`{"external_thread_ref":"thread-same","generation":"generation-same"}`)}}
	records := &fakeSessionCreationRecords{}
	service := newSessionCreationService(records, fakeSessionCreationProjects{write: true}, &fakeSessionCreationHost{host: hosts.Host{ID: "host-1"}}, transport, &fakeSessionInitialRun{})
	ids := []string{"session-a", "session-b"}
	service.newID = func() (string, error) {
		id := ids[0]
		ids = ids[1:]
		return id, nil
	}
	principal := auth.Principal{UserID: "user-1"}
	for _, commandID := range []string{"create-a", "create-b"} {
		request := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew, Prompt: &prompt}
		if _, err := service.CreateSession(context.Background(), principal, request); err != nil {
			t.Fatal(err)
		}
	}
	if len(transport.commands) != 2 || transport.commands[0].SessionID == transport.commands[1].SessionID {
		t.Fatalf("identical-prompt creation commands merged: %+v", transport.commands)
	}
}

func TestSessionCreateHTTPUsesStrictBodyAndCreationBoundary(t *testing.T) {
	principal := sessionAccessPrincipal{principal: auth.Principal{UserID: "user-1"}}
	creation := &fakeSessionCreationApplication{session: protocol.Session{ID: "session-http", State: protocol.SessionStateActive}}
	service := &sessionService{principal: principal, creation: creation}
	router := chi.NewRouter()
	service.mount(router)

	request := httptest.NewRequest(http.MethodPost, "/sessions", strings.NewReader(`{"command_id":"c","path":"new","unexpected":true}`))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || creation.calls != 0 {
		t.Fatalf("strict create response = %d, calls = %d, body = %s", response.Code, creation.calls, response.Body.String())
	}
}

type fakeSessionCreationApplication struct {
	session protocol.Session
	calls   int
}

func (f *fakeSessionCreationApplication) CreateSession(context.Context, auth.Principal, protocol.CreateSessionRequest) (protocol.Session, error) {
	f.calls++
	return f.session, nil
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
