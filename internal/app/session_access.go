package app

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
)

type sessionRecords interface {
	GetAccess(context.Context, string) (sessions.SessionAccess, error)
	Get(context.Context, string) (sessions.Session, error)
}

type sessionProjectAccess interface {
	CanReadProject(context.Context, auth.Principal, string) (bool, error)
	CanWriteProject(context.Context, auth.Principal, string) (bool, error)
}

// sessionService applies the same access boundary to reads and subsequent
// control operations. A guessed Session ID never substitutes for permission.
type sessionService struct {
	principal auth.PrincipalResolver
	projects  sessionProjectAccess
	records   sessionRecords
}

func (s *sessionService) authorize(ctx context.Context, principal auth.Principal, sessionID string, write bool) (sessions.SessionAccess, error) {
	if principal.UserID == "" {
		return sessions.SessionAccess{}, auth.ErrUnauthenticated
	}
	access, err := s.records.GetAccess(ctx, sessionID)
	if errors.Is(err, sessions.ErrSessionNotFound) {
		return sessions.SessionAccess{}, auth.ErrNotFound
	}
	if err != nil {
		return sessions.SessionAccess{}, fmt.Errorf("read session access: %w", err)
	}
	// Legacy records have no verified creator/host provenance. Even a matching
	// project must not make these records public before explicit reconciliation.
	if access.SessionID != sessionID || access.CreatorUserID == "" || access.HostID == "" {
		return sessions.SessionAccess{}, auth.ErrNotFound
	}
	if access.ProjectID == "" {
		if access.CreatorUserID != principal.UserID || len(principal.ProjectScope) != 0 {
			return sessions.SessionAccess{}, auth.ErrNotFound
		}
		return access, nil
	}
	if !principal.HasProjectScope(access.ProjectID) {
		return sessions.SessionAccess{}, auth.ErrNotFound
	}
	var allowed bool
	if write {
		allowed, err = s.projects.CanWriteProject(ctx, principal, access.ProjectID)
	} else {
		allowed, err = s.projects.CanReadProject(ctx, principal, access.ProjectID)
	}
	if err != nil {
		return sessions.SessionAccess{}, fmt.Errorf("authorize session project: %w", err)
	}
	if !allowed {
		return sessions.SessionAccess{}, auth.ErrNotFound
	}
	return access, nil
}

func (s *sessionService) GetSession(ctx context.Context, principal auth.Principal, sessionID string) (protocol.Session, error) {
	access, err := s.authorize(ctx, principal, sessionID, false)
	if err != nil {
		return protocol.Session{}, err
	}
	if !access.Confirmed {
		return protocol.Session{}, protocol.ErrUnknownCommandResult
	}
	session, err := s.records.Get(ctx, sessionID)
	if errors.Is(err, sessions.ErrSessionNotFound) || errors.Is(err, sessions.ErrSessionUnconfirmed) {
		return protocol.Session{}, auth.ErrNotFound
	}
	if err != nil {
		return protocol.Session{}, fmt.Errorf("read session: %w", err)
	}
	return session.Session, nil
}

func (s *sessionService) mount(router chi.Router) {
	router.Get("/sessions/{session_id}", s.handleGet)
}

func (s *sessionService) handleGet(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.principal.ResolvePrincipal(request.Context(), request)
	if err == nil && principal.UserID == "" {
		err = auth.ErrUnauthenticated
	}
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, auth.ErrUnauthenticated) {
			status = http.StatusUnauthorized
		}
		auth.WriteError(writer, request, status, err, "session identity is unavailable")
		return
	}
	session, err := s.GetSession(request.Context(), principal, chi.URLParam(request, "session_id"))
	if err != nil {
		switch {
		case errors.Is(err, protocol.ErrUnknownCommandResult):
			requestID := request.Header.Get("X-Request-ID")
			if requestID == "" {
				requestID = "req_" + rand.Text()
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(writer).Encode(protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "session creation has not been confirmed", RequestID: requestID})
		case errors.Is(err, auth.ErrNotFound), errors.Is(err, auth.ErrUnauthenticated):
			auth.WriteError(writer, request, auth.StatusForError(err), err, "session is unavailable")
		default:
			auth.WriteError(writer, request, http.StatusServiceUnavailable, err, "session is temporarily unavailable")
		}
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(protocol.SessionResponse{Session: session})
}
