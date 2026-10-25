package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
)

// runControlApplication is the same application boundary consumed by MCP.
// The HTTP adapter never constructs commands or calls a Connector directly.
type runControlApplication interface {
	SubmitRun(context.Context, auth.Principal, string, protocol.SubmitRunRequest) (protocol.CommandAckResponse, error)
	InterruptRun(context.Context, auth.Principal, string, protocol.InterruptRunRequest) (protocol.CommandAckResponse, error)
	ResolveApproval(context.Context, auth.Principal, string, string, protocol.ResolveApprovalRequest) (protocol.CommandAckResponse, error)
	ListRunEvents(context.Context, auth.Principal, string, protocol.ListRunEventsQuery) (protocol.EventPage, error)
}

type runControlHTTP struct {
	principal auth.PrincipalResolver
	service   runControlApplication
}

func (h *runControlHTTP) mount(router chi.Router) {
	router.Post("/sessions/{session_id}/runs", h.submit)
	router.Post("/runs/{run_id}/interrupt", h.interrupt)
	router.Post("/runs/{run_id}/approvals/{approval_id}", h.resolve)
	router.Get("/runs/{run_id}/events", h.events)
}

func (h *runControlHTTP) resolvePrincipal(w http.ResponseWriter, r *http.Request) (auth.Principal, bool) {
	w.Header().Set("Cache-Control", "no-store")
	if h.principal == nil {
		writeRunControlError(w, r, runs.ErrControlServiceUnavailable)
		return auth.Principal{}, false
	}
	p, err := h.principal.ResolvePrincipal(r.Context(), r)
	if err == nil && p.UserID == "" {
		err = auth.ErrUnauthenticated
	}
	if err != nil {
		writeRunControlError(w, r, err)
		return auth.Principal{}, false
	}
	if h.service == nil {
		writeRunControlError(w, r, runs.ErrControlServiceUnavailable)
		return auth.Principal{}, false
	}
	return p, true
}

func (h *runControlHTTP) submit(w http.ResponseWriter, r *http.Request) {
	p, ok := h.resolvePrincipal(w, r)
	if !ok {
		return
	}
	var body protocol.SubmitRunRequest
	if !decodeRunControlBody(w, r, &body) {
		return
	}
	result, err := h.service.SubmitRun(r.Context(), p, chi.URLParam(r, "session_id"), body)
	writeRunControlResult(w, r, result, err)
}

func (h *runControlHTTP) interrupt(w http.ResponseWriter, r *http.Request) {
	p, ok := h.resolvePrincipal(w, r)
	if !ok {
		return
	}
	var body protocol.InterruptRunRequest
	if !decodeRunControlBody(w, r, &body) {
		return
	}
	result, err := h.service.InterruptRun(r.Context(), p, chi.URLParam(r, "run_id"), body)
	writeRunControlResult(w, r, result, err)
}

func (h *runControlHTTP) resolve(w http.ResponseWriter, r *http.Request) {
	p, ok := h.resolvePrincipal(w, r)
	if !ok {
		return
	}
	var body protocol.ResolveApprovalRequest
	if !decodeRunControlBody(w, r, &body) {
		return
	}
	result, err := h.service.ResolveApproval(r.Context(), p, chi.URLParam(r, "run_id"), chi.URLParam(r, "approval_id"), body)
	writeRunControlResult(w, r, result, err)
}

func (h *runControlHTTP) events(w http.ResponseWriter, r *http.Request) {
	p, ok := h.resolvePrincipal(w, r)
	if !ok {
		return
	}
	query := protocol.ListRunEventsQuery{}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeRunControlError(w, r, auth.ErrInvalid)
		return
	}
	// Reject ambiguity rather than silently choosing one recovery cursor.
	for _, key := range []string{"after_cursor", "limit"} {
		if len(values[key]) > 1 {
			writeRunControlError(w, r, auth.ErrInvalid)
			return
		}
	}
	if values.Has("after_cursor") {
		cursor := values.Get("after_cursor")
		query.AfterCursor = &cursor
	}
	if values.Has("limit") {
		var limit int64
		limit, err = strconv.ParseInt(values.Get("limit"), 10, 64)
		if err != nil || limit <= 0 {
			writeRunControlError(w, r, auth.ErrInvalid)
			return
		}
		query.Limit = &limit
	}
	result, err := h.service.ListRunEvents(r.Context(), p, chi.URLParam(r, "run_id"), query)
	writeRunControlResult(w, r, result, err)
}

func decodeRunControlBody(w http.ResponseWriter, r *http.Request, target any) bool {
	// Object decoding rejects JSON null as well as a missing object. Unknown
	// fields cannot override the URL-selected Session, Run or Approval identity.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	var object json.RawMessage
	if err := decoder.Decode(&object); err != nil || len(object) == 0 || object[0] != '{' {
		writeRunControlError(w, r, auth.ErrInvalid)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeRunControlError(w, r, auth.ErrInvalid)
		return false
	}
	// Decode again into the generated request to enforce its exact field set.
	fields := json.NewDecoder(bytes.NewReader(object))
	fields.DisallowUnknownFields()
	if err := fields.Decode(target); err != nil {
		writeRunControlError(w, r, auth.ErrInvalid)
		return false
	}
	return true
}

func writeRunControlResult(w http.ResponseWriter, r *http.Request, result any, err error) {
	if err != nil {
		writeRunControlError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func writeRunControlError(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := http.StatusServiceUnavailable, protocol.ErrorCodeInvalidRequest, "run control is temporarily unavailable"
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		status, code, message = http.StatusUnauthorized, protocol.ErrorCodeUnauthorized, "authentication required"
	case errors.Is(err, auth.ErrForbidden):
		status, code, message = http.StatusForbidden, protocol.ErrorCodeUnauthorized, "operation is not authorized"
	case errors.Is(err, auth.ErrNotFound), errors.Is(err, runs.ErrRunNotFound), errors.Is(err, sessions.ErrSessionNotFound):
		status, code, message = http.StatusNotFound, protocol.ErrorCodeNotFound, "run resource is unavailable"
	case errors.Is(err, protocol.ErrUnknownCommandResult), errors.Is(err, runs.ErrRunUnknown):
		status, code, message = http.StatusConflict, protocol.ErrorCodeUnknownResult, "command result requires reconciliation"
	case errors.Is(err, protocol.ErrCursorExpired):
		status, code, message = http.StatusConflict, protocol.ErrorCodeCursorExpired, "event cursor requires recovery"
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, runs.ErrInvalidControlRequest), errors.Is(err, runs.ErrInvalidCommand), errors.Is(err, runs.ErrInvalidRun), errors.Is(err, approvals.ErrInvalidApproval):
		status, code, message = http.StatusBadRequest, protocol.ErrorCodeInvalidRequest, "invalid run control request"
	case errors.Is(err, protocol.ErrIdempotencyConflict):
		status, code, message = http.StatusConflict, protocol.ErrorCodeIdempotencyConflict, "command identity conflicts with an existing request"
	case errors.Is(err, auth.ErrConflict), errors.Is(err, runs.ErrRunConflict), errors.Is(err, runs.ErrRunTerminal), errors.Is(err, runs.ErrRunTransition), errors.Is(err, runs.ErrInterruptRequested), errors.Is(err, runs.ErrStaleGeneration), errors.Is(err, approvals.ErrApprovalContext), errors.Is(err, approvals.ErrRevisionStale), errors.Is(err, approvals.ErrApprovalGeneration), errors.Is(err, approvals.ErrApprovalResolved), errors.Is(err, approvals.ErrApprovalNotPending), errors.Is(err, approvals.ErrApprovalExpired):
		status, code, message = http.StatusConflict, protocol.ErrorCodeConflict, "run state changed; refresh before another command"
	}
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "req_" + rand.Text()
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "1")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(protocol.ApiError{Code: code, Message: message, RequestID: requestID})
}
