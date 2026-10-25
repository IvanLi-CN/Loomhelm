package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
)

type sessionAccessRecords struct {
	access sessions.SessionAccess
	err    error
	reads  int
}

func (r *sessionAccessRecords) GetAccess(context.Context, string) (sessions.SessionAccess, error) {
	return r.access, r.err
}

func (r *sessionAccessRecords) Get(context.Context, string) (sessions.Session, error) {
	r.reads++
	return sessions.Session{Session: protocol.Session{ID: "s", ExternalThreadRef: "private-thread"}}, nil
}

type sessionAccessProjects struct {
	read, write bool
}

func (p sessionAccessProjects) CanReadProject(context.Context, auth.Principal, string) (bool, error) {
	return p.read, nil
}

func (p sessionAccessProjects) CanWriteProject(context.Context, auth.Principal, string) (bool, error) {
	return p.write, nil
}

type sessionAccessPrincipal struct {
	principal auth.Principal
	err       error
}

func (p sessionAccessPrincipal) ResolvePrincipal(context.Context, *http.Request) (auth.Principal, error) {
	return p.principal, p.err
}

func TestSessionAccessPrecedesContentAndControl(t *testing.T) {
	for _, test := range []struct {
		name      string
		principal auth.Principal
		creator   string
		host      string
		project   string
		confirmed bool
		roles     sessionAccessProjects
		wantRead  error
		wantWrite error
	}{
		{name: "private creator", principal: auth.Principal{UserID: "owner"}, creator: "owner", host: "h", confirmed: true},
		{name: "another user", principal: auth.Principal{UserID: "other"}, creator: "owner", host: "h", confirmed: true, wantRead: auth.ErrNotFound, wantWrite: auth.ErrNotFound},
		{name: "project scoped token cannot read creator private history", principal: auth.Principal{UserID: "owner", CredentialID: "token", ProjectScope: map[string]struct{}{"p": {}}}, creator: "owner", host: "h", confirmed: true, wantRead: auth.ErrNotFound, wantWrite: auth.ErrNotFound},
		{name: "shared viewer", principal: auth.Principal{UserID: "viewer"}, creator: "owner", host: "h", project: "p", confirmed: true, roles: sessionAccessProjects{read: true}, wantWrite: auth.ErrNotFound},
		{name: "shared operator", principal: auth.Principal{UserID: "operator"}, creator: "owner", host: "h", project: "p", confirmed: true, roles: sessionAccessProjects{read: true, write: true}},
		{name: "creator membership revoked", principal: auth.Principal{UserID: "owner"}, creator: "owner", host: "h", project: "p", confirmed: true, wantRead: auth.ErrNotFound, wantWrite: auth.ErrNotFound},
		{name: "credential scope overrides membership", principal: auth.Principal{UserID: "owner", ProjectScope: map[string]struct{}{"other": {}}}, creator: "owner", host: "h", project: "p", confirmed: true, roles: sessionAccessProjects{read: true, write: true}, wantRead: auth.ErrNotFound, wantWrite: auth.ErrNotFound},
		{name: "legacy owner absent", principal: auth.Principal{UserID: "owner"}, host: "h", project: "p", confirmed: true, roles: sessionAccessProjects{read: true, write: true}, wantRead: auth.ErrNotFound, wantWrite: auth.ErrNotFound},
		{name: "legacy host absent", principal: auth.Principal{UserID: "owner"}, creator: "owner", confirmed: true, wantRead: auth.ErrNotFound, wantWrite: auth.ErrNotFound},
		{name: "pending is not an invented session", principal: auth.Principal{UserID: "owner"}, creator: "owner", host: "h", wantRead: protocol.ErrUnknownCommandResult},
		{name: "unauthenticated", creator: "owner", host: "h", confirmed: true, wantRead: auth.ErrUnauthenticated, wantWrite: auth.ErrUnauthenticated},
	} {
		t.Run(test.name, func(t *testing.T) {
			records := &sessionAccessRecords{access: sessions.SessionAccess{SessionID: "s", CreatorUserID: test.creator, HostID: test.host, ProjectID: test.project, Confirmed: test.confirmed}}
			service := &sessionService{records: records, projects: test.roles}
			_, err := service.GetSession(context.Background(), test.principal, "s")
			if !errors.Is(err, test.wantRead) {
				t.Fatalf("GetSession error = %v, want %v", err, test.wantRead)
			}
			if test.wantRead != nil && records.reads != 0 {
				t.Fatal("read private content before authorization/confirmation")
			}
			_, err = service.authorize(context.Background(), test.principal, "s", true)
			if !errors.Is(err, test.wantWrite) {
				t.Fatalf("write authorization error = %v, want %v", err, test.wantWrite)
			}
		})
	}
}

func TestSessionReadHTTPKeepsDependencyDetailsPrivate(t *testing.T) {
	privateErr := errors.New("postgres /private/secret token=do-not-expose")
	for _, test := range []struct {
		name         string
		principalErr error
		storeErr     error
		confirmed    bool
		status       int
	}{
		{name: "read", confirmed: true, status: http.StatusOK},
		{name: "pending", status: http.StatusConflict},
		{name: "identity absent", principalErr: auth.ErrUnauthenticated, status: http.StatusUnauthorized},
		{name: "identity dependency", principalErr: privateErr, status: http.StatusServiceUnavailable},
		{name: "storage dependency", storeErr: privateErr, status: http.StatusServiceUnavailable},
		{name: "missing", storeErr: sessions.ErrSessionNotFound, status: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &sessionService{
				principal: sessionAccessPrincipal{principal: auth.Principal{UserID: "owner"}, err: test.principalErr},
				projects:  sessionAccessProjects{},
				records:   &sessionAccessRecords{access: sessions.SessionAccess{SessionID: "s", CreatorUserID: "owner", HostID: "h", Confirmed: test.confirmed}, err: test.storeErr},
			}
			router := chi.NewRouter()
			service.mount(router)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/sessions/s", nil))
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body.String())
			}
			body := response.Body.String()
			if strings.Contains(body, "do-not-expose") || strings.Contains(body, "/private/") {
				t.Fatalf("dependency details leaked: %s", body)
			}
			if test.status != http.StatusOK && strings.Contains(body, "private-thread") {
				t.Fatal("error response exposed conversation content")
			}
			if test.status == http.StatusConflict && !strings.Contains(body, `"code":"unknown_result"`) {
				t.Fatalf("unconfirmed outcome was not explicit: %s", body)
			}
			if test.status >= 400 {
				var failure protocol.ApiError
				if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || failure.RequestID == "" {
					t.Fatalf("error response has no request identity: %s", body)
				}
			}
		})
	}
}
