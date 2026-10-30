package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/drafts"
	loomhelmMCP "github.com/IvanLi-CN/Loomhelm/internal/mcp"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/IvanLi-CN/Loomhelm/internal/tasks"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type applicationServices struct {
	identity        *auth.Service
	projects        *projects.Service
	tasks           *tasks.Service
	sessions        *sessions.Store
	runHistory      sessionRunStore
	runRecords      artifactRunRecords
	drafts          draftStore
	sessionCreation sessionCreationApplication
	artifactStore   protocol.ArtifactStore
}

// newApplicationHandler returns relative routes for Server's /api/v1 mount.
// Protection is applied here, before any session middleware or mutation, so a
// browser capability response cannot outlive its actual enforcement boundary.
func newApplicationHandler(ctx context.Context, pool *pgxpool.Pool, cfg platform.BrowserAuthConfig) (http.Handler, error) {
	return newApplicationHandlerWithRunControl(ctx, pool, cfg, nil)
}

// The runtime supplies the real control service once its durable stores and
// Host transport are ready. An absent dependency exposes explicit unavailable
// responses, never a simulated command acknowledgement.
func newApplicationHandlerWithRunControl(ctx context.Context, pool *pgxpool.Pool, cfg platform.BrowserAuthConfig, control runControlApplication) (http.Handler, error) {
	services, err := newApplicationServices(ctx, pool, cfg)
	if err != nil {
		return nil, err
	}
	handler, err := services.handler(control)
	if err != nil {
		return nil, err
	}
	return handler, nil
}

func newApplicationServices(ctx context.Context, pool *pgxpool.Pool, cfg platform.BrowserAuthConfig) (*applicationServices, error) {
	var provider auth.Provider
	if cfg.OIDCEnabled() {
		configured, err := auth.NewOIDCProvider(ctx, auth.OIDCConfig{
			IssuerURL: cfg.OIDCIssuerURL, ClientID: cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret, RedirectURL: cfg.OIDCRedirectURL,
		})
		if err != nil {
			// Provider errors may contain URLs or upstream response details.
			return nil, errors.New("initialize browser authentication: OIDC discovery failed")
		}
		provider = configured
	}
	identity, err := auth.NewService(pool, auth.Config{SecureCookies: cfg.SecureCookies}, provider)
	if err != nil {
		return nil, fmt.Errorf("initialize browser authentication: %w", err)
	}
	projectService := projects.NewService(pool, identity)
	return &applicationServices{
		identity:   identity,
		projects:   projectService,
		tasks:      tasks.NewService(pool, identity, projectService),
		sessions:   sessions.NewStore(pool),
		runHistory: runs.NewStore(pool),
		runRecords: runs.NewStore(pool),
		drafts:     drafts.NewStore(pool),
	}, nil
}

func (s *applicationServices) handler(control runControlApplication) (http.Handler, error) {
	router := chi.NewRouter()
	s.identity.Mount(router)
	s.identity.MountAPI(router)
	s.projects.Mount(router)
	s.tasks.Mount(router)
	sessionAccess := s.sessionAccess()
	sessionAccess.mount(router)
	(&runControlHTTP{principal: s.identity, service: control}).mount(router)
	(&sessionRunHTTP{principal: s.identity, sessions: sessionAccess, runs: s.runHistory}).mount(router)
	(&draftHTTP{principal: s.identity, sessions: sessionAccess, drafts: s.drafts}).mount(router)
	var download http.Handler = http.HandlerFunc(unavailableArtifactDownload)
	var contentDownload http.Handler = http.HandlerFunc(unavailableArtifactDownload)
	if s.artifactStore != nil {
		handler, err := artifacts.NewDownloadHTTPHandler(s.artifactStore, writeArtifactDownloadError)
		if err != nil {
			return nil, fmt.Errorf("initialize artifact download handler: %w", err)
		}
		download = handler
		contentDownload = http.HandlerFunc(handler.ServeContentHTTP)
	}
	protectedDownload := s.artifactDownloadHandler(download)
	router.Get("/artifacts/{artifact_id}/download", protectedDownload)
	router.Head("/artifacts/{artifact_id}/download", protectedDownload)
	router.Get("/artifacts/{artifact_id}", s.artifactMetadataHandler)
	router.Get("/artifacts/{artifact_id}/content", s.artifactContentHandler(contentDownload))
	router.Get("/auth/session", func(writer http.ResponseWriter, request *http.Request) {
		principal, err := s.identity.ResolvePrincipal(request.Context(), request)
		if err != nil {
			auth.WriteError(writer, request, auth.StatusForError(err), err, "browser session is unavailable")
			return
		}
		if principal.UserID == "" || principal.CredentialID != "" {
			auth.WriteError(writer, request, http.StatusUnauthorized, auth.ErrUnauthenticated, "browser session is unavailable")
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(protocol.BrowserSessionResponse{
			UserID: principal.UserID, CsrfProtection: protocol.BrowserCsrfProtectionSameOrigin,
		})
	})
	// A bearer credential is never evidence of an authenticated browser session,
	// including when the same request also carries a valid browser cookie.
	browserOnly := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if (request.URL.Path == "/api/v1/auth/session" || request.URL.Path == "/api/v1/auth/logout") && len(request.Header.Values("Authorization")) != 0 {
			writeApplicationError(writer, request, http.StatusUnauthorized, "browser session required")
			return
		}
		router.ServeHTTP(writer, request)
	})
	protection := http.NewCrossOriginProtection()
	protection.SetDenyHandler(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeApplicationError(writer, request, http.StatusForbidden, "cross-origin browser request rejected")
	}))
	protected := protection.Handler(s.identity.Middleware(s.identity.ExpectedPrincipalMiddleware(browserOnly)))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		protected.ServeHTTP(writer, request)
	}), nil
}

func (s *applicationServices) artifactDownloadHandler(download http.Handler) http.HandlerFunc {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if len(request.Header.Values("Authorization")) != 0 {
			auth.WriteError(writer, request, http.StatusUnauthorized, auth.ErrUnauthenticated, "browser session required")
			return
		}
		principal, err := s.identity.ResolvePrincipal(request.Context(), request)
		if err != nil || principal.UserID == "" {
			if err == nil {
				err = auth.ErrUnauthenticated
			}
			auth.WriteError(writer, request, auth.StatusForError(err), err, "authentication required")
			return
		}
		request = request.WithContext(context.WithValue(request.Context(), artifactPrincipalContextKey{}, principal))
		download.ServeHTTP(writer, request)
	})
}

func (s *applicationServices) artifactContentHandler(content http.Handler) http.HandlerFunc {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		principal, err := s.identity.ResolvePrincipal(request.Context(), request)
		if err != nil || principal.UserID == "" {
			if err == nil {
				err = auth.ErrUnauthenticated
			}
			auth.WriteError(writer, request, auth.StatusForError(err), err, "authentication required")
			return
		}
		request = request.WithContext(context.WithValue(request.Context(), artifactPrincipalContextKey{}, principal))
		content.ServeHTTP(writer, request)
	})
}

func (s *applicationServices) artifactMetadataHandler(writer http.ResponseWriter, request *http.Request) {
	if s.artifactStore == nil {
		unavailableArtifactDownload(writer, request)
		return
	}
	principal, err := s.identity.ResolvePrincipal(request.Context(), request)
	if err != nil || principal.UserID == "" {
		if err == nil {
			err = auth.ErrUnauthenticated
		}
		auth.WriteError(writer, request, auth.StatusForError(err), err, "authentication required")
		return
	}
	metadataContext := context.WithValue(request.Context(), artifactPrincipalContextKey{}, principal)
	artifact, err := s.artifactStore.Metadata(metadataContext, chi.URLParam(request, "artifact_id"))
	if err != nil {
		writeArtifactStoreError(writer, request, err, "artifact metadata is unavailable")
		return
	}
	artifact.Name = artifacts.SafeDownloadFilename(artifact.Name)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(protocol.ArtifactResponse{Artifact: artifact})
}

func writeArtifactStoreError(writer http.ResponseWriter, request *http.Request, err error, message string) {
	status := artifactStoreStatus(err)
	if status == http.StatusServiceUnavailable && (errors.Is(err, artifacts.ErrRecoveryPending) || errors.Is(err, artifacts.ErrRecoveryIncomplete)) {
		writer.Header().Set("Retry-After", "60")
	}
	writeArtifactDownloadError(writer, request, status, err, message)
}

func artifactStoreStatus(err error) int {
	switch {
	case errors.Is(err, artifacts.ErrInvalid):
		return http.StatusBadRequest
	case errors.Is(err, artifacts.ErrContentChanged):
		return http.StatusConflict
	case errors.Is(err, artifacts.ErrRecoveryPending), errors.Is(err, artifacts.ErrRecoveryIncomplete), errors.Is(err, artifacts.ErrStoreUnavailable):
		return http.StatusServiceUnavailable
	case errors.Is(err, artifacts.ErrNotFound), errors.Is(err, artifacts.ErrUnauthorized), errors.Is(err, artifacts.ErrUnavailable), errors.Is(err, artifacts.ErrIntegrity), errors.Is(err, artifacts.ErrSizeMismatch), errors.Is(err, artifacts.ErrHashMismatch):
		return http.StatusNotFound
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return http.StatusRequestTimeout
	default:
		return http.StatusServiceUnavailable
	}
}

func writeArtifactDownloadError(writer http.ResponseWriter, request *http.Request, status int, err error, message string) {
	apiErr := auth.ErrInvalid
	switch status {
	case http.StatusServiceUnavailable:
		apiErr = auth.ErrUnavailable
	case http.StatusConflict:
		apiErr = auth.ErrConflict
	case http.StatusUnauthorized:
		apiErr = auth.ErrUnauthenticated
	case http.StatusNotFound:
		apiErr = auth.ErrNotFound
	}
	auth.WriteError(writer, request, status, apiErr, message)
}

func unavailableArtifactDownload(writer http.ResponseWriter, request *http.Request) {
	auth.WriteError(writer, request, http.StatusServiceUnavailable, auth.ErrUnavailable, "artifact download is temporarily unavailable")
}

func (s *applicationServices) sessionAccess() *sessionService {
	return &sessionService{principal: s.identity, projects: s.projects, records: s.sessions, creation: s.sessionCreation, binding: s.sessions}
}

func writeApplicationError(writer http.ResponseWriter, request *http.Request, status int, message string) {
	err := auth.ErrInvalid
	if status == http.StatusUnauthorized {
		err = auth.ErrUnauthenticated
	} else if status == http.StatusForbidden {
		err = auth.ErrForbidden
	}
	auth.WriteError(writer, request, status, err, message)
}

func (s *Server) handleApplication(writer http.ResponseWriter, request *http.Request) {
	s.activeApplicationRequests.Add(1)
	defer s.activeApplicationRequests.Add(-1)
	s.resourceMu.RLock()
	var handler http.Handler
	if runtime, ok := s.resources.(interface{ APIHandler() http.Handler }); ok {
		handler = runtime.APIHandler()
	}
	s.resourceMu.RUnlock()
	if handler == nil || s.lifecycle.Snapshot().State != platform.StateRunning {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Retry-After", "1")
		writeApplicationError(writer, request, http.StatusServiceUnavailable, "application is not ready")
		return
	}
	// Do not hold resourceMu across request execution: a long event stream must
	// not prevent lifecycle/drain coordination from progressing.
	handler.ServeHTTP(writer, request)
}

func (s *Server) handleMCP(writer http.ResponseWriter, request *http.Request) {
	s.activeMCPRequests.Add(1)
	defer s.activeMCPRequests.Add(-1)
	s.resourceMu.RLock()
	var handler http.Handler
	if runtime, ok := s.resources.(interface{ MCPHandler() http.Handler }); ok {
		handler = runtime.MCPHandler()
	}
	s.resourceMu.RUnlock()
	if handler == nil || s.lifecycle.Snapshot().State != platform.StateRunning {
		loomhelmMCP.CloseRejectedRequestBody(writer, request)
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Retry-After", "1")
		writeApplicationError(writer, request, http.StatusServiceUnavailable, "application is not ready")
		return
	}
	// MCP shares the application handler and lifecycle admission boundary with
	// REST; the MCP adapter adds only protocol discovery and delegation.
	handler.ServeHTTP(writer, request)
}
