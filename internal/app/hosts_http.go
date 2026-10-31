package app

import (
	"errors"
	"net/http"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
)

type hostHTTP struct {
	principal auth.PrincipalResolver
	registry  *hosts.Service
}

func (h *hostHTTP) mount(router chi.Router) {
	router.Get("/hosts", h.handleList)
	router.Get("/hosts/{host_id}/credentials", h.handleListCredentials)
	router.Delete("/hosts/{host_id}/credentials/{credential_id}", h.handleRevokeCredential)
	router.Get("/hosts/{host_id}/shares", h.handleListShares)
	router.Put("/hosts/{host_id}/shares/{user_id}", h.handleGrantShare)
	router.Delete("/hosts/{host_id}/shares/{user_id}", h.handleRevokeShare)
}

func (h *hostHTTP) currentUser(request *http.Request) (auth.Principal, error) {
	if h == nil || h.registry == nil || h.principal == nil {
		return auth.Principal{}, auth.ErrUnavailable
	}
	principal, err := h.principal.ResolvePrincipal(request.Context(), request)
	if err != nil {
		return auth.Principal{}, err
	}
	if principal.UserID == "" {
		return auth.Principal{}, auth.ErrUnauthenticated
	}
	if len(principal.ProjectScope) != 0 {
		return auth.Principal{}, auth.ErrForbidden
	}
	return principal, nil
}

func (h *hostHTTP) handleList(writer http.ResponseWriter, request *http.Request) {
	principal, err := h.currentUser(request)
	if err != nil {
		h.writeError(writer, request, err, "Host identity is unavailable")
		return
	}
	items, err := h.registry.ListForUser(request.Context(), principal.UserID)
	if err != nil {
		h.writeError(writer, request, err, "failed to list Hosts")
		return
	}
	response := protocol.HostListResponse{Items: make([]protocol.HostResource, 0, len(items))}
	for _, item := range items {
		response.Items = append(response.Items, protocol.HostResource{
			ID:                   item.Host.ID,
			Name:                 item.Host.Name,
			Status:               protocol.HostStatus(item.Host.Status),
			ConnectionGeneration: item.Host.ConnectionGeneration,
			OwnedByCurrentUser:   item.Owned,
			CreatedAt:            item.Host.CreatedAt.UTC().Format(time.RFC3339Nano),
			UpdatedAt:            item.Host.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (h *hostHTTP) handleListCredentials(writer http.ResponseWriter, request *http.Request) {
	principal, err := h.currentUser(request)
	if err != nil {
		h.writeError(writer, request, err, "Host identity is unavailable")
		return
	}
	items, err := h.registry.ListCredentialsForUser(request.Context(), principal.UserID, chi.URLParam(request, "host_id"))
	if err != nil {
		h.writeError(writer, request, err, "failed to list Host credentials")
		return
	}
	response := protocol.HostCredentialListResponse{Items: make([]protocol.HostCredential, 0, len(items))}
	for _, item := range items {
		response.Items = append(response.Items, protocol.HostCredential{
			ID:         item.ID,
			HostID:     item.HostID,
			Name:       item.Name,
			CreatedAt:  item.CreatedAt.UTC().Format(time.RFC3339Nano),
			LastUsedAt: formatHostTime(item.LastUsedAt),
			RevokedAt:  formatHostTime(item.RevokedAt),
		})
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (h *hostHTTP) handleRevokeCredential(writer http.ResponseWriter, request *http.Request) {
	principal, err := h.currentUser(request)
	if err == nil {
		err = h.registry.RevokeCredentialForUser(request.Context(), principal.UserID, chi.URLParam(request, "host_id"), chi.URLParam(request, "credential_id"))
	}
	if err != nil {
		h.writeError(writer, request, err, "failed to revoke Host credential")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (h *hostHTTP) handleListShares(writer http.ResponseWriter, request *http.Request) {
	principal, err := h.currentUser(request)
	if err != nil {
		h.writeError(writer, request, err, "Host identity is unavailable")
		return
	}
	items, err := h.registry.ListShares(request.Context(), principal.UserID, chi.URLParam(request, "host_id"))
	if err != nil {
		h.writeError(writer, request, err, "failed to list Host shares")
		return
	}
	response := protocol.HostShareListResponse{Items: make([]protocol.HostShare, 0, len(items))}
	for _, item := range items {
		response.Items = append(response.Items, protocol.HostShare{
			HostID:    item.HostID,
			UserID:    item.UserID,
			GrantedBy: item.GrantedBy,
			CreatedAt: item.CreatedAt.UTC().Format(time.RFC3339Nano),
			RevokedAt: formatHostTime(item.RevokedAt),
		})
	}
	auth.WriteJSON(writer, http.StatusOK, response)
}

func (h *hostHTTP) handleGrantShare(writer http.ResponseWriter, request *http.Request) {
	principal, err := h.currentUser(request)
	if err == nil {
		share, shareErr := h.registry.GrantShare(request.Context(), principal.UserID, chi.URLParam(request, "host_id"), chi.URLParam(request, "user_id"))
		err = shareErr
		if err == nil {
			auth.WriteJSON(writer, http.StatusOK, protocol.HostShareResponse{Share: protocol.HostShare{
				HostID: share.HostID, UserID: share.UserID, GrantedBy: share.GrantedBy,
				CreatedAt: share.CreatedAt.UTC().Format(time.RFC3339Nano), RevokedAt: formatHostTime(share.RevokedAt),
			}})
			return
		}
	}
	h.writeError(writer, request, err, "failed to grant Host share")
}

func (h *hostHTTP) handleRevokeShare(writer http.ResponseWriter, request *http.Request) {
	principal, err := h.currentUser(request)
	if err == nil {
		err = h.registry.RevokeShare(request.Context(), principal.UserID, chi.URLParam(request, "host_id"), chi.URLParam(request, "user_id"))
	}
	if err != nil {
		h.writeError(writer, request, err, "failed to revoke Host share")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (h *hostHTTP) writeError(writer http.ResponseWriter, request *http.Request, err error, message string) {
	switch {
	case errors.Is(err, hosts.ErrInvalid):
		err = auth.ErrInvalid
	case errors.Is(err, hosts.ErrNotFound):
		err = auth.ErrNotFound
	case errors.Is(err, hosts.ErrForbidden):
		err = auth.ErrForbidden
	case !isHostHTTPAuthError(err):
		err = auth.ErrUnavailable
	}
	auth.WriteError(writer, request, auth.StatusForError(err), err, message)
}

func isHostHTTPAuthError(err error) bool {
	return errors.Is(err, auth.ErrUnauthenticated) ||
		errors.Is(err, auth.ErrForbidden) ||
		errors.Is(err, auth.ErrInvalid) ||
		errors.Is(err, auth.ErrNotFound) ||
		errors.Is(err, auth.ErrUnavailable)
}

func formatHostTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
