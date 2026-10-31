package app

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

type sessionRecords interface {
	GetAccess(context.Context, string) (sessions.SessionAccess, error)
	Get(context.Context, string) (sessions.Session, error)
}

type sessionProjectAccess interface {
	CanReadProject(context.Context, auth.Principal, string) (bool, error)
	CanWriteProject(context.Context, auth.Principal, string) (bool, error)
}

type sessionProjectBindingAccess interface {
	CanWriteProjectTx(context.Context, pgx.Tx, auth.Principal, string) (bool, error)
}

type sessionTaskBinder interface {
	BindTaskAuthorized(context.Context, string, sessions.BindRequest, sessions.BindingAuthorizer) (sessions.Session, error)
}

// sessionService applies the same access boundary to reads and subsequent
// control operations. A guessed Session ID never substitutes for permission.
type sessionService struct {
	principal auth.PrincipalResolver
	projects  sessionProjectAccess
	records   sessionRecords
	hosts     *hosts.Service
	creation  sessionCreationApplication
	binding   sessionTaskBinder
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
	if s.hosts != nil {
		if err := s.hosts.AuthorizeUser(ctx, principal.UserID, access.HostID); err != nil {
			if errors.Is(err, hosts.ErrForbidden) || errors.Is(err, hosts.ErrNotFound) {
				return sessions.SessionAccess{}, auth.ErrNotFound
			}
			return sessions.SessionAccess{}, fmt.Errorf("authorize session Host: %w", err)
		}
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
	router.Post("/sessions", s.handleCreate)
	router.Get("/sessions/{session_id}", s.handleGet)
	router.Post("/sessions/{session_id}/task", s.handleBindTask)
}

func (s *sessionService) handleCreate(writer http.ResponseWriter, request *http.Request) {
	if s.principal == nil {
		auth.WriteError(writer, request, http.StatusServiceUnavailable, runs.ErrControlServiceUnavailable, "session creation is temporarily unavailable")
		return
	}
	principal, err := s.principal.ResolvePrincipal(request.Context(), request)
	if err == nil && principal.UserID == "" {
		err = auth.ErrUnauthenticated
	}
	if err != nil {
		writeSessionCreationError(writer, request, err)
		return
	}
	if s.creation == nil {
		writeSessionCreationError(writer, request, runs.ErrControlServiceUnavailable)
		return
	}
	var body protocol.CreateSessionRequest
	if err := auth.DecodeJSON(request, &body); err != nil {
		writeSessionCreationError(writer, request, err)
		return
	}
	created, err := s.creation.CreateSession(request.Context(), principal, body)
	if err != nil {
		writeSessionCreationError(writer, request, err)
		return
	}
	auth.WriteJSON(writer, http.StatusCreated, created)
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

func (s *sessionService) handleBindTask(writer http.ResponseWriter, request *http.Request) {
	if s.principal == nil {
		writeSessionBindingError(writer, request, runs.ErrControlServiceUnavailable)
		return
	}
	principal, err := s.principal.ResolvePrincipal(request.Context(), request)
	if err == nil && principal.UserID == "" {
		err = auth.ErrUnauthenticated
	}
	if err != nil {
		writeSessionBindingError(writer, request, err)
		return
	}
	if s.binding == nil || s.projects == nil {
		writeSessionBindingError(writer, request, runs.ErrControlServiceUnavailable)
		return
	}
	var body protocol.BindSessionTaskRequest
	if err := auth.DecodeJSON(request, &body); err != nil {
		writeSessionBindingError(writer, request, err)
		return
	}
	body.TaskID = strings.TrimSpace(body.TaskID)
	if body.TaskID == "" {
		writeSessionBindingError(writer, request, auth.ErrInvalid)
		return
	}
	confirmShare := body.ConfirmShare != nil && *body.ConfirmShare
	session, err := s.binding.BindTaskAuthorized(
		request.Context(), chi.URLParam(request, "session_id"),
		sessions.BindRequest{TaskID: body.TaskID, ConfirmShare: confirmShare},
		func(ctx context.Context, tx pgx.Tx, facts sessions.BindingFacts) error {
			return s.authorizeTaskBinding(ctx, tx, principal, confirmShare, facts)
		},
	)
	if err != nil {
		writeSessionBindingError(writer, request, err)
		return
	}
	auth.WriteJSON(writer, http.StatusOK, protocol.SessionResponse{Session: session.Session})
}

func (s *sessionService) authorizeTaskBinding(ctx context.Context, tx pgx.Tx, principal auth.Principal, confirmShare bool, facts sessions.BindingFacts) error {
	access := facts.Access
	if access.SessionID != facts.Session.ID || access.CreatorUserID == "" || access.HostID == "" || !access.Confirmed {
		return auth.ErrNotFound
	}
	if s.hosts != nil {
		if err := s.hosts.AuthorizeUser(ctx, principal.UserID, access.HostID); err != nil {
			if errors.Is(err, hosts.ErrForbidden) || errors.Is(err, hosts.ErrNotFound) {
				return auth.ErrNotFound
			}
			return fmt.Errorf("authorize task binding Host: %w", err)
		}
	}
	if access.ProjectID == "" {
		if access.CreatorUserID != principal.UserID || len(principal.ProjectScope) != 0 {
			return auth.ErrNotFound
		}
		if !confirmShare {
			return sessions.ErrShareConfirmation
		}
		bindingProjects, ok := s.projects.(sessionProjectBindingAccess)
		if !ok {
			return runs.ErrControlServiceUnavailable
		}
		if strings.TrimSpace(facts.TaskProjectID) == "" {
			return auth.ErrNotFound
		}
		allowed, err := bindingProjects.CanWriteProjectTx(ctx, tx, principal, facts.TaskProjectID)
		if err != nil {
			return fmt.Errorf("authorize task binding target project: %w", err)
		}
		if !allowed {
			return auth.ErrNotFound
		}
		return nil
	}
	bindingProjects, ok := s.projects.(sessionProjectBindingAccess)
	if !ok {
		return runs.ErrControlServiceUnavailable
	}
	projectIDs := []string{access.ProjectID, facts.TaskProjectID}
	sort.Strings(projectIDs)
	for index, projectID := range projectIDs {
		if index > 0 && projectID == projectIDs[index-1] {
			continue
		}
		allowed, err := bindingProjects.CanWriteProjectTx(ctx, tx, principal, projectID)
		if err != nil {
			return fmt.Errorf("authorize task binding project: %w", err)
		}
		if !allowed {
			return auth.ErrNotFound
		}
	}
	return nil
}

func writeSessionCreationError(writer http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusServiceUnavailable
	code := protocol.ErrorCodeInvalidRequest
	message := "session creation is temporarily unavailable"
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		status, code, message = http.StatusUnauthorized, protocol.ErrorCodeUnauthorized, "authentication required"
	case errors.Is(err, auth.ErrForbidden):
		status, code, message = http.StatusForbidden, protocol.ErrorCodeUnauthorized, "operation is not authorized"
	case errors.Is(err, auth.ErrNotFound):
		status, code, message = http.StatusNotFound, protocol.ErrorCodeNotFound, "session resource is unavailable"
	case errors.Is(err, protocol.ErrUnsupportedSessionPath):
		status, code, message = http.StatusBadRequest, protocol.ErrorCodeUnsupportedPath, "requested session path is unsupported"
	case errors.Is(err, protocol.ErrUnknownCommandResult):
		status, code, message = http.StatusConflict, protocol.ErrorCodeUnknownResult, "session creation outcome requires reconciliation"
	case errors.Is(err, protocol.ErrIdempotencyConflict):
		status, code, message = http.StatusConflict, protocol.ErrorCodeIdempotencyConflict, "command identity conflicts with an existing request"
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, sessions.ErrInvalidSession):
		status, code, message = http.StatusBadRequest, protocol.ErrorCodeInvalidRequest, "invalid session creation request"
	case errors.Is(err, sessions.ErrTaskBound), errors.Is(err, sessions.ErrProjectMismatch), errors.Is(err, sessions.ErrSessionConflict), errors.Is(err, sessions.ErrSessionTransition):
		status, code, message = http.StatusConflict, protocol.ErrorCodeConflict, "session creation conflicts with persisted state"
	case errors.Is(err, hosts.ErrNotFound), errors.Is(err, hosts.ErrCommandNotDelivered), errors.Is(err, gateway.ErrNoActiveConnection):
		status, code, message = http.StatusServiceUnavailable, protocol.ErrorCodeConflict, "execution host is not ready"
	}
	requestID := request.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "req_" + rand.Text()
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(protocol.ApiError{Code: code, Message: message, RequestID: requestID})
}

func writeSessionBindingError(writer http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusServiceUnavailable
	code := protocol.ErrorCodeInvalidRequest
	message := "session binding is temporarily unavailable"
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		status, code, message = http.StatusUnauthorized, protocol.ErrorCodeUnauthorized, "authentication required"
	case errors.Is(err, auth.ErrNotFound), errors.Is(err, sessions.ErrTaskNotFound), errors.Is(err, sessions.ErrSessionNotFound):
		status, code, message = http.StatusNotFound, protocol.ErrorCodeNotFound, "session or task is unavailable"
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, sessions.ErrInvalidSession), errors.Is(err, sessions.ErrShareConfirmation):
		status, code, message = http.StatusBadRequest, protocol.ErrorCodeInvalidRequest, "invalid session binding request"
	case errors.Is(err, sessions.ErrTaskBound), errors.Is(err, sessions.ErrSessionBound), errors.Is(err, sessions.ErrProjectMismatch), errors.Is(err, sessions.ErrSessionTerminal), errors.Is(err, sessions.ErrSessionConflict), errors.Is(err, sessions.ErrSessionTransition):
		status, code, message = http.StatusConflict, protocol.ErrorCodeConflict, "session binding conflicts with persisted state"
	}
	requestID := request.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "req_" + rand.Text()
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(protocol.ApiError{Code: code, Message: message, RequestID: requestID})
}
