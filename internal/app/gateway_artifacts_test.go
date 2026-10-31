package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

func TestGatewayArtifactUploadHandlerMapsAuthenticatedHostIdentity(t *testing.T) {
	runID := "run-1"
	store := &gatewayArtifactStoreProbe{}
	handler, err := NewGatewayArtifactUploadHandler(
		store,
		gatewayArtifactSessionProbe{
			access:  sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1", ProjectID: "project-1", Confirmed: true},
			session: sessions.Session{Session: protocol.Session{ID: "session-1"}, Generation: "generation-1"},
		},
		gatewayArtifactRunProbe{run: runs.Run{ID: runID, SessionID: "session-1", Generation: "generation-1"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("original bytes")
	artifact := protocol.Artifact{ID: "artifact-1", SessionID: "session-1", RunID: &runID}
	stored, err := handler.Handle(context.Background(), hosts.Connection{HostID: "host-1", Generation: 4}, gateway.ArtifactUploadRequest{
		Artifact: artifact,
		Content:  bytes.NewReader(content),
	})
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != artifact.ID || store.calls != 1 || store.artifact != artifact || !bytes.Equal(store.content, content) || store.principal.UserID != "owner-1" || !store.principal.HasProjectScope("project-1") {
		t.Fatalf("stored artifact = %+v, calls = %d, input = %+v, content = %q, principal = %+v", stored, store.calls, store.artifact, store.content, store.principal)
	}
}

func TestGatewayArtifactUploadHandlerRejectsUnownedIdentityBeforeStore(t *testing.T) {
	tests := []struct {
		name       string
		connection hosts.Connection
		access     sessions.SessionAccess
		accessErr  error
		run        runs.Run
		runErr     error
		sessionErr error
		wantCode   string
	}{
		{
			name:       "different host",
			connection: hosts.Connection{HostID: "other-host"},
			access:     sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1", Confirmed: true},
			run:        runs.Run{ID: "run-1", SessionID: "session-1", Generation: "generation-1"},
			wantCode:   "artifact_unauthorized",
		},
		{
			name:       "unconfirmed session",
			connection: hosts.Connection{HostID: "host-1"},
			access:     sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1"},
			run:        runs.Run{ID: "run-1", SessionID: "session-1", Generation: "generation-1"},
			wantCode:   "artifact_unauthorized",
		},
		{
			name:       "run belongs to another session",
			connection: hosts.Connection{HostID: "host-1"},
			access:     sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1", Confirmed: true},
			run:        runs.Run{ID: "run-1", SessionID: "other-session", Generation: "generation-1"},
			wantCode:   "artifact_unauthorized",
		},
		{
			name:       "run belongs to another generation",
			connection: hosts.Connection{HostID: "host-1"},
			access:     sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1", Confirmed: true},
			run:        runs.Run{ID: "run-1", SessionID: "session-1", Generation: "generation-old"},
			wantCode:   "artifact_unauthorized",
		},
		{
			name:       "run lookup failure",
			connection: hosts.Connection{HostID: "host-1"},
			access:     sessions.SessionAccess{SessionID: "session-1", HostID: "host-1", Confirmed: true},
			run:        runs.Run{ID: "run-1", SessionID: "session-1", Generation: "generation-1"},
			runErr:     runs.ErrRunNotFound,
			wantCode:   "artifact_unauthorized",
		},
		{
			name:       "session lookup unavailable",
			connection: hosts.Connection{HostID: "host-1"},
			access:     sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1", Confirmed: true},
			sessionErr: errors.New("database temporarily unavailable"),
			wantCode:   "artifact_unavailable",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &gatewayArtifactStoreProbe{}
			handler, err := NewGatewayArtifactUploadHandler(
				store,
				gatewayArtifactSessionProbe{
					access:     test.access,
					session:    sessions.Session{Session: protocol.Session{ID: "session-1"}, Generation: "generation-1"},
					accessErr:  test.accessErr,
					sessionErr: test.sessionErr,
				},
				gatewayArtifactRunProbe{run: test.run, err: test.runErr},
			)
			if err != nil {
				t.Fatal(err)
			}
			runID := "run-1"
			_, err = handler.Handle(context.Background(), test.connection, gateway.ArtifactUploadRequest{
				Artifact: protocol.Artifact{ID: "artifact-1", SessionID: "session-1", RunID: &runID},
				Content:  bytes.NewReader([]byte("must not store")),
			})
			var handlerErr *gateway.ArtifactHandlerError
			if !errors.As(err, &handlerErr) || handlerErr.Code != test.wantCode {
				t.Fatalf("handler error = %v, want code %q", err, test.wantCode)
			}
			if store.calls != 0 {
				t.Fatalf("store calls = %d, want 0", store.calls)
			}
		})
	}
}

func TestGatewayArtifactUploadHandlerMapsStoreFailures(t *testing.T) {
	store := &gatewayArtifactStoreProbe{err: artifacts.ErrTooLarge}
	handler, err := NewGatewayArtifactUploadHandler(
		store,
		gatewayArtifactSessionProbe{
			access:  sessions.SessionAccess{SessionID: "session-1", CreatorUserID: "owner-1", HostID: "host-1", Confirmed: true},
			session: sessions.Session{Session: protocol.Session{ID: "session-1"}, Generation: "generation-1"},
		},
		gatewayArtifactRunProbe{run: runs.Run{ID: "run-1", SessionID: "session-1", Generation: "generation-1"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	runID := "run-1"
	_, err = handler.Handle(context.Background(), hosts.Connection{HostID: "host-1"}, gateway.ArtifactUploadRequest{
		Artifact: protocol.Artifact{ID: "artifact-1", SessionID: "session-1", RunID: &runID},
		Content:  bytes.NewReader([]byte("bounded")),
	})
	var handlerErr *gateway.ArtifactHandlerError
	if !errors.As(err, &handlerErr) || handlerErr.Code != "artifact_too_large" {
		t.Fatalf("store error = %v, want artifact_too_large", err)
	}
}

type gatewayArtifactSessionProbe struct {
	access     sessions.SessionAccess
	session    sessions.Session
	err        error
	accessErr  error
	sessionErr error
}

func (p gatewayArtifactSessionProbe) GetAccess(context.Context, string) (sessions.SessionAccess, error) {
	if p.accessErr != nil {
		return p.access, p.accessErr
	}
	return p.access, p.err
}

func (p gatewayArtifactSessionProbe) Get(context.Context, string) (sessions.Session, error) {
	if p.sessionErr != nil {
		return p.session, p.sessionErr
	}
	return p.session, p.err
}

type gatewayArtifactRunProbe struct {
	run runs.Run
	err error
}

func (p gatewayArtifactRunProbe) GetRun(context.Context, string) (runs.Run, error) {
	return p.run, p.err
}

type gatewayArtifactStoreProbe struct {
	artifact  protocol.Artifact
	content   []byte
	principal auth.Principal
	calls     int
	err       error
}

func (p *gatewayArtifactStoreProbe) Put(ctx context.Context, artifact protocol.Artifact, source io.Reader) (protocol.Artifact, error) {
	p.calls++
	p.artifact = artifact
	p.principal, _ = ctx.Value(artifactPrincipalContextKey{}).(auth.Principal)
	content, err := io.ReadAll(source)
	if err != nil {
		return protocol.Artifact{}, err
	}
	p.content = content
	if p.err != nil {
		return protocol.Artifact{}, p.err
	}
	return artifact, nil
}

var _ GatewayArtifactPutStore = (*gatewayArtifactStoreProbe)(nil)
