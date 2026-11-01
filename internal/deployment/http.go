package deployment

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/go-chi/chi/v5"
)

// NewAPIHandler returns the relative /api/v1 deployment routes. The handler
// resolves the caller for every request so it can be safely reused by REST and
// the MCP adapter without creating a second authorization implementation.
func NewAPIHandler(identity auth.PrincipalResolver, service *Service, readOnly bool) http.Handler {
	router := chi.NewRouter()
	MountAPI(router, identity, service, readOnly)
	return router
}

func MountAPI(router chi.Router, identity auth.PrincipalResolver, service *Service, readOnly bool) {
	status := statusHandler(identity, service)
	router.Get("/deployment", status)
	router.Get("/deployment/", status)
	router.Get("/deployment/candidates", candidatesHandler(identity, service))
	if !readOnly {
		router.Post("/deployment/candidates", registerCandidateHandler(identity, service))
	}
	router.Get("/deployment/events", eventsHandler(identity, service))
	router.Get("/deployment/operations/{operation_id}", operationHandler(identity, service))
	if readOnly {
		return
	}
	for _, kind := range []string{"preflight", "stage", "promote", "rollback", "drain", "reconcile"} {
		router.Post("/deployment/"+kind, startOperationHandler(identity, service, kind))
	}
}

func statusHandler(identity auth.PrincipalResolver, service *Service) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := resolvePrincipal(writer, request, identity)
		if !ok {
			return
		}
		status, err := service.Status(request.Context(), principal)
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment status is unavailable")
			return
		}
		auth.WriteJSON(writer, http.StatusOK, StatusResponse{Status: status})
	}
}

func candidatesHandler(identity auth.PrincipalResolver, service *Service) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := resolvePrincipal(writer, request, identity)
		if !ok {
			return
		}
		if _, err := service.Require(request.Context(), principal, CapabilityView); err != nil {
			writeDeploymentError(writer, request, err, "deployment candidates are unavailable")
			return
		}
		candidates, err := service.ListCandidates(request.Context())
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment candidates are unavailable")
			return
		}
		auth.WriteJSON(writer, http.StatusOK, CandidateListResponse{Candidates: candidates})
	}
}

func registerCandidateHandler(identity auth.PrincipalResolver, service *Service) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := resolvePrincipal(writer, request, identity)
		if !ok {
			return
		}
		if _, err := service.Require(request.Context(), principal, CapabilityPreflight); err != nil {
			writeDeploymentError(writer, request, err, "deployment candidate registration is unavailable")
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, 2<<20))
		if err != nil {
			writeDeploymentError(writer, request, errors.Join(auth.ErrInvalid, err), "deployment candidate request is invalid")
			return
		}
		envelope, err := ParseDeploymentEnvelope(body)
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment candidate request is invalid")
			return
		}
		candidate, err := service.RegisterCandidate(request.Context(), envelope)
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment candidate was not registered")
			return
		}
		auth.WriteJSON(writer, http.StatusCreated, CandidateResponse{Candidate: candidate})
	}
}

func eventsHandler(identity auth.PrincipalResolver, service *Service) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := resolvePrincipal(writer, request, identity)
		if !ok {
			return
		}
		if _, err := service.Require(request.Context(), principal, CapabilityView); err != nil {
			writeDeploymentError(writer, request, err, "deployment events are unavailable")
			return
		}
		limit, err := strconv.Atoi(request.URL.Query().Get("limit"))
		if err != nil && request.URL.Query().Get("limit") != "" {
			writeDeploymentError(writer, request, errors.Join(auth.ErrInvalid, err), "limit must be an integer")
			return
		}
		events, err := service.ListEvents(request.Context(), limit)
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment events are unavailable")
			return
		}
		auth.WriteJSON(writer, http.StatusOK, EventListResponse{Events: events})
	}
}

func operationHandler(identity auth.PrincipalResolver, service *Service) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := resolvePrincipal(writer, request, identity)
		if !ok {
			return
		}
		if _, err := service.Require(request.Context(), principal, CapabilityView); err != nil {
			writeDeploymentError(writer, request, err, "deployment operation is unavailable")
			return
		}
		operation, err := service.GetOperation(request.Context(), chi.URLParam(request, "operation_id"))
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment operation is unavailable")
			return
		}
		auth.WriteJSON(writer, http.StatusOK, OperationResponse{Operation: operation})
	}
}

func startOperationHandler(identity auth.PrincipalResolver, service *Service, kind string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := resolvePrincipal(writer, request, identity)
		if !ok {
			return
		}
		var operationRequest OperationRequest
		if err := auth.DecodeJSON(request, &operationRequest); err != nil {
			writeDeploymentError(writer, request, err, "deployment request is invalid")
			return
		}
		operation, created, err := service.StartOperation(request.Context(), principal, kind, operationRequest, request.Header.Get("Idempotency-Key"))
		if err != nil {
			writeDeploymentError(writer, request, err, "deployment operation was not accepted")
			return
		}
		auth.WriteJSON(writer, http.StatusAccepted, OperationResponse{Operation: operation, Created: created})
	}
}

func resolvePrincipal(writer http.ResponseWriter, request *http.Request, identity auth.PrincipalResolver) (auth.Principal, bool) {
	if identity == nil {
		auth.WriteError(writer, request, http.StatusServiceUnavailable, auth.ErrUnavailable, "deployment authentication is unavailable")
		return auth.Principal{}, false
	}
	principal, err := identity.ResolvePrincipal(request.Context(), request)
	if err != nil {
		auth.WriteError(writer, request, auth.StatusForError(err), err, "authentication required")
		return auth.Principal{}, false
	}
	return principal, true
}

func writeDeploymentError(writer http.ResponseWriter, request *http.Request, err error, message string) {
	status := auth.StatusForError(err)
	mapped := err
	switch {
	case errors.Is(err, ErrIdempotencyConflict), errors.Is(err, ErrStaleFingerprint), errors.Is(err, ErrOperationLocked):
		status = http.StatusConflict
		mapped = auth.ErrConflict
	case errors.Is(err, ErrExecutorUnavailable):
		status = http.StatusServiceUnavailable
		mapped = auth.ErrUnavailable
	case errors.Is(err, ErrInvalidCandidate):
		status = http.StatusBadRequest
		mapped = auth.ErrInvalid
	}
	if status < http.StatusBadRequest {
		status = http.StatusInternalServerError
	}
	auth.WriteError(writer, request, status, mapped, message)
}
