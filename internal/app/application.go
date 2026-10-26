package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/projects"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
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
	sessionCreation sessionCreationApplication
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
	return services.handler(control), nil
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
		identity: identity,
		projects: projectService,
		tasks:    tasks.NewService(pool, identity, projectService),
		sessions: sessions.NewStore(pool),
	}, nil
}

func (s *applicationServices) handler(control runControlApplication) http.Handler {
	router := chi.NewRouter()
	s.identity.Mount(router)
	s.identity.MountAPI(router)
	s.projects.Mount(router)
	s.tasks.Mount(router)
	s.sessionAccess().mount(router)
	(&runControlHTTP{principal: s.identity, service: control}).mount(router)
	router.Get("/auth/session", func(writer http.ResponseWriter, request *http.Request) {
		principal, err := s.identity.ResolvePrincipal(request.Context(), request)
		if err != nil || principal.UserID == "" || principal.CredentialID != "" {
			status := http.StatusUnauthorized
			if err != nil && !errors.Is(err, auth.ErrUnauthenticated) {
				status = http.StatusInternalServerError
			}
			writeApplicationError(writer, request, status, "browser session is unavailable")
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
	})
}

func (s *applicationServices) sessionAccess() *sessionService {
	return &sessionService{principal: s.identity, projects: s.projects, records: s.sessions, creation: s.sessionCreation}
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
