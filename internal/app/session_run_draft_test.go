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
	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
)

type sessionRunStoreStub struct {
	page  runs.SessionRunPage
	err   error
	calls int
	after *runs.Cursor
	limit int
}

func (s *sessionRunStoreStub) ListBySession(_ context.Context, sessionID string, after *runs.Cursor, limit int) (runs.SessionRunPage, error) {
	s.calls++
	s.after, s.limit = after, limit
	if s.page.Items != nil {
		for index := range s.page.Items {
			if s.page.Items[index].SessionID == "" {
				s.page.Items[index].SessionID = sessionID
			}
		}
	}
	return s.page, s.err
}

type draftStoreStub struct {
	draft       drafts.Draft
	err         error
	getCalls    int
	applyCalls  int
	owner       string
	updateInput drafts.UpdateInput
}

func (s *draftStoreStub) Get(_ context.Context, _, owner string) (drafts.Draft, error) {
	s.getCalls++
	s.owner = owner
	return s.draft, s.err
}

func (s *draftStoreStub) Apply(_ context.Context, input drafts.UpdateInput) (drafts.Draft, error) {
	s.applyCalls++
	s.owner = input.OwnerUserID
	s.updateInput = input
	return s.draft, s.err
}

func authorizedSessionService() *sessionService {
	return &sessionService{
		records:  &sessionAccessRecords{access: sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner", HostID: "host-1", Confirmed: true}},
		projects: sessionAccessProjects{},
	}
}

func TestSessionRunHTTPAuthorizesAndMapsOpaquePage(t *testing.T) {
	createdAt := time.Date(2026, 10, 30, 2, 3, 4, 5, time.UTC)
	store := &sessionRunStoreStub{
		page: runs.SessionRunPage{
			Items:      []runs.Run{{ID: "run-1", CommandID: "command-1", SessionID: "session-1", Status: protocol.RunStatusRunning, CreatedAt: createdAt.Format(time.RFC3339Nano), LastCursor: "cursor-1"}},
			HasMore:    true,
			NextCursor: &runs.Cursor{Version: 1, SessionID: "session-1", CreatedAt: createdAt, ID: "run-1"},
		},
	}
	router := chi.NewRouter()
	(&sessionRunHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}},
		sessions:  authorizedSessionService(),
		runs:      store,
	}).mount(router)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/sessions/session-1/runs?limit=17", nil))
	if response.Code != http.StatusOK || store.calls != 1 || store.limit != 17 {
		t.Fatalf("status=%d calls=%d limit=%d body=%s", response.Code, store.calls, store.limit, response.Body.String())
	}
	var result protocol.RunListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].ID != "run-1" || result.Items[0].CommandID == nil || *result.Items[0].CommandID != "command-1" || result.NextCursor == nil || !result.HasMore {
		t.Fatalf("mapped run page = %+v", result)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("run page may be cached")
	}
}

func TestSessionRunHTTPRejectsInvalidOrCrossSessionCursorBeforeStore(t *testing.T) {
	store := &sessionRunStoreStub{}
	router := chi.NewRouter()
	(&sessionRunHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}},
		sessions:  authorizedSessionService(),
		runs:      store,
	}).mount(router)

	for _, query := range []string{"limit=0", "limit=201", "limit=1&limit=2", "after_cursor=not-base64", "after_cursor=%ZZ"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/sessions/session-1/runs?"+query, nil))
		if response.Code != http.StatusBadRequest || store.calls != 0 {
			t.Fatalf("query=%q status=%d calls=%d body=%s", query, response.Code, store.calls, response.Body.String())
		}
	}
	foreign := runs.EncodeCursor(runs.Cursor{Version: 1, SessionID: "other", CreatedAt: time.Now().UTC(), ID: "run-1"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/sessions/session-1/runs?after_cursor="+foreign, nil))
	if response.Code != http.StatusBadRequest || store.calls != 0 {
		t.Fatalf("foreign cursor status=%d calls=%d body=%s", response.Code, store.calls, response.Body.String())
	}
}

func TestDraftHTTPUsesSessionOwnerAndMapsPublicProjection(t *testing.T) {
	store := &draftStoreStub{draft: drafts.Draft{
		SessionID: "session-1", OwnerUserID: "owner", Content: "draft text", Revision: 3,
		MutationID: "mutation-3", ClientID: "client-1", ClientSequence: 8,
		UpdatedAt: "2026-10-30T02:03:04Z",
	}}
	router := chi.NewRouter()
	(&draftHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}},
		sessions:  authorizedSessionService(),
		drafts:    store,
	}).mount(router)

	getResponse := httptest.NewRecorder()
	router.ServeHTTP(getResponse, httptest.NewRequest(http.MethodGet, "/sessions/session-1/draft", nil))
	if getResponse.Code != http.StatusOK || store.getCalls != 1 || store.owner != "owner" {
		t.Fatalf("get status=%d calls=%d owner=%q body=%s", getResponse.Code, store.getCalls, store.owner, getResponse.Body.String())
	}
	if strings.Contains(getResponse.Body.String(), "OwnerUserID") || strings.Contains(getResponse.Body.String(), "owner_user_id") {
		t.Fatal("draft owner identity leaked")
	}

	updateResponse := httptest.NewRecorder()
	router.ServeHTTP(updateResponse, httptest.NewRequest(http.MethodPut, "/sessions/session-1/draft", strings.NewReader(`{"mutation_id":"mutation-4","client_id":"client-1","client_sequence":9,"content":"next","modification_order":{"physical_millis":1730253600000,"logical_counter":0,"client_id":"client-1"}}`)))
	if updateResponse.Code != http.StatusOK || store.applyCalls != 1 {
		t.Fatalf("update status=%d calls=%d body=%s", updateResponse.Code, store.applyCalls, updateResponse.Body.String())
	}
	if store.updateInput.OwnerUserID != "owner" || store.updateInput.MutationID != "mutation-4" || store.updateInput.ClientSequence != 9 || store.updateInput.Content != "next" {
		t.Fatalf("update input = %+v", store.updateInput)
	}
}

func TestDraftHTTPMapsConflictAndRejectsUnknownFields(t *testing.T) {
	store := &draftStoreStub{err: drafts.ErrDraftStaleMutation}
	router := chi.NewRouter()
	(&draftHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}},
		sessions:  authorizedSessionService(),
		drafts:    store,
	}).mount(router)

	stale := httptest.NewRecorder()
	router.ServeHTTP(stale, httptest.NewRequest(http.MethodPut, "/sessions/session-1/draft", strings.NewReader(`{"mutation_id":"m","client_id":"c","client_sequence":1,"content":"x","modification_order":{"physical_millis":1730253600000,"logical_counter":0,"client_id":"c"}}`)))
	if stale.Code != http.StatusConflict || store.applyCalls != 1 {
		t.Fatalf("stale status=%d calls=%d body=%s", stale.Code, store.applyCalls, stale.Body.String())
	}

	unknown := httptest.NewRecorder()
	router.ServeHTTP(unknown, httptest.NewRequest(http.MethodPut, "/sessions/session-1/draft", strings.NewReader(`{"mutation_id":"m","client_id":"c","client_sequence":1,"content":"x","modification_order":{"physical_millis":1730253600000,"logical_counter":0,"client_id":"c"},"owner_user_id":"other"}`)))
	if unknown.Code != http.StatusBadRequest || store.applyCalls != 1 {
		t.Fatalf("unknown status=%d calls=%d body=%s", unknown.Code, store.applyCalls, unknown.Body.String())
	}
	var failure protocol.ApiError
	if err := json.Unmarshal(unknown.Body.Bytes(), &failure); err != nil || failure.Code != protocol.ErrorCodeInvalidRequest {
		t.Fatalf("unknown error = %s", unknown.Body.String())
	}
}

func TestDraftHTTPAcceptsMaximumDomainContentWithinJSONEnvelope(t *testing.T) {
	store := &draftStoreStub{draft: drafts.Draft{SessionID: "session-1", Revision: 1, UpdatedAt: "2026-10-30T02:03:04Z"}}
	router := chi.NewRouter()
	(&draftHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}},
		sessions:  authorizedSessionService(),
		drafts:    store,
	}).mount(router)
	body, err := json.Marshal(protocol.UpdateDraftRequest{
		MutationID: "mutation-max", ClientID: "client-1", ClientSequence: 1,
		Content:           strings.Repeat("a", drafts.MaxContentBytes),
		ModificationOrder: protocol.ModificationOrder{PhysicalMillis: 1730253600000, ClientID: "client-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/sessions/session-1/draft", strings.NewReader(string(body))))
	if response.Code != http.StatusOK || store.applyCalls != 1 || len(store.updateInput.Content) != drafts.MaxContentBytes {
		t.Fatalf("maximum content status=%d calls=%d content=%d body=%s", response.Code, store.applyCalls, len(store.updateInput.Content), response.Body.String())
	}
}

func TestDraftHTTPKeepsDraftPrivateToCreator(t *testing.T) {
	store := &draftStoreStub{draft: drafts.Draft{SessionID: "session-1", OwnerUserID: "owner", Revision: 1}}
	router := chi.NewRouter()
	(&draftHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "project-viewer", ProjectScope: map[string]struct{}{"project": {}}}},
		sessions: &sessionService{
			records:  &sessionAccessRecords{access: sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner", HostID: "host-1", ProjectID: "project", Confirmed: true}},
			projects: sessionAccessProjects{read: true, write: true},
		},
		drafts: store,
	}).mount(router)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/sessions/session-1/draft", nil))
	if response.Code != http.StatusNotFound || store.getCalls != 0 {
		t.Fatalf("foreign draft access status=%d calls=%d body=%s", response.Code, store.getCalls, response.Body.String())
	}
}

func TestDraftHTTPDoesNotExposeDependencyDetails(t *testing.T) {
	store := &draftStoreStub{err: errors.New("postgres /private/token")}
	router := chi.NewRouter()
	(&draftHTTP{
		principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}},
		sessions:  authorizedSessionService(),
		drafts:    store,
	}).mount(router)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/sessions/session-1/draft", nil))
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "private/token") {
		t.Fatalf("dependency error leaked: status=%d body=%s", response.Code, response.Body.String())
	}
}
