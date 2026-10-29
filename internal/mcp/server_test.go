package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestServerDiscoveryMatchesGeneratedContract(t *testing.T) {
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	})

	if got, want := len(server.Tools()), len(protocol.MCPTools); got != want {
		t.Fatalf("tool count = %d, want %d", got, want)
	}
	if got, want := len(server.ResourceTemplates()), len(protocol.MCPResources); got != want {
		t.Fatalf("resource template count = %d, want %d", got, want)
	}
	for _, tool := range server.Tools() {
		var schema map[string]any
		data, err := json.Marshal(tool.InputSchema)
		if err != nil || json.Unmarshal(data, &schema) != nil {
			t.Fatalf("tool %q input schema is invalid JSON: %v", tool.Name, err)
		}
		if schema["type"] != "object" || schema["additionalProperties"] != false {
			t.Fatalf("tool %q input schema = %#v, want a closed object schema", tool.Name, schema)
		}
	}

	toolsResponse := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/list",
	})
	var toolsResult struct {
		Tools []map[string]any `json:"tools"`
	}
	decodeResult(t, toolsResponse, &toolsResult)
	if len(toolsResult.Tools) != len(server.Tools()) {
		t.Fatalf("tools/list count = %d, want %d", len(toolsResult.Tools), len(server.Tools()))
	}
	expectedToolNames := make(map[string]struct{}, len(server.Tools()))
	for _, tool := range server.Tools() {
		expectedToolNames[tool.Name] = struct{}{}
	}
	for _, tool := range toolsResult.Tools {
		name, _ := tool["name"].(string)
		if _, ok := expectedToolNames[name]; !ok {
			t.Fatalf("tools/list contains unexpected tool %q", name)
		}
	}

	resourcesResponse := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "resources/templates/list",
	})
	var resourcesResult struct {
		Resources []ResourceTemplate `json:"resourceTemplates"`
	}
	decodeResult(t, resourcesResponse, &resourcesResult)
	expectedResources := server.ResourceTemplates()
	if len(resourcesResult.Resources) != len(expectedResources) {
		t.Fatalf("resource template count = %d, want %d", len(resourcesResult.Resources), len(expectedResources))
	}
	for _, resource := range resourcesResult.Resources {
		found := false
		for _, expected := range expectedResources {
			if reflect.DeepEqual(resource, expected) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("resources/templates/list contains unexpected resource %#v", resource)
		}
	}
}

func TestServerLifecycleNegotiatesAndAcceptsInitializedNotification(t *testing.T) {
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	})

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      "initialize-1",
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": ProtocolVersion,
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "test-client", "version": "1"},
		},
	})
	var result struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools     map[string]any `json:"tools"`
			Resources map[string]any `json:"resources"`
		} `json:"capabilities"`
	}
	decodeResult(t, response, &result)
	if result.ProtocolVersion != ProtocolVersion {
		t.Fatalf("negotiated protocol = %q, want %q", result.ProtocolVersion, ProtocolVersion)
	}
	if result.Capabilities.Tools == nil || result.Capabilities.Resources == nil {
		t.Fatalf("initialize capabilities = %#v, want tools and resources", result.Capabilities)
	}

	requestBody := mustJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("initialized notification status = %d, want %d", recorder.Code, http.StatusAccepted)
	}
}

func TestServerToolCallDelegatesAuthenticationPathAndBody(t *testing.T) {
	var seenAuthorization string
	var seenCookie string
	var seenPath string
	var seenMethod string
	var seenBody map[string]any
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		seenAuthorization = request.Header.Get("Authorization")
		seenCookie = request.Header.Get("Cookie")
		seenPath = request.URL.RequestURI()
		seenMethod = request.Method
		if err := json.NewDecoder(request.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode delegated REST body: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"project":{"id":"p-1","name":"Loomhelm"}}`))
	})

	response := callMCPWithHeaders(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "loomhelm.create_project",
			"arguments": map[string]any{
				"name":        "Loomhelm",
				"description": "self-hosted",
			},
		},
	}, map[string]string{"Authorization": "Bearer test-token", "Cookie": "loomhelm_session=session-token"})

	var result struct {
		StructuredContent map[string]any `json:"structuredContent"`
		IsError           bool           `json:"isError"`
	}
	decodeResult(t, response, &result)
	if result.IsError {
		t.Fatalf("successful REST response returned an MCP tool error")
	}
	if result.StructuredContent["project"] == nil {
		t.Fatalf("structured tool content = %#v, want project", result.StructuredContent)
	}
	if seenAuthorization != "Bearer test-token" {
		t.Fatalf("delegated Authorization = %q, want bearer token", seenAuthorization)
	}
	if seenCookie != "loomhelm_session=session-token" {
		t.Fatalf("delegated Cookie = %q, want browser session cookie", seenCookie)
	}
	if seenMethod != http.MethodPost || seenPath != "/projects" {
		t.Fatalf("delegated request = %s %s, want POST /projects", seenMethod, seenPath)
	}
	if seenBody["name"] != "Loomhelm" || seenBody["description"] != "self-hosted" {
		t.Fatalf("delegated body = %#v", seenBody)
	}
}

func TestServerToolCallPreservesRESTErrorAsToolError(t *testing.T) {
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(writer).Encode(protocol.ApiError{
			Code:      protocol.ErrorCodeUnauthorized,
			Message:   "project access denied",
			RequestID: "req-1",
		})
	})

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      8,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "loomhelm.list_projects",
			"arguments": map[string]any{},
		},
	})
	var result struct {
		StructuredContent struct {
			HTTPStatus int `json:"http_status"`
			Error      struct {
				Code    protocol.ErrorCode `json:"code"`
				Message string             `json:"message"`
			} `json:"error"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError {
		t.Fatalf("REST failure did not set MCP tool isError")
	}
	if result.StructuredContent.HTTPStatus != http.StatusForbidden || result.StructuredContent.Error.Code != protocol.ErrorCodeUnauthorized || result.StructuredContent.Error.Message != "project access denied" {
		t.Fatalf("tool error content = %#v", result.StructuredContent)
	}
}

func TestServerPreservesRESTQueryValidation(t *testing.T) {
	var seenPath string
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		seenPath = request.URL.RequestURI()
		writer.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(writer).Encode(protocol.ApiError{
			Code:    protocol.ErrorCodeInvalidRequest,
			Message: "invalid project list query",
		})
	})

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      10,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "loomhelm.list_projects",
			"arguments": map[string]any{
				"limit": "bad",
			},
		},
	})
	var result struct {
		StructuredContent struct {
			HTTPStatus int `json:"http_status"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError || result.StructuredContent.HTTPStatus != http.StatusBadRequest {
		t.Fatalf("query validation result = %#v, want MCP tool error with HTTP 400", result)
	}
	if seenPath != "/projects?limit=bad" {
		t.Fatalf("delegated malformed query path = %q, want /projects?limit=bad", seenPath)
	}
}

func TestServerReportsOversizedApplicationOutcomeAsUnknown(t *testing.T) {
	calls := 0
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls++
			_, _ = writer.Write(bytes.Repeat([]byte("x"), 600))
		}),
		MaxResponseBytes: 512,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      11,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "loomhelm.create_project",
			"arguments": map[string]any{
				"name": "Loomhelm",
			},
		},
	})
	var result struct {
		StructuredContent struct {
			HTTPStatus int `json:"http_status"`
			Error      struct {
				Code protocol.ErrorCode `json:"code"`
			} `json:"error"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError || result.StructuredContent.HTTPStatus != http.StatusConflict || result.StructuredContent.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("oversized response result = %#v, want unknown outcome", result)
	}
	if calls != 1 {
		t.Fatalf("REST invocation count = %d, want exactly one", calls)
	}
}

func TestServerReportsInvalidMutationResponseAsUnknown(t *testing.T) {
	calls := 0
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		calls++
		_, _ = writer.Write([]byte("not-json"))
	})

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      12,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "loomhelm.create_user_credential",
			"arguments": map[string]any{
				"name": "automation",
			},
		},
	})
	var result struct {
		StructuredContent struct {
			HTTPStatus int `json:"http_status"`
			Error      struct {
				Code protocol.ErrorCode `json:"code"`
			} `json:"error"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError || result.StructuredContent.HTTPStatus != http.StatusConflict || result.StructuredContent.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("invalid mutation response = %#v, want unknown outcome", result)
	}
	if calls != 1 {
		t.Fatalf("REST invocation count = %d, want exactly one", calls)
	}
}

func TestServerBoundsEncodedToolResult(t *testing.T) {
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			_, _ = writer.Write([]byte(`{"value":"12345678901234567890123456789012345678901234567890"}`))
		}),
		MaxResponseBytes: 512,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      13,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "loomhelm.create_project",
			"arguments": map[string]any{
				"name": "Loomhelm",
			},
		},
	})
	var result struct {
		StructuredContent struct {
			HTTPStatus int `json:"http_status"`
			Error      struct {
				Code protocol.ErrorCode `json:"code"`
			} `json:"error"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError || result.StructuredContent.HTTPStatus != http.StatusConflict || result.StructuredContent.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("encoded tool result = %#v, want unknown outcome", result)
	}
}

func TestServerCapsFinalWireResponseBody(t *testing.T) {
	server, err := NewServer(Config{
		RESTHandler:      http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {}),
		MaxResponseBytes: 64,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(mustJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      14,
		"method":  "tools/list",
	})))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized wire response status = %d, want %d", recorder.Code, http.StatusRequestEntityTooLarge)
	}
	if len(recorder.Body.Bytes()) > 64 {
		t.Fatalf("oversized wire response body = %d bytes, want at most 64", recorder.Body.Len())
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "too_large" {
		t.Fatalf("oversized wire response marker = %q, want too_large", got)
	}
}

func TestServerRejectsOversizedRequestIDBeforeMutation(t *testing.T) {
	calls := 0
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls++
		}),
		MaxResponseBytes: 512,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	body := []byte(`{"jsonrpc":"2.0","id":"`)
	body = append(body, bytes.Repeat([]byte("x"), 100)...)
	body = append(body, []byte(`","method":"tools/call","params":{"name":"loomhelm.create_project","arguments":{"name":"Loomhelm"}}}`)...)
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request ID status = %d, want %d", recorder.Code, http.StatusRequestEntityTooLarge)
	}
	if recorder.Body.Len() > 512 {
		t.Fatalf("oversized request ID response body = %d bytes, want at most 512", recorder.Body.Len())
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "request_id_too_large" {
		t.Fatalf("oversized request ID marker = %q, want request_id_too_large", got)
	}
	if calls != 0 {
		t.Fatalf("REST invocation count = %d, want zero", calls)
	}
}

func TestServerRejectsUnreadableRequestBodyBeforeMutation(t *testing.T) {
	calls := 0
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		calls++
	})
	body := mustJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      15,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "loomhelm.create_project",
			"arguments": map[string]any{
				"name": "Loomhelm",
			},
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Body = &failingRequestBody{body: body}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unreadable request body status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "request_body_unreadable" {
		t.Fatalf("unreadable request body marker = %q, want request_body_unreadable", got)
	}
	if calls != 0 {
		t.Fatalf("REST invocation count = %d, want zero", calls)
	}
}

type failingRequestBody struct {
	body  []byte
	read  bool
	close bool
}

func (b *failingRequestBody) Read(destination []byte) (int, error) {
	if b.read {
		return 0, errors.New("request body read failed")
	}
	b.read = true
	return copy(destination, b.body), errors.New("request body read failed")
}

func (b *failingRequestBody) Close() error {
	b.close = true
	return nil
}

func TestServerResourceReadDelegatesParameterizedURI(t *testing.T) {
	var seenPath string
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		seenPath = request.URL.Path
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"session":{"id":"session-1"}}`))
	})

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      9,
		"method":  "resources/read",
		"params": map[string]any{
			"uri": "loomhelm://sessions/session-1",
		},
	})
	var result struct {
		Contents []struct {
			URI      string `json:"uri"`
			MIMEType string `json:"mimeType"`
			Text     string `json:"text"`
		} `json:"contents"`
	}
	decodeResult(t, response, &result)
	if seenPath != "/sessions/session-1" {
		t.Fatalf("delegated resource path = %q, want /sessions/session-1", seenPath)
	}
	if len(result.Contents) != 1 || result.Contents[0].URI != "loomhelm://sessions/session-1" || result.Contents[0].MIMEType != "application/json" || result.Contents[0].Text == "" {
		t.Fatalf("resource result = %#v", result.Contents)
	}
}

func TestServerRejectsUntrustedOriginAndNonPost(t *testing.T) {
	server, err := NewServer(Config{
		RESTHandler:    http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {}),
		AllowedOrigins: []string{"https://loomhelm.example"},
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	originRequest := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)))
	originRequest.Header.Set("Content-Type", "application/json")
	originRequest.Header.Set("Accept", "application/json, text/event-stream")
	originRequest.Header.Set("Origin", "https://attacker.example")
	originRecorder := httptest.NewRecorder()
	server.ServeHTTP(originRecorder, originRequest)
	if originRecorder.Code != http.StatusForbidden {
		t.Fatalf("untrusted origin status = %d, want %d", originRecorder.Code, http.StatusForbidden)
	}

	crossSiteRequest := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)))
	crossSiteRequest.Header.Set("Content-Type", "application/json")
	crossSiteRequest.Header.Set("Accept", "application/json, text/event-stream")
	crossSiteRequest.Header.Set("Sec-Fetch-Site", "cross-site")
	crossSiteRecorder := httptest.NewRecorder()
	server.ServeHTTP(crossSiteRecorder, crossSiteRequest)
	if crossSiteRecorder.Code != http.StatusForbidden {
		t.Fatalf("cross-site request status = %d, want %d", crossSiteRecorder.Code, http.StatusForbidden)
	}

	getRecorder := httptest.NewRecorder()
	server.ServeHTTP(getRecorder, httptest.NewRequest(http.MethodGet, "/mcp", nil))
	if getRecorder.Code != http.StatusMethodNotAllowed || getRecorder.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET response = %d Allow=%q, want 405/POST", getRecorder.Code, getRecorder.Header().Get("Allow"))
	}
}

func newTestServer(t *testing.T, handler http.HandlerFunc) *Server {
	t.Helper()
	server, err := NewServer(Config{RESTHandler: handler})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	return server
}

func callMCP(t *testing.T, server *Server, message map[string]any) map[string]any {
	return callMCPWithHeaders(t, server, message, nil)
}

func callMCPWithHeaders(t *testing.T, server *Server, message map[string]any, headers map[string]string) map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(mustJSON(t, message)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("MCP response status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("MCP Cache-Control = %q, want no-store", got)
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode MCP response: %v; body = %s", err, recorder.Body.String())
	}
	if response["error"] != nil {
		t.Fatalf("MCP response error = %v", response["error"])
	}
	return response
}

func decodeResult(t *testing.T, response map[string]any, destination any) {
	t.Helper()
	result, ok := response["result"]
	if !ok {
		t.Fatalf("MCP response has no result: %#v", response)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if err := json.Unmarshal(data, destination); err != nil {
		t.Fatalf("decode result: %v", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}
	return data
}
