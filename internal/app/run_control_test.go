package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/go-chi/chi/v5"
)

type recordingRunControl struct {
	calls     int
	principal auth.Principal
	ids       []string
	body      any
	err       error
}

func (s *recordingRunControl) record(p auth.Principal, body any, ids ...string) (protocol.CommandAckResponse, error) {
	s.calls++
	s.principal, s.ids, s.body = p, ids, body
	return protocol.CommandAckResponse{Ack: protocol.CommandAck{CommandID: "command-1", State: protocol.CommandStateAccepted}}, s.err
}

func (s *recordingRunControl) SubmitRun(_ context.Context, p auth.Principal, id string, body protocol.SubmitRunRequest) (protocol.CommandAckResponse, error) {
	return s.record(p, body, id)
}

func (s *recordingRunControl) InterruptRun(_ context.Context, p auth.Principal, id string, body protocol.InterruptRunRequest) (protocol.CommandAckResponse, error) {
	return s.record(p, body, id)
}

func (s *recordingRunControl) ResolveApproval(_ context.Context, p auth.Principal, run, approval string, body protocol.ResolveApprovalRequest) (protocol.CommandAckResponse, error) {
	return s.record(p, body, run, approval)
}

func (s *recordingRunControl) ListRunEvents(_ context.Context, p auth.Principal, id string, query protocol.ListRunEventsQuery) (protocol.EventPage, error) {
	_, err := s.record(p, query, id)
	return protocol.EventPage{Events: []protocol.Event{}}, err
}

func runControlRouter(service runControlApplication, principalErr error) http.Handler {
	router := chi.NewRouter()
	(&runControlHTTP{service: service, principal: sessionAccessPrincipal{
		principal: auth.Principal{UserID: "owner", CredentialID: "credential", ProjectScope: map[string]struct{}{"project": {}}}, err: principalErr,
	}}).mount(router)
	return router
}

func TestRunControlHTTPDelegatesURLIdentityAndGeneratedEnvelope(t *testing.T) {
	for _, test := range []struct {
		path, body, firstID, secondID string
	}{
		{path: "/sessions/session-url/runs", body: `{"command_id":"command-1","prompt":"hello"}`, firstID: "session-url"},
		{path: "/runs/run-url/interrupt", body: `{"command_id":"command-1","reason":"stop"}`, firstID: "run-url"},
		{path: "/runs/run-url/approvals/approval-url", body: `{"command_id":"command-1","decision":"deny","revision":2}`, firstID: "run-url", secondID: "approval-url"},
	} {
		t.Run(test.path, func(t *testing.T) {
			service := &recordingRunControl{}
			response := httptest.NewRecorder()
			runControlRouter(service, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body)))
			if response.Code != http.StatusOK || service.calls != 1 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, service.calls, response.Body.String())
			}
			if service.ids[0] != test.firstID || (test.secondID != "" && service.ids[1] != test.secondID) || service.principal.UserID != "owner" || service.principal.CredentialID != "credential" || !service.principal.HasProjectScope("project") {
				t.Fatalf("lost identity: %+v", service)
			}
			var result protocol.CommandAckResponse
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Ack.CommandID != "command-1" || result.Ack.State != protocol.CommandStateAccepted {
				t.Fatalf("not a command envelope: %s", response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("control response may be cached")
			}
		})
	}
}

func TestRunControlHTTPRejectsAmbiguousBodiesBeforeService(t *testing.T) {
	for _, body := range []string{
		`null`, `[]`, ``, `{"command_id":"c","prompt":"hello"} {}`,
		`{"command_id":"c","prompt":"hello","session_id":"other"}`,
		`{"command_id":"c","prompt":"hello","run_id":"other"}`,
		`{"command_id":1,"prompt":"hello"}`,
		`{"prompt":"` + strings.Repeat("a", 1<<20) + `"}`,
	} {
		service := &recordingRunControl{}
		response := httptest.NewRecorder()
		runControlRouter(service, nil).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/sessions/s/runs", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest || service.calls != 0 {
			t.Fatalf("status=%d calls=%d", response.Code, service.calls)
		}
	}
}

func TestRunControlHTTPPreservesOpaqueCursorAndRejectsAmbiguousQuery(t *testing.T) {
	service := &recordingRunControl{}
	response := httptest.NewRecorder()
	runControlRouter(service, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/runs/r/events?after_cursor=opaque%2B%2F%3D%3Ax&limit=17", nil))
	query, ok := service.body.(protocol.ListRunEventsQuery)
	if response.Code != http.StatusOK || !ok || query.AfterCursor == nil || *query.AfterCursor != "opaque+/=:x" || query.Limit == nil || *query.Limit != 17 || service.ids[0] != "r" {
		t.Fatalf("cursor changed: %+v response=%s", query, response.Body.String())
	}
	for _, suffix := range []string{"limit=0", "limit=-1", "limit=bad", "limit=9223372036854775808", "limit=1&limit=2", "after_cursor=a&after_cursor=b", "after_cursor=%XX"} {
		service := &recordingRunControl{}
		response := httptest.NewRecorder()
		runControlRouter(service, nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/runs/r/events?"+suffix, nil))
		if response.Code != http.StatusBadRequest || service.calls != 0 {
			t.Fatalf("query %q status=%d calls=%d", suffix, response.Code, service.calls)
		}
	}
}

func TestRunControlHTTPFailClosedAndSafeErrorCodes(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
		code   protocol.ErrorCode
	}{
		{"unknown", protocol.ErrUnknownCommandResult, http.StatusConflict, protocol.ErrorCodeUnknownResult},
		{"expired cursor", protocol.ErrCursorExpired, http.StatusConflict, protocol.ErrorCodeCursorExpired},
		{"id conflict", protocol.ErrIdempotencyConflict, http.StatusConflict, protocol.ErrorCodeIdempotencyConflict},
		{"approval revision", approvals.ErrRevisionStale, http.StatusConflict, protocol.ErrorCodeConflict},
		{"stale generation", runs.ErrStaleGeneration, http.StatusConflict, protocol.ErrorCodeConflict},
		{"missing", auth.ErrNotFound, http.StatusNotFound, protocol.ErrorCodeNotFound},
		{"missing approval", approvals.ErrApprovalNotFound, http.StatusNotFound, protocol.ErrorCodeNotFound},
		{"revoked", auth.ErrForbidden, http.StatusForbidden, protocol.ErrorCodeUnauthorized},
		{"invalid", runs.ErrInvalidControlRequest, http.StatusBadRequest, protocol.ErrorCodeInvalidRequest},
		{"dependency", errors.New("/private/secret token=hidden raw-content"), http.StatusServiceUnavailable, protocol.ErrorCodeInvalidRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &recordingRunControl{err: test.err}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/runs/r/interrupt", strings.NewReader(`{"command_id":"c"}`))
			request.Header.Set("X-Request-ID", "request-identity")
			runControlRouter(service, nil).ServeHTTP(response, request)
			var failure protocol.ApiError
			if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || response.Code != test.status || failure.Code != test.code || failure.RequestID != "request-identity" {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			for _, secret := range []string{"/private/", "hidden", "raw-content"} {
				if strings.Contains(response.Body.String(), secret) {
					t.Fatal("internal error leaked")
				}
			}
		})
	}
	for _, test := range []struct {
		service      runControlApplication
		principalErr error
		status       int
	}{
		{service: nil, status: http.StatusServiceUnavailable},
		{service: &recordingRunControl{}, principalErr: auth.ErrUnauthenticated, status: http.StatusUnauthorized},
		{service: &recordingRunControl{}, principalErr: errors.New("private upstream"), status: http.StatusServiceUnavailable},
	} {
		response := httptest.NewRecorder()
		runControlRouter(test.service, test.principalErr).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/sessions/s/runs", strings.NewReader(`{"command_id":"c","prompt":"hi"}`)))
		if response.Code != test.status || strings.Contains(response.Body.String(), "private upstream") {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		if service, ok := test.service.(*recordingRunControl); ok && service.calls != 0 {
			t.Fatal("service called before authentication")
		}
	}
}
