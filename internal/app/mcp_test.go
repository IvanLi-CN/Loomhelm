package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPRouteUsesRuntimeAssemblyAndOfficialClient(t *testing.T) {
	var authorization string
	var cookie string
	rest := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		cookie = request.Header.Get("Cookie")
		if request.Method != http.MethodGet || request.URL.Path != "/projects" {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"has_more":false,"items":[]}`)
	})
	mcpHandler, err := newMCPHandler(rest, "test-version")
	if err != nil {
		t.Fatalf("newMCPHandler() error = %v", err)
	}
	server, err := newTestServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("newTestServer() error = %v", err)
	}
	server.resources = &fakeRuntime{mcp: mcpHandler}
	if err := server.lifecycle.Start(); err != nil {
		t.Fatalf("lifecycle.Start() error = %v", err)
	}
	httpServer := httptest.NewServer(server.Router())
	defer httpServer.Close()

	httpClient := httpServer.Client()
	httpClient.Transport = &mcpHeaderTransport{
		base:          httpClient.Transport,
		authorization: "Bearer mcp-acceptance",
		cookie:        "loomhelm_session=mcp-acceptance",
	}
	client := sdk.NewClient(&sdk.Implementation{Name: "loomhelm-app-test", Version: "test"}, nil)
	session, err := client.Connect(context.Background(), &sdk.StreamableClientTransport{
		Endpoint:             httpServer.URL + "/mcp",
		HTTPClient:           httpClient,
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatalf("official SDK Connect() error = %v", err)
	}
	defer session.Close()

	if result := session.InitializeResult(); result == nil || result.ServerInfo == nil || result.ServerInfo.Name != "loomhelm" || result.ServerInfo.Version != "test-version" {
		t.Fatalf("initialize result = %#v", session.InitializeResult())
	}
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("official SDK ListTools() error = %v", err)
	}
	if len(tools.Tools) != len(protocol.MCPTools) {
		t.Fatalf("tool count = %d, want %d", len(tools.Tools), len(protocol.MCPTools))
	}
	call, err := session.CallTool(context.Background(), &sdk.CallToolParams{
		Name:      "loomhelm.list_projects",
		Arguments: map[string]any{"limit": 1},
	})
	if err != nil {
		t.Fatalf("official SDK CallTool() error = %v", err)
	}
	if call.IsError || len(call.Content) == 0 {
		t.Fatalf("tool call result = %#v, want successful content", call)
	}
	if authorization != "Bearer mcp-acceptance" || cookie != "loomhelm_session=mcp-acceptance" {
		t.Fatalf("delegated headers authorization=%q cookie=%q", authorization, cookie)
	}
}

func TestMCPRouteRejectsBeforeRuntimeIsReady(t *testing.T) {
	server, err := newTestServer(platform.Config{
		Component:       platform.ComponentServer,
		Version:         "test-version",
		HTTPAddr:        "127.0.0.1:0",
		DrainToken:      "token",
		ShutdownTimeout: time.Second,
	}, nil)
	if err != nil {
		t.Fatalf("newTestServer() error = %v", err)
	}
	response := httptest.NewRecorder()
	server.Router().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("unready MCP response status=%d cache=%q retry=%q", response.Code, response.Header().Get("Cache-Control"), response.Header().Get("Retry-After"))
	}
}

type mcpHeaderTransport struct {
	base          http.RoundTripper
	authorization string
	cookie        string
}

func (t *mcpHeaderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", t.authorization)
	clone.Header.Set("Cookie", t.cookie)
	return t.base.RoundTrip(clone)
}
