package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestServerCrossProjectRelationshipsThroughOfficialMCP(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component: platform.ComponentServer, Version: "integration", DrainToken: "test-drain",
		ShutdownTimeout: 5 * time.Second, StartupTimeout: 30 * time.Second,
		DatabaseURL: databaseURL, DatabaseMaxConns: 4,
		BrowserAuth: platform.BrowserAuthConfig{OIDCIssuerURL: issuer.URL, OIDCClientID: "loomhelm-test", SecureCookies: false},
	}
	baseURL, stop := startApplicationTestServer(t, cfg)
	defer stop()
	alice := applicationBrowser(t)
	bob := applicationBrowser(t)
	loginApplicationBrowser(t, alice, baseURL, "cross-project-alice")
	loginApplicationBrowser(t, bob, baseURL, "cross-project-bob")

	var aliceIdentity struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &aliceIdentity)
	if aliceIdentity.UserID == "" {
		t.Fatal("Alice session omitted user identity")
	}
	var bobIdentity struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &bobIdentity)
	if bobIdentity.UserID == "" {
		t.Fatal("Bob session omitted user identity")
	}

	var projectA, projectB protocol.ProjectResponse
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "MCP cross-project A"}, map[string]string{"Origin": baseURL}, http.StatusCreated), &projectA)
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{"name": "MCP cross-project B"}, map[string]string{"Origin": baseURL}, http.StatusCreated), &projectB)

	aliceToken := createProjectScopedCredential(t, alice, baseURL, "cross-project-alice-mcp", []string{projectA.Project.ID, projectB.Project.ID})
	aliceMCP := connectOfficialMCP(t, baseURL+"/mcp", aliceToken)

	parent := createMCPTask(t, aliceMCP, projectA.Project.ID, "MCP parent", "parent goal")
	child := createMCPTask(t, aliceMCP, projectB.Project.ID, "MCP child", "child goal")
	if parent.Task.ProjectID != projectA.Project.ID || child.Task.ProjectID != projectB.Project.ID {
		t.Fatalf("MCP task project ownership changed: parent=%+v child=%+v", parent.Task, child.Task)
	}

	callMCPTool(t, aliceMCP, "loomhelm.add_task_parent", map[string]any{
		"task_id":        child.Task.ID,
		"parent_task_id": parent.Task.ID,
	})
	callMCPTool(t, aliceMCP, "loomhelm.add_task_dependency", map[string]any{
		"task_id":              child.Task.ID,
		"prerequisite_task_id": parent.Task.ID,
	})

	var mcpRelationships protocol.TaskRelationshipPage
	decodeMCPStructured(t, callMCPTool(t, aliceMCP, "loomhelm.get_task_relationships", map[string]any{
		"task_id": child.Task.ID,
	}), &mcpRelationships)
	assertCrossProjectRelationships(t, mcpRelationships, parent.Task.ID, child.Task.ID)

	var httpRelationships protocol.TaskRelationshipPage
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/tasks/"+child.Task.ID+"/relationships", nil, nil, http.StatusOK), &httpRelationships)
	assertCrossProjectRelationships(t, httpRelationships, parent.Task.ID, child.Task.ID)

	callMCPToolError(t, aliceMCP, "loomhelm.add_task_parent", map[string]any{
		"task_id":        parent.Task.ID,
		"parent_task_id": child.Task.ID,
	})
	callMCPToolError(t, aliceMCP, "loomhelm.add_task_dependency", map[string]any{
		"task_id":              parent.Task.ID,
		"prerequisite_task_id": child.Task.ID,
	})

	applicationRequest(t, alice, http.MethodPut, baseURL+"/api/v1/projects/"+projectB.Project.ID+"/members/"+bobIdentity.UserID, map[string]string{"role": "viewer"}, map[string]string{"Origin": baseURL}, http.StatusOK)
	bobToken := createProjectScopedCredential(t, bob, baseURL, "cross-project-bob-mcp", []string{projectB.Project.ID})
	bobMCP := connectOfficialMCP(t, baseURL+"/mcp", bobToken)
	var filtered protocol.TaskRelationshipPage
	decodeMCPStructured(t, callMCPTool(t, bobMCP, "loomhelm.get_task_relationships", map[string]any{
		"task_id": child.Task.ID,
	}), &filtered)
	if len(filtered.Parents) != 0 || len(filtered.Prerequisites) != 0 || len(filtered.Children) != 0 || len(filtered.Dependents) != 0 {
		t.Fatalf("MCP relationship read leaked inaccessible parent project: %+v", filtered)
	}
	callMCPToolError(t, bobMCP, "loomhelm.add_task_parent", map[string]any{
		"task_id":        child.Task.ID,
		"parent_task_id": parent.Task.ID,
	})
}

func createProjectScopedCredential(t *testing.T, browser *http.Client, baseURL, name string, projectIDs []string) string {
	t.Helper()
	var credential struct {
		Credential struct {
			Token string `json:"token"`
		} `json:"credential"`
	}
	decodeApplicationResponse(t, applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/credentials", map[string]any{
		"name":        name,
		"project_ids": projectIDs,
	}, map[string]string{"Origin": baseURL}, http.StatusCreated), &credential)
	if credential.Credential.Token == "" {
		t.Fatalf("credential %q omitted one-time token", name)
	}
	return credential.Credential.Token
}

func connectOfficialMCP(t *testing.T, endpoint, token string) *sdk.ClientSession {
	t.Helper()
	httpClient := &http.Client{Timeout: 20 * time.Second, Transport: &mcpHeaderTransport{
		base:          http.DefaultTransport,
		authorization: "Bearer " + token,
	}}
	client := sdk.NewClient(&sdk.Implementation{Name: "loomhelm-cross-project-integration", Version: "test"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:             endpoint,
		HTTPClient:           httpClient,
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatalf("official SDK MCP Connect() error = %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func callMCPTool(t *testing.T, session *sdk.ClientSession, name string, arguments map[string]any) *sdk.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatalf("MCP tool %s error = %v", name, err)
	}
	if result.IsError {
		t.Fatalf("MCP tool %s returned an error: %#v", name, result)
	}
	return result
}

func callMCPToolError(t *testing.T, session *sdk.ClientSession, name string, arguments map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatalf("MCP tool %s transport error = %v", name, err)
	}
	if !result.IsError {
		t.Fatalf("MCP tool %s unexpectedly succeeded: %#v", name, result)
	}
}

func createMCPTask(t *testing.T, session *sdk.ClientSession, projectID, title, goal string) protocol.TaskResponse {
	t.Helper()
	result := callMCPTool(t, session, "loomhelm.create_task", map[string]any{
		"project_id": projectID,
		"title":      title,
		"goal":       goal,
	})
	var response protocol.TaskResponse
	decodeMCPStructured(t, result, &response)
	if response.Task.ID == "" {
		t.Fatalf("MCP create_task returned no task: %#v", result)
	}
	return response
}

func decodeMCPStructured(t *testing.T, result *sdk.CallToolResult, target any) {
	t.Helper()
	if result.StructuredContent == nil {
		t.Fatalf("MCP result omitted structured content: %#v", result)
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatalf("marshal MCP structured content: %v", err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatalf("decode MCP structured content: %v; payload=%s", err, data)
	}
}

func assertCrossProjectRelationships(t *testing.T, relationships protocol.TaskRelationshipPage, parentID, childID string) {
	t.Helper()
	if len(relationships.Parents) != 1 || relationships.Parents[0].ParentTaskID != parentID || relationships.Parents[0].ChildTaskID != childID {
		t.Fatalf("parent relationships = %+v", relationships.Parents)
	}
	if len(relationships.Prerequisites) != 1 || relationships.Prerequisites[0].PrerequisiteTaskID != parentID || relationships.Prerequisites[0].DependentTaskID != childID {
		t.Fatalf("prerequisite relationships = %+v", relationships.Prerequisites)
	}
}
