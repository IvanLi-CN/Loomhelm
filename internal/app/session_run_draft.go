package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/go-chi/chi/v5"
)

type sessionRunStore interface {
	ListBySession(context.Context, string, *runs.Cursor, int) (runs.SessionRunPage, error)
}

type artifactRunRecords interface {
	GetRun(context.Context, string) (runs.Run, error)
}

type draftStore interface {
	Get(context.Context, string, string) (drafts.Draft, error)
	Apply(context.Context, drafts.UpdateInput) (drafts.Draft, error)
}

type sessionRunHTTP struct {
	principal auth.PrincipalResolver
	sessions  *sessionService
	runs      sessionRunStore
}

func (h *sessionRunHTTP) mount(router chi.Router) {
	router.Get("/sessions/{session_id}/runs", h.list)
}

func (h *sessionRunHTTP) list(writer http.ResponseWriter, request *http.Request) {
	principal, ok := h.resolvePrincipal(writer, request)
	if !ok {
		return
	}
	if h.sessions == nil || h.runs == nil {
		writeRunControlError(writer, request, runs.ErrControlServiceUnavailable)
		return
	}
	sessionID := chi.URLParam(request, "session_id")
	access, err := h.sessions.authorize(request.Context(), principal, sessionID, false)
	if err != nil {
		writeRunControlError(writer, request, err)
		return
	}
	if !access.Confirmed {
		writeRunControlError(writer, request, protocol.ErrUnknownCommandResult)
		return
	}
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		writeRunControlError(writer, request, auth.ErrInvalid)
		return
	}
	after, limit, err := parseSessionRunQuery(values, sessionID)
	if err != nil {
		writeRunControlError(writer, request, err)
		return
	}
	page, err := h.runs.ListBySession(request.Context(), sessionID, after, limit)
	if err != nil {
		writeRunControlError(writer, request, err)
		return
	}
	items := make([]protocol.Run, 0, len(page.Items))
	for _, run := range page.Items {
		items = append(items, publicRun(run))
	}
	response := protocol.RunListResponse{Items: items, HasMore: page.HasMore}
	if page.NextCursor != nil {
		next := runs.EncodeCursor(*page.NextCursor)
		response.NextCursor = &next
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (h *sessionRunHTTP) resolvePrincipal(writer http.ResponseWriter, request *http.Request) (auth.Principal, bool) {
	if h.principal == nil {
		writeRunControlError(writer, request, runs.ErrControlServiceUnavailable)
		return auth.Principal{}, false
	}
	principal, err := h.principal.ResolvePrincipal(request.Context(), request)
	if err == nil && principal.UserID == "" {
		err = auth.ErrUnauthenticated
	}
	if err != nil {
		writeRunControlError(writer, request, err)
		return auth.Principal{}, false
	}
	return principal, true
}

func parseSessionRunQuery(values url.Values, sessionID string) (*runs.Cursor, int, error) {
	for _, key := range []string{"after_cursor", "limit"} {
		if len(values[key]) > 1 {
			return nil, 0, auth.ErrInvalid
		}
	}
	var after *runs.Cursor
	if raw := values.Get("after_cursor"); raw != "" {
		cursor, err := runs.DecodeCursor(raw)
		if err != nil {
			return nil, 0, err
		}
		if cursor.SessionID != sessionID {
			return nil, 0, auth.ErrInvalid
		}
		after = &cursor
	}
	limit := 0
	if values.Has("limit") {
		parsed, err := strconv.Atoi(values.Get("limit"))
		if err != nil || parsed < 1 || parsed > runs.MaxRunListPageSize {
			return nil, 0, auth.ErrInvalid
		}
		limit = parsed
	}
	return after, limit, nil
}

func publicRun(run runs.Run) protocol.Run {
	result := protocol.Run{
		ID:        run.ID,
		SessionID: run.SessionID,
		Status:    run.Status,
		CreatedAt: run.CreatedAt,
	}
	if run.CommandID != "" {
		result.CommandID = appStringPointer(run.CommandID)
	}
	if run.LastCursor != "" {
		result.LastCursor = appStringPointer(run.LastCursor)
	}
	if run.StartedAt != "" {
		result.StartedAt = appStringPointer(run.StartedAt)
	}
	if run.FinishedAt != "" {
		result.FinishedAt = appStringPointer(run.FinishedAt)
	}
	return result
}

type draftHTTP struct {
	principal auth.PrincipalResolver
	sessions  *sessionService
	drafts    draftStore
}

func (h *draftHTTP) mount(router chi.Router) {
	router.Get("/sessions/{session_id}/draft", h.get)
	router.Put("/sessions/{session_id}/draft", h.update)
}

func (h *draftHTTP) get(writer http.ResponseWriter, request *http.Request) {
	access, ok := h.resolveAccess(writer, request, false)
	if !ok {
		return
	}
	if h.drafts == nil {
		writeDraftError(writer, request, drafts.ErrDraftSession)
		return
	}
	draft, err := h.drafts.Get(request.Context(), access.SessionID, access.CreatorUserID)
	if err != nil {
		writeDraftError(writer, request, err)
		return
	}
	auth.WriteJSON(writer, http.StatusOK, protocol.DraftResponse{Draft: publicDraft(draft)})
}

func (h *draftHTTP) update(writer http.ResponseWriter, request *http.Request) {
	access, ok := h.resolveAccess(writer, request, true)
	if !ok {
		return
	}
	if h.drafts == nil {
		writeDraftError(writer, request, drafts.ErrDraftSession)
		return
	}
	var body protocol.UpdateDraftRequest
	if err := decodeDraftUpdateJSON(request, &body); err != nil {
		writeDraftError(writer, request, err)
		return
	}
	draft, err := h.drafts.Apply(request.Context(), drafts.UpdateInput{
		SessionID: access.SessionID, OwnerUserID: access.CreatorUserID,
		MutationID: body.MutationID, ClientID: body.ClientID,
		ClientSequence: body.ClientSequence, Content: body.Content,
		ModificationOrder: &drafts.ModificationOrder{
			PhysicalMillis: body.ModificationOrder.PhysicalMillis,
			LogicalCounter: body.ModificationOrder.LogicalCounter,
			ClientID:       body.ModificationOrder.ClientID,
		},
	})
	if err != nil {
		writeDraftError(writer, request, err)
		return
	}
	auth.WriteJSON(writer, http.StatusOK, protocol.DraftResponse{Draft: publicDraft(draft)})
}

const maxDraftRequestBytes = (drafts.MaxContentBytes * 6) + (16 << 10)

func decodeDraftUpdateJSON(request *http.Request, destination any) error {
	if request == nil || request.Body == nil {
		return fmt.Errorf("%w: request body is required", auth.ErrInvalid)
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, maxDraftRequestBytes+1))
	if err != nil {
		return fmt.Errorf("%w: read request body: %v", auth.ErrInvalid, err)
	}
	if len(data) > maxDraftRequestBytes {
		return fmt.Errorf("%w: request body is too large", auth.ErrInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("%w: %v", auth.ErrInvalid, err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("%w: request body must contain one JSON value", auth.ErrInvalid)
	}
	return nil
}

func (h *draftHTTP) resolveAccess(writer http.ResponseWriter, request *http.Request, write bool) (sessions.SessionAccess, bool) {
	if h.principal == nil || h.sessions == nil {
		writeDraftError(writer, request, runs.ErrControlServiceUnavailable)
		return sessions.SessionAccess{}, false
	}
	principal, err := h.principal.ResolvePrincipal(request.Context(), request)
	if err == nil && principal.UserID == "" {
		err = auth.ErrUnauthenticated
	}
	if err != nil {
		writeDraftError(writer, request, err)
		return sessions.SessionAccess{}, false
	}
	access, err := h.sessions.authorize(request.Context(), principal, chi.URLParam(request, "session_id"), write)
	if err != nil {
		writeDraftError(writer, request, err)
		return sessions.SessionAccess{}, false
	}
	if !access.Confirmed {
		writeDraftError(writer, request, protocol.ErrUnknownCommandResult)
		return sessions.SessionAccess{}, false
	}
	if principal.UserID != access.CreatorUserID {
		writeDraftError(writer, request, auth.ErrNotFound)
		return sessions.SessionAccess{}, false
	}
	return access, true
}

func publicDraft(draft drafts.Draft) protocol.Draft {
	result := protocol.Draft{
		SessionID: draft.SessionID, Content: draft.Content, Revision: draft.Revision,
		ModificationOrder: protocol.ModificationOrder{
			PhysicalMillis: draft.ModificationOrder.PhysicalMillis,
			LogicalCounter: draft.ModificationOrder.LogicalCounter,
			ClientID:       draft.ModificationOrder.ClientID,
		},
		UpdatedAt: draft.UpdatedAt,
	}
	if draft.MutationID != "" {
		result.MutationID = appStringPointer(draft.MutationID)
	}
	if draft.ClientID != "" {
		result.ClientID = appStringPointer(draft.ClientID)
	}
	if draft.ClientSequence != 0 {
		result.ClientSequence = appInt64Pointer(draft.ClientSequence)
	}
	return result
}

func writeDraftError(writer http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusServiceUnavailable
	code := protocol.ErrorCodeInvalidRequest
	message := "draft service is temporarily unavailable"
	switch {
	case errors.Is(err, auth.ErrUnauthenticated):
		status, code, message = http.StatusUnauthorized, protocol.ErrorCodeUnauthorized, "authentication required"
	case errors.Is(err, auth.ErrForbidden):
		status, code, message = http.StatusForbidden, protocol.ErrorCodeUnauthorized, "operation is not authorized"
	case errors.Is(err, protocol.ErrUnknownCommandResult):
		status, code, message = http.StatusConflict, protocol.ErrorCodeUnknownResult, "session outcome requires reconciliation"
	case errors.Is(err, auth.ErrNotFound), errors.Is(err, drafts.ErrDraftSession), errors.Is(err, drafts.ErrDraftOwnerConflict):
		status, code, message = http.StatusNotFound, protocol.ErrorCodeNotFound, "draft resource is unavailable"
	case errors.Is(err, auth.ErrInvalid), errors.Is(err, drafts.ErrInvalidDraft):
		status, code, message = http.StatusBadRequest, protocol.ErrorCodeInvalidRequest, "invalid draft request"
	case errors.Is(err, drafts.ErrDraftOrderRequired), errors.Is(err, drafts.ErrDraftClockSkew), errors.Is(err, drafts.ErrDraftMutation), errors.Is(err, drafts.ErrDraftStaleMutation):
		status, code, message = http.StatusConflict, protocol.ErrorCodeConflict, "draft state changed; refresh before another update"
	}
	requestID := request.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = "req_" + rand.Text()
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	if status == http.StatusServiceUnavailable {
		writer.Header().Set("Retry-After", "1")
	}
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(protocol.ApiError{Code: code, Message: message, RequestID: requestID})
}

func appStringPointer(value string) *string { return &value }

func appInt64Pointer(value int64) *int64 { return &value }
