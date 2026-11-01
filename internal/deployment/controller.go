package deployment

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	loomhelmMCP "github.com/IvanLi-CN/Loomhelm/internal/mcp"
	"github.com/go-chi/chi/v5"
)

func NewControllerHTTPHandler(identity *auth.Service, service *Service, version string) (http.Handler, error) {
	api := NewAPIHandler(identity, service, false)
	mcpHandler, err := loomhelmMCP.NewHandler(loomhelmMCP.Config{
		RESTHandler:   api,
		ServerName:    "loomhelm-deployment-controller",
		ServerVersion: version,
	})
	if err != nil {
		return nil, err
	}

	protected := identity.Middleware(identity.ExpectedPrincipalMiddleware(api))
	protectedMCP := identity.Middleware(identity.ExpectedPrincipalMiddleware(mcpHandler))
	protection := http.NewCrossOriginProtection()
	protection.SetDenyHandler(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		auth.WriteError(writer, request, http.StatusForbidden, auth.ErrForbidden, "cross-origin browser request rejected")
	}))
	protected = protection.Handler(protected)
	protectedMCP = protection.Handler(protectedMCP)

	router := chi.NewRouter()
	router.Mount("/api/v1", protected)
	router.Handle("/mcp", protectedMCP)
	router.Get("/livez", controllerHealthHandler("alive", version))
	router.Get("/readyz", controllerReadyHandler(service, version))
	router.Get("/version", func(writer http.ResponseWriter, _ *http.Request) {
		writeControllerJSON(writer, http.StatusOK, map[string]string{
			"component": "deployment-controller",
			"version":   version,
		})
	})
	return router, nil
}

func controllerReadyHandler(service *Service, version string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		ready := service != nil && service.Ready(ctx) == nil
		statusCode := http.StatusOK
		status := "ready"
		if !ready {
			statusCode = http.StatusServiceUnavailable
			status = "not_ready"
		}
		writeControllerJSONWithStatus(writer, statusCode, map[string]any{
			"status":    status,
			"component": "deployment-controller",
			"version":   version,
			"ready":     ready,
			"live":      true,
		})
	}
}

func controllerHealthHandler(status, version string) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writeControllerJSONWithStatus(writer, http.StatusOK, map[string]any{
			"status":    status,
			"component": "deployment-controller",
			"version":   version,
			"ready":     true,
			"live":      true,
		})
	}
}

func writeControllerJSON(writer http.ResponseWriter, status int, value any) {
	writeControllerJSONWithStatus(writer, status, value)
}

func writeControllerJSONWithStatus(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
