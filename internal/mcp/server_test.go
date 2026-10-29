package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
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
		_, _ = writer.Write([]byte(`{"project":{"id":"p-1","name":"Loomhelm","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}}`))
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

func TestServerRejectsInvalidMutationArgumentsBeforeREST(t *testing.T) {
	tests := []struct {
		name      string
		arguments map[string]any
	}{
		{
			name: "wrong body type",
			arguments: map[string]any{
				"name": 17,
			},
		},
		{
			name: "optional null",
			arguments: map[string]any{
				"project_id": "project-1",
				"name":       nil,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				writer.WriteHeader(http.StatusInternalServerError)
			})
			toolName := "loomhelm.create_project"
			if test.name == "optional null" {
				toolName = "loomhelm.update_project"
			}
			response := callMCP(t, server, map[string]any{
				"jsonrpc": "2.0",
				"id":      13,
				"method":  "tools/call",
				"params": map[string]any{
					"name":      toolName,
					"arguments": test.arguments,
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
				t.Fatalf("invalid mutation result = %#v, want MCP 400 tool error", result)
			}
			if calls.Load() != 0 {
				t.Fatalf("invalid mutation REST invocation count = %d, want zero", calls.Load())
			}
		})
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
			_, _ = writer.Write(bytes.Repeat([]byte("x"), 2200))
		}),
		MaxResponseBytes: 2048,
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

func TestServerReportsMutationServerFailureAsUnknown(t *testing.T) {
	server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(writer).Encode(protocol.ApiError{
			Code:    protocol.ErrorCodeInvalidRequest,
			Message: "credential transaction failed",
		})
	})

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      16,
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
				Code    protocol.ErrorCode `json:"code"`
				Message string             `json:"message"`
			} `json:"error"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError || result.StructuredContent.HTTPStatus != http.StatusConflict || result.StructuredContent.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("mutation server failure result = %#v, want unknown outcome", result)
	}
	if result.StructuredContent.Error.Message == "credential transaction failed" {
		t.Fatal("mutation server failure exposed a retryable ordinary error instead of unknown outcome")
	}
}

func TestServerReportsMalformedCredentialSuccessAsUnknown(t *testing.T) {
	for name, body := range map[string]string{
		"empty":         "",
		"null":          "null",
		"missing_token": `{"credential":{"id":"credential-1","name":"automation"}}`,
		"missing_id":    `{"credential":{"name":"automation","project_ids":[],"created_at":"2026-01-01T00:00:00Z","token":"secret"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				writer.WriteHeader(http.StatusCreated)
				_, _ = writer.Write([]byte(body))
			})

			response := callMCP(t, server, map[string]any{
				"jsonrpc": "2.0",
				"id":      23,
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
				t.Fatalf("malformed credential success = %#v, want unknown outcome", result)
			}
		})
	}
}

func TestServerReportsMalformedMutationEnvelopeAsUnknown(t *testing.T) {
	for name, body := range map[string]string{
		"empty_object":  `{}`,
		"null":          `null`,
		"null_project":  `{"project":null}`,
		"array_project": `{"project":[]}`,
		"empty_project": `{"project":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := newTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
				writer.WriteHeader(http.StatusCreated)
				_, _ = writer.Write([]byte(body))
			})

			response := callMCP(t, server, map[string]any{
				"jsonrpc": "2.0",
				"id":      24,
				"method":  "tools/call",
				"params": map[string]any{
					"name":      "loomhelm.create_project",
					"arguments": map[string]any{"name": "Loomhelm"},
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
				t.Fatalf("malformed project success = %#v, want unknown outcome", result)
			}
		})
	}
}

func TestServerAcceptsTaskResponseWithEmptyGoal(t *testing.T) {
	body := []byte(`{"task":{"id":"task-1","project_id":"project-1","title":"Task","goal":"","status":"todo","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}}`)
	if !validToolResponse("createTask", body) {
		t.Fatal("valid task response with an empty goal was rejected")
	}
}

func TestServerReportsOversizedReadResponseAsServiceFailure(t *testing.T) {
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			_, _ = writer.Write(bytes.Repeat([]byte("x"), 2200))
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	response := callMCP(t, server, map[string]any{
		"jsonrpc": "2.0",
		"id":      17,
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
				Code protocol.ErrorCode `json:"code"`
			} `json:"error"`
		} `json:"structuredContent"`
		IsError bool `json:"isError"`
	}
	decodeResult(t, response, &result)
	if !result.IsError || result.StructuredContent.HTTPStatus != http.StatusServiceUnavailable || result.StructuredContent.Error.Code == protocol.ErrorCodeUnknownResult {
		t.Fatalf("oversized read response = %#v, want ordinary service failure", result)
	}
}

func TestServerRejectsResponseLimitTooSmallForErrorEnvelope(t *testing.T) {
	if _, err := NewServer(Config{RESTHandler: http.NotFoundHandler(), MaxResponseBytes: minimumMaxResponseBytes - 1}); err == nil {
		t.Fatal("NewServer() succeeded with a response limit smaller than the error envelope")
	}
}

func TestConcurrentMCPRequestSlotsBoundBufferedMemory(t *testing.T) {
	if got, want := concurrentMCPRequestSlots(1<<20, 4<<20), 1; got != want {
		t.Fatalf("default concurrent MCP request slots = %d, want %d", got, want)
	}
	if got, want := concurrentMCPRequestSlots(32<<20, 32<<20), 1; got != want {
		t.Fatalf("large concurrent MCP request slots = %d, want %d", got, want)
	}
	if got, want := concurrentMCPRequestSlots(1, 1), maxConcurrentMCPRequests; got != want {
		t.Fatalf("small concurrent MCP request slots = %d, want cap %d", got, want)
	}
}

func TestRequestBodyReadTimeoutClosesBody(t *testing.T) {
	body := &blockingRequestBody{closed: make(chan struct{})}
	_, err := readRequestBody(context.Background(), body, 1024, 10*time.Millisecond)
	if !errors.Is(err, errRequestBodyReadTimeout) {
		t.Fatalf("readRequestBody() error = %v, want timeout", err)
	}
	select {
	case <-body.closed:
	case <-time.After(time.Second):
		t.Fatal("request body was not closed after read timeout")
	}
}

func TestRequestBodyReadTimeoutDoesNotWaitForBlockingClose(t *testing.T) {
	body := &blockingCloseRequestBody{release: make(chan struct{}), closed: make(chan struct{})}
	started := time.Now()
	_, err := readRequestBody(context.Background(), body, 1024, 10*time.Millisecond)
	if !errors.Is(err, errRequestBodyReadTimeout) {
		t.Fatalf("readRequestBody() error = %v, want timeout", err)
	}
	if elapsed := time.Since(started); elapsed > requestBodyCloseWait+500*time.Millisecond {
		t.Fatalf("readRequestBody() waited %s for a blocking Close, want bounded return", elapsed)
	}
	close(body.release)
	close(body.closed)
}

func TestRequestBodyCloseAfterCappedReadCompletesBeforeHandlerReturn(t *testing.T) {
	body := &cappedBlockingCloseRequestBody{
		data:     bytes.Repeat([]byte("x"), 5),
		release:  make(chan struct{}),
		started:  make(chan struct{}),
		finished: make(chan struct{}),
	}
	handler := &requestIDLimitHandler{
		next: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.WriteHeader(http.StatusNoContent)
		}),
		maxBody: 4,
		maxID:   256,
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp", body)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	started := time.Now()
	go func() {
		handler.ServeHTTP(recorder, request)
		close(done)
	}()
	releaseDelay := 300 * time.Millisecond
	go func() {
		time.Sleep(releaseDelay)
		close(body.release)
	}()

	select {
	case <-done:
		if elapsed := time.Since(started); elapsed < releaseDelay/2 {
			t.Fatalf("capped-read handler returned after %s before the original body Close completed", elapsed)
		}
	case <-time.After(time.Second):
		t.Fatal("capped-read handler did not return after the original body Close completed")
	}
	select {
	case <-body.started:
	default:
		t.Fatal("capped-read handler did not close the original request body")
	}
	select {
	case <-body.finished:
	case <-time.After(time.Second):
		t.Fatal("blocking request body Close did not finish after release")
	}
}

func TestRequestConcurrencyWaitTimeoutReturnsRetryableAdmissionError(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	handler := &requestConcurrencyHandler{
		next: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("request entered a full concurrency gate")
		}),
		slots: slots,
		wait:  10 * time.Millisecond,
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("X-Loomhelm-MCP-Response") != "concurrency_limited" {
		t.Fatalf("concurrency admission status=%d marker=%q, want 503/concurrency_limited", recorder.Code, recorder.Header().Get("X-Loomhelm-MCP-Response"))
	}
}

type blockingRequestBody struct {
	closed chan struct{}
	once   sync.Once
}

type blockingCloseRequestBody struct {
	release chan struct{}
	closed  chan struct{}
}

type cappedBlockingCloseRequestBody struct {
	data     []byte
	release  chan struct{}
	started  chan struct{}
	finished chan struct{}
	once     sync.Once
}

func (b *blockingCloseRequestBody) Read([]byte) (int, error) {
	<-b.closed
	return 0, io.EOF
}

func (b *blockingCloseRequestBody) Close() error {
	<-b.release
	return nil
}

func (b *cappedBlockingCloseRequestBody) Read(data []byte) (int, error) {
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	n := copy(data, b.data)
	b.data = b.data[n:]
	return n, nil
}

func (b *cappedBlockingCloseRequestBody) Close() error {
	b.once.Do(func() { close(b.started) })
	<-b.release
	close(b.finished)
	return nil
}

func (b *blockingRequestBody) Read([]byte) (int, error) {
	<-b.closed
	return 0, io.EOF
}

func (b *blockingRequestBody) Close() error {
	b.once.Do(func() { close(b.closed) })
	return nil
}

func TestServerBoundsEncodedToolResult(t *testing.T) {
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			_ = json.NewEncoder(writer).Encode(map[string]string{
				"value": string(bytes.Repeat([]byte("x"), 600)),
			})
		}),
		MaxResponseBytes: 2048,
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
		MaxResponseBytes: 2048,
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
	if len(recorder.Body.Bytes()) > 2048 {
		t.Fatalf("oversized wire response body = %d bytes, want at most 2048", recorder.Body.Len())
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "too_large" {
		t.Fatalf("oversized wire response marker = %q, want too_large", got)
	}
}

func TestServerPreservesUnknownOutcomeForBoundedLegacyBatch(t *testing.T) {
	var calls atomic.Int32
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls.Add(1)
			writer.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(writer).Encode(protocol.ApiError{
				Message:   "credential transaction failed",
				RequestID: strings.Repeat("r", 10000),
			})
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	longID := strings.Repeat("x", 240)
	body := mustJSON(t, []map[string]any{
		{
			"jsonrpc": "2.0",
			"id":      longID,
			"method":  "tools/call",
			"params": map[string]any{
				"name":      "loomhelm.create_user_credential",
				"arguments": map[string]any{"name": "first"},
			},
		},
		{
			"jsonrpc": "2.0",
			"id":      longID + "y",
			"method":  "tools/call",
			"params": map[string]any{
				"name":      "loomhelm.create_user_credential",
				"arguments": map[string]any{"name": "second"},
			},
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", OlderProtocolVersion)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("legacy batch status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() > 2048 {
		t.Fatalf("legacy batch response body = %d bytes, want at most 2048", recorder.Body.Len())
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(string(protocol.ErrorCodeUnknownResult))) {
		t.Fatalf("legacy batch response = %s, want unknown_result", recorder.Body.String())
	}
	if calls.Load() != 2 {
		t.Fatalf("legacy batch REST invocation count = %d, want 2", calls.Load())
	}
}

func TestServerPreservesUnknownOutcomeWhenBoundedBatchResponseOverflows(t *testing.T) {
	var calls atomic.Int32
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls.Add(1)
			writer.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(writer).Encode(protocol.ApiError{Message: "credential transaction failed"})
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	body := mustJSON(t, []map[string]any{
		{"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
		{
			"jsonrpc": "2.0",
			"id":      2,
			"method":  "tools/call",
			"params": map[string]any{
				"name":      "loomhelm.create_user_credential",
				"arguments": map[string]any{"name": "first"},
			},
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", OlderProtocolVersion)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("overflowed legacy batch status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() > 2048 {
		t.Fatalf("overflowed legacy batch response body = %d bytes, want at most 2048", recorder.Body.Len())
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "too_large_fallback" {
		t.Fatalf("overflowed legacy batch marker = %q, want too_large_fallback", got)
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(string(protocol.ErrorCodeUnknownResult))) {
		t.Fatalf("overflowed legacy batch response = %s, want unknown_result", recorder.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("overflowed legacy batch REST invocation count = %d, want 1", calls.Load())
	}
}

func TestServerDoesNotMarkRejectedMutationUnknownInOverflowFallback(t *testing.T) {
	var calls atomic.Int32
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls.Add(1)
			writer.WriteHeader(http.StatusInternalServerError)
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	body := mustJSON(t, []map[string]any{
		{"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
		{
			"jsonrpc": "2.0",
			"id":      4,
			"method":  "tools/call",
			"params": map[string]any{
				"name":      "loomhelm.create_user_credential",
				"arguments": map[string]any{},
			},
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", OlderProtocolVersion)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("X-Loomhelm-MCP-Response") != "too_large_fallback" {
		t.Fatalf("rejected mutation fallback status=%d marker=%q, want 200/too_large_fallback", recorder.Code, recorder.Header().Get("X-Loomhelm-MCP-Response"))
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(strconv.Itoa(jsonrpc.CodeInvalidParams))) {
		t.Fatalf("rejected mutation fallback response = %s, want invalid-params", recorder.Body.String())
	}
	if bytes.Contains(recorder.Body.Bytes(), []byte(string(protocol.ErrorCodeUnknownResult))) {
		t.Fatalf("rejected mutation fallback response = %s, must not claim unknown_result", recorder.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatalf("rejected mutation REST invocation count = %d, want zero", calls.Load())
	}
}

func TestServerDoesNotMarkTypeInvalidMutationUnknownInOverflowFallback(t *testing.T) {
	var calls atomic.Int32
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls.Add(1)
			writer.WriteHeader(http.StatusInternalServerError)
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	body := mustJSON(t, []map[string]any{
		{"jsonrpc": "2.0", "id": 5, "method": "tools/list"},
		{
			"jsonrpc": "2.0",
			"id":      6,
			"method":  "tools/call",
			"params": map[string]any{
				"name": "loomhelm.create_project",
				"arguments": map[string]any{
					"name": 17,
				},
			},
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", OlderProtocolVersion)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("X-Loomhelm-MCP-Response") != "too_large_fallback" {
		t.Fatalf("type-invalid mutation fallback status=%d marker=%q, want 200/too_large_fallback", recorder.Code, recorder.Header().Get("X-Loomhelm-MCP-Response"))
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(strconv.Itoa(jsonrpc.CodeInvalidParams))) {
		t.Fatalf("type-invalid mutation fallback response = %s, want invalid-params", recorder.Body.String())
	}
	if bytes.Contains(recorder.Body.Bytes(), []byte(string(protocol.ErrorCodeUnknownResult))) {
		t.Fatalf("type-invalid mutation fallback response = %s, must not claim unknown_result", recorder.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatalf("type-invalid mutation REST invocation count = %d, want zero", calls.Load())
	}
}

func TestServerRejectsOversizedBatchBeforeMutation(t *testing.T) {
	calls := 0
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls++
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}
	body := mustJSON(t, []map[string]any{
		{"jsonrpc": "2.0", "id": 20, "method": "ping"},
		{"jsonrpc": "2.0", "id": 21, "method": "ping"},
		{"jsonrpc": "2.0", "id": 22, "method": "ping"},
	})
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", OlderProtocolVersion)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge || recorder.Header().Get("X-Loomhelm-MCP-Response") != "batch_too_large" {
		t.Fatalf("oversized batch status=%d marker=%q, want 413/batch_too_large", recorder.Code, recorder.Header().Get("X-Loomhelm-MCP-Response"))
	}
	if calls != 0 {
		t.Fatalf("oversized batch REST invocation count = %d, want zero", calls)
	}
}

func TestServerRejectsOversizedRequestIDBeforeMutation(t *testing.T) {
	calls := 0
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls++
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	body := []byte(`{"jsonrpc":"2.0","id":"`)
	body = append(body, bytes.Repeat([]byte("x"), 300)...)
	body = append(body, []byte(`","method":"tools/call","params":{"name":"loomhelm.create_project","arguments":{"name":"Loomhelm"}}}`)...)
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request ID status = %d, want %d", recorder.Code, http.StatusRequestEntityTooLarge)
	}
	if recorder.Body.Len() > 2048 {
		t.Fatalf("oversized request ID response body = %d bytes, want at most 2048", recorder.Body.Len())
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "request_id_too_large" {
		t.Fatalf("oversized request ID marker = %q, want request_id_too_large", got)
	}
	if calls != 0 {
		t.Fatalf("REST invocation count = %d, want zero", calls)
	}
}

func TestServerRejectsEscapedRequestIDBeforeMutation(t *testing.T) {
	calls := 0
	server, err := NewServer(Config{
		RESTHandler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			calls++
		}),
		MaxResponseBytes: 2048,
	})
	if err != nil {
		t.Fatalf("NewServer() error = %v", err)
	}

	// The raw UTF-8 token is within the 256-byte request-ID bound, but the
	// official JSON encoder expands each U+2028 to six ASCII bytes on output.
	id := strings.Repeat("\u2028", 84)
	body := append([]byte(`{"jsonrpc":"2.0","id":"`), []byte(id)...)
	body = append(body, []byte(`","method":"tools/call","params":{"name":"loomhelm.create_project","arguments":{"name":"Loomhelm"}}}`)...)
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("escaped request ID status = %d, want %d", recorder.Code, http.StatusRequestEntityTooLarge)
	}
	if got := recorder.Header().Get("X-Loomhelm-MCP-Response"); got != "request_id_too_large" {
		t.Fatalf("escaped request ID marker = %q, want request_id_too_large", got)
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
