package mcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestOfficialSDKClientAcceptance(t *testing.T) {
	var authorization string
	var cookie string
	rest := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		cookie = request.Header.Get("Cookie")
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/projects":
			_, _ = io.WriteString(writer, `{"projects":[]}`)
		case "/sessions/session-1":
			_, _ = io.WriteString(writer, `{"id":"session-1","status":"running"}`)
		default:
			http.NotFound(writer, request)
		}
	})

	mcpServer, err := NewServer(Config{RESTHandler: rest})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	httpServer := httptest.NewServer(mcpServer)
	defer httpServer.Close()

	httpClient := httpServer.Client()
	httpClient.Transport = &acceptanceHeaderTransport{
		base:          httpClient.Transport,
		authorization: "Bearer acceptance-token",
		cookie:        "loomhelm_session=acceptance",
	}
	client := sdk.NewClient(&sdk.Implementation{Name: "loomhelm-acceptance", Version: "test"}, nil)
	session, err := client.Connect(context.Background(), &sdk.StreamableClientTransport{
		Endpoint:             httpServer.URL,
		HTTPClient:           httpClient,
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatalf("official SDK Connect() error = %v", err)
	}
	defer session.Close()

	if result := session.InitializeResult(); result == nil || result.ServerInfo == nil || result.ServerInfo.Name != "loomhelm" {
		t.Fatalf("initialize result = %#v, want Loomhelm server identity", session.InitializeResult())
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

	templates, err := session.ListResourceTemplates(context.Background(), nil)
	if err != nil {
		t.Fatalf("official SDK ListResourceTemplates() error = %v", err)
	}
	if len(templates.ResourceTemplates) != len(protocol.MCPResources) {
		t.Fatalf("resource template count = %d, want %d", len(templates.ResourceTemplates), len(protocol.MCPResources))
	}

	resource, err := session.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: "loomhelm://sessions/session-1"})
	if err != nil {
		t.Fatalf("official SDK ReadResource() error = %v", err)
	}
	if len(resource.Contents) != 1 || resource.Contents[0].Text != `{"id":"session-1","status":"running"}` {
		t.Fatalf("resource result = %#v, want delegated session JSON", resource)
	}
	if authorization != "Bearer acceptance-token" || cookie != "loomhelm_session=acceptance" {
		t.Fatalf("delegated headers authorization=%q cookie=%q", authorization, cookie)
	}
}

type acceptanceHeaderTransport struct {
	base          http.RoundTripper
	authorization string
	cookie        string
}

func (t *acceptanceHeaderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", t.authorization)
	clone.Header.Set("Cookie", t.cookie)
	return t.base.RoundTrip(clone)
}
