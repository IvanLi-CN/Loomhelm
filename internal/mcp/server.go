// Package mcp exposes Loomhelm's authenticated application through the Model
// Context Protocol. The adapter delegates every business operation to the
// existing REST application handler so that authorization, idempotency,
// persistence and failure semantics cannot drift between public entry points.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	// ProtocolVersion is the phase-one MCP protocol revision used by the
	// repository contract and supported by the official Go SDK.
	ProtocolVersion = "2025-11-25"

	// LegacyProtocolVersion is retained for clients that have not yet upgraded
	// from the previous stable protocol revision.
	LegacyProtocolVersion = "2025-06-18"

	// OlderProtocolVersion is retained for older stateless HTTP clients.
	OlderProtocolVersion = "2025-03-26"

	defaultMaxBodyBytes           int64 = 1 << 20
	defaultMaxResponseBytes       int64 = 4 << 20
	minimumMaxResponseBytes       int64 = 2048
	maxConcurrentMCPBytes         int64 = 32 << 20
	maxConcurrentMCPRequests            = 64
	maxMCPBatchRequests                 = 2
	defaultMCPAdmissionWait             = 5 * time.Second
	defaultRequestBodyReadTimeout       = 15 * time.Second
	defaultMCPOperationTimeout          = 25 * time.Second
	requestBodyCloseWait                = 100 * time.Millisecond
	maxToolErrorMessageBytes            = 160
	maxToolErrorRequestIDBytes          = 64
)

var (
	errRESTHandlerRequired = errors.New("MCP REST application handler is required")
	errResponseTooLarge    = errors.New("MCP application response is too large")

	// These operations have a durable mutation result whose envelope is needed
	// to distinguish a confirmed response from a malformed or ambiguous one.
	// Empty-response mutations intentionally remain outside this map.
	mutationResponseFields = map[string]string{
		"createUserCredential": "credential",
		"createProject":        "project",
		"updateProject":        "project",
		"grantProjectMember":   "member",
		"createTask":           "task",
		"updateTask":           "task",
		"createSession":        "session",
		"bindSessionTask":      "session",
		"submitRun":            "ack",
		"updateDraft":          "draft",
		"resolveApproval":      "ack",
		"interruptRun":         "ack",
	}
	mutationResponseRequiredFields = map[string][]string{
		"createUserCredential": {"id", "name", "project_ids", "created_at", "token"},
		"createProject":        {"id", "name", "created_at", "updated_at"},
		"updateProject":        {"id", "name", "created_at", "updated_at"},
		"grantProjectMember":   {"project_id", "user_id", "role", "created_at"},
		"createTask":           {"id", "project_id", "title", "goal", "status", "created_at", "updated_at"},
		"updateTask":           {"id", "project_id", "title", "goal", "status", "created_at", "updated_at"},
		"createSession":        {"id", "path", "state", "external_thread_ref", "created_at", "updated_at"},
		"bindSessionTask":      {"id", "path", "state", "external_thread_ref", "created_at", "updated_at"},
		"submitRun":            {"command_id", "state", "received_at", "deduplicated"},
		"updateDraft":          {"session_id", "content", "revision", "updated_at"},
		"resolveApproval":      {"command_id", "state", "received_at", "deduplicated"},
		"interruptRun":         {"command_id", "state", "received_at", "deduplicated"},
	}
)

// Tool and ResourceTemplate are aliases to the official SDK's discovery types.
// Keeping the aliases in this package lets the application expose a stable
// Loomhelm-facing constructor without leaking an implementation-specific copy
// of the MCP wire model.
type Tool = sdk.Tool
type ResourceTemplate = sdk.ResourceTemplate

// Config controls the protocol adapter. RESTHandler must be the same relative
// /api/v1 application handler used by the HTTP server. RESTPathPrefix is only
// needed when the supplied handler expects the public prefix itself.
type Config struct {
	RESTHandler    http.Handler
	RESTPathPrefix string
	ServerName     string
	ServerVersion  string

	// ProtocolVersions narrows the official SDK's supported protocol versions.
	// An empty value uses the SDK's current supported list. The SDK propagates
	// HTTP disconnect cancellation only for protocol versions from 2026-07-28
	// onward; older stateless protocol sessions may continue after disconnect,
	// so callers must apply each operation's retry rule and must not blindly
	// retry non-idempotent operations such as credential creation.
	ProtocolVersions []string

	// AllowedOrigins is an exact allowlist. An absent Origin header is accepted;
	// a present Origin is rejected unless it is listed here. Wildcards are not
	// accepted because this endpoint may control real execution.
	AllowedOrigins []string

	MaxBodyBytes int64
	// MaxResponseBytes must leave room for the structured unknown-result error
	// envelope; values below minimumMaxResponseBytes are rejected.
	MaxResponseBytes int64
	// OperationTimeout bounds one REST delegation, including a host command
	// acknowledgement wait. A mutation that reaches this deadline is reported
	// as an unknown outcome by the existing application contract.
	OperationTimeout time.Duration
}

// Server is an MCP endpoint backed by the official Go SDK's stateless
// Streamable HTTP transport.
type Server struct {
	sdkServer        *sdk.Server
	handler          http.Handler
	restHandler      http.Handler
	restPathPrefix   string
	maxResponse      int64
	operationTimeout time.Duration
	tools            []Tool
	resources        []resourceSpec
	toolByName       map[string]toolSpec
}

// NewServer validates the MCP route catalog, registers all contract tools and
// resources with the official SDK, and returns a handler ready for mounting.
func NewServer(config Config) (*Server, error) {
	if config.RESTHandler == nil {
		return nil, errRESTHandlerRequired
	}
	protocols, err := normalizeProtocols(config.ProtocolVersions)
	if err != nil {
		return nil, err
	}
	for _, version := range protocols {
		if !containsString(sdk.SupportedProtocolVersions(), version) {
			return nil, fmt.Errorf("MCP protocol version %q is not supported by the official Go SDK", version)
		}
	}
	origins := make(map[string]struct{}, len(config.AllowedOrigins))
	for _, origin := range config.AllowedOrigins {
		origin = strings.TrimSpace(origin)
		if origin == "" || origin == "*" {
			return nil, fmt.Errorf("MCP allowed origin must be an exact non-wildcard origin")
		}
		origins[origin] = struct{}{}
	}
	if config.ServerName == "" {
		config.ServerName = "loomhelm"
	}
	if config.ServerVersion == "" {
		config.ServerVersion = "dev"
	}
	if config.MaxBodyBytes == 0 {
		config.MaxBodyBytes = defaultMaxBodyBytes
	}
	if config.MaxResponseBytes == 0 {
		config.MaxResponseBytes = defaultMaxResponseBytes
	}
	if config.OperationTimeout == 0 {
		config.OperationTimeout = defaultMCPOperationTimeout
	}
	if config.MaxBodyBytes < 1 || config.MaxResponseBytes < 1 {
		return nil, fmt.Errorf("MCP body and response limits must be positive")
	}
	if config.MaxResponseBytes < minimumMaxResponseBytes {
		return nil, fmt.Errorf("MCP response limit must be at least %d bytes", minimumMaxResponseBytes)
	}
	if config.OperationTimeout < 1 {
		return nil, fmt.Errorf("MCP operation timeout must be positive")
	}

	sdkServer := sdk.NewServer(
		&sdk.Implementation{Name: config.ServerName, Version: config.ServerVersion},
		&sdk.ServerOptions{
			// The catalog is immutable after construction and this endpoint does
			// not implement long-lived list-change subscriptions. Explicitly keep
			// those flags false so the SDK does not advertise a stream that the
			// bounded JSON response transport cannot safely buffer.
			Capabilities: &sdk.ServerCapabilities{
				Tools:     &sdk.ToolCapabilities{},
				Resources: &sdk.ResourceCapabilities{},
			},
			SupportedProtocolVersions: protocols,
		},
	)
	server := &Server{
		sdkServer:        sdkServer,
		restHandler:      config.RESTHandler,
		restPathPrefix:   strings.TrimRight(config.RESTPathPrefix, "/"),
		maxResponse:      config.MaxResponseBytes,
		operationTimeout: config.OperationTimeout,
		toolByName:       make(map[string]toolSpec, len(protocol.MCPTools)),
	}

	for _, definition := range protocol.MCPTools {
		spec, ok := toolSpecFor(definition.OperationID)
		if !ok {
			return nil, fmt.Errorf("MCP operation %q has no adapter route", definition.OperationID)
		}
		if _, exists := server.toolByName[definition.Name]; exists {
			return nil, fmt.Errorf("duplicate MCP tool %q", definition.Name)
		}
		spec.name = definition.Name
		spec.description = definition.Description
		server.toolByName[definition.Name] = spec
		tool := &sdk.Tool{
			Name:        definition.Name,
			Description: definition.Description,
			InputSchema: json.RawMessage(spec.inputSchema),
		}
		sdkServer.AddTool(tool, server.toolHandler(definition.Name))
		server.tools = append(server.tools, *tool)
	}

	for _, definition := range protocol.MCPResources {
		spec, ok := resourceSpecFor(definition)
		if !ok {
			return nil, fmt.Errorf("MCP resource %q has no adapter route", definition.Name)
		}
		server.resources = append(server.resources, spec)
		sdkServer.AddResourceTemplate(&spec.template, server.resourceHandler)
	}

	transport := sdk.NewStreamableHTTPHandler(
		func(*http.Request) *sdk.Server { return sdkServer },
		&sdk.StreamableHTTPOptions{
			Stateless:                    true,
			JSONResponse:                 true,
			MaxRequestBodyBytes:          config.MaxBodyBytes,
			PropagateRequestCancellation: true,
		},
	)
	responseLimiter := &responseLimitHandler{
		next:     transport,
		max:      config.MaxResponseBytes,
		fallback: server.oversizedBatchResponse,
	}
	server.handler = &noStoreHandler{next: &originHandler{
		next: &requestConcurrencyHandler{
			next: &requestIDLimitHandler{
				next:    responseLimiter,
				maxBody: config.MaxBodyBytes,
				maxID:   config.MaxResponseBytes / 8,
			},
			slots:   make(chan struct{}, concurrentMCPRequestSlots(config.MaxBodyBytes, config.MaxResponseBytes)),
			waiters: make(chan struct{}, maxConcurrentMCPRequests),
			wait:    defaultMCPAdmissionWait,
		},
		allowed:     origins,
		crossOrigin: http.NewCrossOriginProtection(),
	}}
	return server, nil
}

// NewHandler is a convenience alias for callers that only need an
// http.Handler value.
func NewHandler(config Config) (http.Handler, error) {
	return NewServer(config)
}

// ServeHTTP delegates transport, lifecycle, discovery and JSON-RPC handling to
// the official SDK.
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if s == nil || s.handler == nil {
		http.Error(writer, "MCP server is unavailable", http.StatusServiceUnavailable)
		return
	}
	s.handler.ServeHTTP(writer, request)
}

// Tools returns a copy of the registered tool catalog.
func (s *Server) Tools() []Tool {
	if s == nil {
		return nil
	}
	result := make([]Tool, len(s.tools))
	copy(result, s.tools)
	for index := range result {
		if schema, ok := result[index].InputSchema.(json.RawMessage); ok {
			result[index].InputSchema = append(json.RawMessage(nil), schema...)
		}
	}
	return result
}

// ResourceTemplates returns a copy of the registered resource template
// catalog.
func (s *Server) ResourceTemplates() []ResourceTemplate {
	if s == nil {
		return nil
	}
	result := make([]ResourceTemplate, 0, len(s.resources))
	for _, resource := range s.resources {
		result = append(result, resource.template)
	}
	return result
}

func (s *Server) toolHandler(name string) sdk.ToolHandler {
	return func(ctx context.Context, request *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		spec, ok := s.toolByName[name]
		if !ok || request == nil || request.Params == nil {
			return toolError(http.StatusBadRequest, protocol.ApiError{
				Code:    protocol.ErrorCodeInvalidRequest,
				Message: "invalid MCP tool request",
			}), nil
		}
		arguments, err := decodeArguments(request.Params.Arguments, spec)
		if err != nil {
			return toolError(http.StatusBadRequest, protocol.ApiError{
				Code:    protocol.ErrorCodeInvalidRequest,
				Message: err.Error(),
			}), nil
		}
		response, err := s.invokeREST(ctx, requestHeaders(request), spec.route, arguments)
		if err != nil {
			var argumentErr *argumentError
			if errors.As(err, &argumentErr) {
				return toolError(http.StatusBadRequest, protocol.ApiError{
					Code:    protocol.ErrorCodeInvalidRequest,
					Message: argumentErr.Error(),
				}), nil
			}
			if errors.Is(err, errResponseTooLarge) {
				if spec.route.method != http.MethodGet {
					return unknownOutcomeResult(), nil
				}
				return toolError(http.StatusServiceUnavailable, protocol.ApiError{
					Code:    protocol.ErrorCodeInvalidRequest,
					Message: "application service response exceeds configured limit",
				}), nil
			}
			return toolError(http.StatusServiceUnavailable, protocol.ApiError{
				Code:    protocol.ErrorCodeInvalidRequest,
				Message: "application service is unavailable",
			}), nil
		}
		if response.status < http.StatusOK || response.status >= http.StatusMultipleChoices {
			if response.status >= http.StatusInternalServerError && response.status < 600 && spec.route.method != http.MethodGet {
				return unknownOutcomeResult(), nil
			}
			return toolError(response.status, decodeAPIError(response.status, response.body), response.retryAfter), nil
		}
		if !validToolResponse(spec.operationID, response.body) {
			return unknownOutcomeResult(), nil
		}
		result, err := toolSuccess(response.body)
		if spec.operationID == "downloadArtifactContent" {
			result, err = artifactContentToolSuccess(response.body)
		}
		if err != nil {
			if spec.route.method != http.MethodGet {
				return unknownOutcomeResult(), nil
			}
			return toolError(http.StatusServiceUnavailable, protocol.ApiError{
				Code:    protocol.ErrorCodeInvalidRequest,
				Message: "application service returned invalid JSON",
			}), nil
		}
		if !encodedResponseWithinBudget(result, s.maxResponse) {
			if spec.route.method != http.MethodGet {
				return unknownOutcomeResult(), nil
			}
			return toolError(http.StatusServiceUnavailable, protocol.ApiError{
				Code:    protocol.ErrorCodeInvalidRequest,
				Message: "application service response exceeds configured limit",
			}), nil
		}
		return result, nil
	}
}

func validToolResponse(operationID string, body []byte) bool {
	field, required := mutationResponseFields[operationID]
	if !required {
		return true
	}
	requiredFields := mutationResponseRequiredFields[operationID]
	var envelope map[string]json.RawMessage
	if json.Unmarshal(body, &envelope) != nil || envelope == nil {
		return false
	}
	value, ok := envelope[field]
	if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(value, &object) != nil || object == nil {
		return false
	}
	for _, name := range requiredFields {
		value, ok := object[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	switch operationID {
	case "createUserCredential":
		var response protocol.CreateUserCredentialResponse
		return json.Unmarshal(body, &response) == nil && validCreatedCredential(response.Credential)
	case "createProject", "updateProject":
		var response protocol.ProjectResponse
		return json.Unmarshal(body, &response) == nil && validProject(response.Project)
	case "grantProjectMember":
		var response protocol.ProjectMemberResponse
		return json.Unmarshal(body, &response) == nil && validProjectMember(response.Member)
	case "createTask", "updateTask":
		var response protocol.TaskResponse
		return json.Unmarshal(body, &response) == nil && validTask(response.Task)
	case "createSession", "bindSessionTask":
		var response protocol.SessionResponse
		return json.Unmarshal(body, &response) == nil && validSession(response.Session)
	case "submitRun", "resolveApproval", "interruptRun":
		var response protocol.CommandAckResponse
		return json.Unmarshal(body, &response) == nil && validCommandAck(response.Ack)
	case "updateDraft":
		var response protocol.DraftResponse
		return json.Unmarshal(body, &response) == nil && validDraft(response.Draft)
	default:
		return false
	}
}

func validCreatedCredential(value protocol.CreatedUserCredential) bool {
	return value.ID != "" && value.Name != "" && value.CreatedAt != "" && value.ProjectIds != nil && value.Token != ""
}

func validProject(value protocol.Project) bool {
	return value.ID != "" && value.Name != "" && value.CreatedAt != "" && value.UpdatedAt != ""
}

func validProjectMember(value protocol.ProjectMember) bool {
	return value.ProjectID != "" && value.UserID != "" && validProjectMemberRole(value.Role) && value.CreatedAt != ""
}

func validProjectMemberRole(value protocol.ProjectMemberRole) bool {
	switch value {
	case protocol.ProjectMemberRoleViewer, protocol.ProjectMemberRoleOperator, protocol.ProjectMemberRoleOwner:
		return true
	default:
		return false
	}
}

func validTask(value protocol.Task) bool {
	return value.ID != "" && value.ProjectID != "" && value.Title != "" && validTaskStatus(value.Status) && value.CreatedAt != "" && value.UpdatedAt != ""
}

func validTaskStatus(value protocol.TaskStatus) bool {
	switch value {
	case protocol.TaskStatusTodo, protocol.TaskStatusInProgress, protocol.TaskStatusBlocked, protocol.TaskStatusDone, protocol.TaskStatusCancelled:
		return true
	default:
		return false
	}
}

func validSession(value protocol.Session) bool {
	return value.ID != "" && validSessionPath(value.Path) && validSessionState(value.State) && value.ExternalThreadRef != "" && value.CreatedAt != "" && value.UpdatedAt != ""
}

func validSessionPath(value protocol.SessionPath) bool {
	switch value {
	case protocol.SessionPathNew, protocol.SessionPathExistingActive:
		return true
	default:
		return false
	}
}

func validSessionState(value protocol.SessionState) bool {
	switch value {
	case protocol.SessionStateStarting, protocol.SessionStateActive, protocol.SessionStateReconciling, protocol.SessionStateDisconnected, protocol.SessionStateClosed, protocol.SessionStateUnsupported:
		return true
	default:
		return false
	}
}

func validCommandAck(value protocol.CommandAck) bool {
	if value.CommandID == "" || value.ReceivedAt == "" {
		return false
	}
	switch value.State {
	case protocol.CommandStateAccepted, protocol.CommandStateExecuting, protocol.CommandStateSucceeded, protocol.CommandStateFailed, protocol.CommandStateUnknown, protocol.CommandStateRejected:
		return true
	default:
		return false
	}
}

func validDraft(value protocol.Draft) bool {
	return value.SessionID != "" && value.Revision > 0 && value.UpdatedAt != ""
}

func unknownOutcomeResult() *sdk.CallToolResult {
	return toolError(http.StatusConflict, protocol.ApiError{
		Code:    protocol.ErrorCodeUnknownResult,
		Message: "application outcome is unknown; do not blindly retry a non-idempotent operation",
	})
}

func (s *Server) resourceHandler(ctx context.Context, request *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
	if request == nil || request.Params == nil {
		return nil, sdk.ResourceNotFoundError("")
	}
	resource, arguments, ok := matchResourceURI(s.resources, request.Params.URI)
	if !ok {
		return nil, sdk.ResourceNotFoundError(request.Params.URI)
	}
	response, err := s.invokeREST(ctx, requestHeaders(request), resource.route, arguments)
	if err != nil {
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "application service is unavailable"}
	}
	if response.status < http.StatusOK || response.status >= http.StatusMultipleChoices {
		apiError := decodeAPIError(response.status, response.body)
		data, _ := json.Marshal(map[string]any{"http_status": response.status, "error": apiError})
		return nil, &jsonrpc.Error{Code: int64(rpcCodeForHTTP(response.status)), Message: apiError.Message, Data: data}
	}
	body := response.body
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte(`{}`)
	}
	if !json.Valid(body) {
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "application service returned invalid JSON"}
	}
	result := &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{
		URI:      request.Params.URI,
		MIMEType: "application/json",
		Text:     string(body),
	}}}
	if !encodedResponseWithinBudget(result, s.maxResponse) {
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "application resource response exceeds configured limit"}
	}
	return result, nil
}

func requestHeaders(request interface{ GetExtra() *sdk.RequestExtra }) http.Header {
	if request == nil || request.GetExtra() == nil || request.GetExtra().Header == nil {
		return nil
	}
	return request.GetExtra().Header
}

func (s *Server) invokeREST(ctx context.Context, sourceHeaders http.Header, route routeSpec, arguments map[string]json.RawMessage) (restResponse, error) {
	path, err := routePath(route.path, route.pathParams, arguments)
	if err != nil {
		return restResponse{}, &argumentError{err: err}
	}
	query, err := routeQuery(route.queryParams, arguments)
	if err != nil {
		return restResponse{}, &argumentError{err: err}
	}
	if s.restPathPrefix != "" {
		path = s.restPathPrefix + "/" + strings.TrimLeft(path, "/")
	}
	if query != "" {
		path += "?" + query
	}
	payload, err := routeBody(route, arguments)
	if err != nil {
		return restResponse{}, &argumentError{err: err}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	operationCtx, cancel := context.WithTimeout(ctx, s.operationTimeout)
	defer cancel()
	internalRequest, err := http.NewRequestWithContext(operationCtx, route.method, path, bytes.NewReader(payload))
	if err != nil {
		return restResponse{}, err
	}
	for _, headerName := range []string{"Authorization", "Cookie", "X-Loomhelm-Expected-Principal", "X-Request-ID"} {
		for _, value := range sourceHeaders.Values(headerName) {
			internalRequest.Header.Add(headerName, value)
		}
	}
	internalRequest.Header.Set("Accept", "application/json")
	if len(payload) != 0 {
		internalRequest.Header.Set("Content-Type", "application/json")
	}
	internalRequest.RemoteAddr = "127.0.0.1:0"
	internalRequest.Host = "loomhelm.internal"
	response := &responseRecorder{header: make(http.Header), body: bytes.NewBuffer(nil), status: http.StatusOK, maxBytes: s.maxResponse}
	s.restHandler.ServeHTTP(response, internalRequest)
	if response.tooLarge || int64(response.body.Len()) > s.maxResponse {
		return restResponse{}, errResponseTooLarge
	}
	return restResponse{status: response.status, body: response.body.Bytes(), retryAfter: response.Header().Get("Retry-After")}, nil
}

type restResponse struct {
	status     int
	body       []byte
	retryAfter string
}

type argumentError struct {
	err error
}

func (e *argumentError) Error() string { return e.err.Error() }

func (e *argumentError) Unwrap() error { return e.err }

type responseRecorder struct {
	header      http.Header
	body        *bytes.Buffer
	status      int
	wroteHeader bool
	tooLarge    bool
	maxBytes    int64
}

func (r *responseRecorder) Header() http.Header { return r.header }

func (r *responseRecorder) WriteHeader(status int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = status
}

func (r *responseRecorder) Write(data []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	if r.maxBytes > 0 && int64(r.body.Len())+int64(len(data)) > r.maxBytes {
		r.tooLarge = true
		return 0, errResponseTooLarge
	}
	return r.body.Write(data)
}

func toolSuccess(body []byte) (*sdk.CallToolResult, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte(`{}`)
	}
	if !json.Valid(body) {
		return nil, errors.New("application service returned invalid JSON")
	}
	return &sdk.CallToolResult{
		Content:           []sdk.Content{&sdk.TextContent{Text: string(body)}},
		StructuredContent: json.RawMessage(body),
	}, nil
}

func artifactContentToolSuccess(body []byte) (*sdk.CallToolResult, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte(`{}`)
	}
	if !json.Valid(body) {
		return nil, errors.New("application service returned invalid JSON")
	}
	// The chunk is carried once in structuredContent. Duplicating a potentially
	// large base64 field in human-readable text would halve the usable MCP
	// transfer budget without adding information.
	return &sdk.CallToolResult{
		Content:           []sdk.Content{&sdk.TextContent{Text: "artifact content chunk retrieved"}},
		StructuredContent: json.RawMessage(body),
	}, nil
}

func encodedResponseWithinBudget(value any, maxResponse int64) bool {
	if maxResponse < 4 {
		return false
	}
	data, err := json.Marshal(value)
	return err == nil && int64(len(data)) <= maxResponse/4
}

func toolError(status int, apiError protocol.ApiError, retryAfter ...string) *sdk.CallToolResult {
	if apiError.Code == "" {
		apiError.Code = errorCodeForHTTP(status)
	}
	if apiError.Message == "" {
		apiError.Message = messageForHTTP(status)
	}
	apiError.Details = nil
	apiError.Message = truncateUTF8(apiError.Message, maxToolErrorMessageBytes)
	apiError.RequestID = truncateUTF8(apiError.RequestID, maxToolErrorRequestIDBytes)
	envelope := map[string]any{"http_status": status, "error": apiError}
	if len(retryAfter) > 0 && retryAfter[0] != "" {
		envelope["retry_after"] = retryAfter[0]
	}
	data, _ := json.Marshal(envelope)
	contentText := string(apiError.Code)
	if contentText == "" {
		contentText = "request failed"
	}
	return &sdk.CallToolResult{
		// Keep human-readable content compact. The structured envelope carries
		// the bounded diagnostic details; duplicating it here can exhaust the
		// final wire-response budget for a legacy batch.
		Content:           []sdk.Content{&sdk.TextContent{Text: contentText}},
		StructuredContent: json.RawMessage(data),
		IsError:           true,
	}
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	value = value[:maxBytes]
	for len(value) > 0 && !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func normalizeProtocols(values []string) ([]string, error) {
	if len(values) == 0 {
		return sdk.SupportedProtocolVersions(), nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil, errors.New("MCP protocol versions must not be empty")
		}
		if _, ok := seen[value]; ok {
			return nil, fmt.Errorf("duplicate MCP protocol version %q", value)
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type originHandler struct {
	next        http.Handler
	allowed     map[string]struct{}
	crossOrigin *http.CrossOriginProtection
}

func (h *originHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if origin := request.Header.Get("Origin"); origin != "" {
		if _, ok := h.allowed[origin]; !ok {
			CloseRejectedRequestBody(writer, request)
			http.Error(writer, "MCP request origin is not allowed", http.StatusForbidden)
			return
		}
	} else if h.crossOrigin != nil {
		if err := h.crossOrigin.Check(request); err != nil {
			CloseRejectedRequestBody(writer, request)
			http.Error(writer, err.Error(), http.StatusForbidden)
			return
		}
	}
	h.next.ServeHTTP(writer, request)
}

type noStoreHandler struct {
	next http.Handler
}

func (h *noStoreHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	h.next.ServeHTTP(&noStoreResponseWriter{ResponseWriter: writer}, request)
}

type noStoreResponseWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *noStoreResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.Header().Set("Cache-Control", "no-store")
	w.ResponseWriter.WriteHeader(status)
}

func (w *noStoreResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func (w *noStoreResponseWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *noStoreResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

type responseLimitHandler struct {
	next     http.Handler
	max      int64
	fallback func(*http.Request) ([]byte, bool)
}

type requestBodyContextKey struct{}

type oversizedRPCRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type oversizedRPCResponse struct {
	JSONRPC string             `json:"jsonrpc"`
	ID      json.RawMessage    `json:"id"`
	Result  any                `json:"result,omitempty"`
	Error   *oversizedRPCError `json:"error,omitempty"`
}

type oversizedRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) oversizedBatchResponse(request *http.Request) ([]byte, bool) {
	if request == nil {
		return nil, false
	}
	body, ok := request.Context().Value(requestBodyContextKey{}).([]byte)
	if !ok || len(body) == 0 {
		return nil, false
	}
	var batch []json.RawMessage
	if err := json.Unmarshal(body, &batch); err != nil || len(batch) < 2 {
		return nil, false
	}

	responses := make([]json.RawMessage, 0, len(batch))
	for _, item := range batch {
		var rpcRequest oversizedRPCRequest
		if err := json.Unmarshal(item, &rpcRequest); err != nil {
			return nil, false
		}
		if len(rpcRequest.ID) == 0 {
			continue
		}
		encodedID, ok := encodedJSONValue(rpcRequest.ID)
		if !ok {
			return nil, false
		}

		response := oversizedRPCResponse{JSONRPC: "2.0", ID: encodedID}
		if rpcRequest.Method == "tools/call" {
			var params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if json.Unmarshal(rpcRequest.Params, &params) == nil {
				if spec, exists := s.toolByName[params.Name]; exists && spec.route.method != http.MethodGet {
					arguments, err := decodeArguments(params.Arguments, spec)
					if err == nil {
						_, err = routePath(spec.route.path, spec.route.pathParams, arguments)
					}
					if err == nil {
						_, err = routeQuery(spec.route.queryParams, arguments)
					}
					if err == nil {
						_, err = routeBody(spec.route, arguments)
					}
					if err == nil {
						response.Result = unknownOutcomeResult()
					} else {
						response.Error = &oversizedRPCError{
							Code:    jsonrpc.CodeInvalidParams,
							Message: "invalid MCP tool arguments",
						}
					}
				}
			}
		}
		if response.Result == nil && response.Error == nil {
			response.Error = &oversizedRPCError{
				Code:    jsonrpc.CodeInternalError,
				Message: "MCP response exceeds configured limit",
			}
		}
		encoded, err := json.Marshal(response)
		if err != nil {
			return nil, false
		}
		responses = append(responses, encoded)
	}
	if len(responses) == 0 {
		return nil, false
	}
	encoded, err := json.Marshal(responses)
	if err != nil || int64(len(encoded)) > s.maxResponse {
		return nil, false
	}
	return encoded, true
}

func (h *responseLimitHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	buffer := &responseBuffer{
		header:   make(http.Header),
		body:     bytes.NewBuffer(nil),
		status:   http.StatusOK,
		maxBytes: h.max,
	}
	h.next.ServeHTTP(buffer, request)
	if buffer.tooLarge || int64(buffer.body.Len()) > h.max {
		if h.fallback != nil {
			if body, ok := h.fallback(request); ok {
				writer.Header().Set("X-Loomhelm-MCP-Response", "too_large_fallback")
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusOK)
				_, _ = writer.Write(body)
				return
			}
		}
		writer.Header().Set("X-Loomhelm-MCP-Response", "too_large")
		writer.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	copyHeader(writer.Header(), buffer.header)
	writer.WriteHeader(buffer.status)
	_, _ = writer.Write(buffer.body.Bytes())
}

type responseBuffer struct {
	header      http.Header
	body        *bytes.Buffer
	status      int
	wroteHeader bool
	tooLarge    bool
	maxBytes    int64
}

func (r *responseBuffer) Header() http.Header { return r.header }

func (r *responseBuffer) WriteHeader(status int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = status
}

func (r *responseBuffer) Write(data []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	if r.maxBytes > 0 && int64(r.body.Len())+int64(len(data)) > r.maxBytes {
		r.tooLarge = true
		return 0, errResponseTooLarge
	}
	return r.body.Write(data)
}

func (r *responseBuffer) Flush() {}

func copyHeader(destination, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func concurrentMCPRequestSlots(maxBody, maxResponse int64) int {
	// A legacy batch may execute two tool calls concurrently. Reserve for the
	// request body, both per-call REST buffers, SDK result copies, and JSON
	// encoding overhead before admitting another HTTP request.
	if maxBody > 1<<59 || maxResponse > 1<<58 {
		return 1
	}
	perRequest := maxBody*4 + maxResponse*8
	if perRequest < 1 {
		return 1
	}
	slots := int(maxConcurrentMCPBytes / perRequest)
	if slots < 1 {
		slots = 1
	}
	if slots > maxConcurrentMCPRequests {
		slots = maxConcurrentMCPRequests
	}
	return slots
}

type requestConcurrencyHandler struct {
	next    http.Handler
	slots   chan struct{}
	waiters chan struct{}
	wait    time.Duration
}

func (h *requestConcurrencyHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if h.slots == nil {
		h.next.ServeHTTP(writer, request)
		return
	}
	if h.waiters != nil {
		select {
		case h.waiters <- struct{}{}:
			defer func() { <-h.waiters }()
		default:
			rejectMCPAdmissionRequest(writer, request, "concurrency_queue_full")
			return
		}
	}
	wait := h.wait
	if wait <= 0 {
		wait = defaultMCPAdmissionWait
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
		h.next.ServeHTTP(writer, request)
	case <-request.Context().Done():
		rejectMCPAdmissionRequest(writer, request, "")
	case <-timer.C:
		rejectMCPAdmissionRequest(writer, request, "concurrency_limited")
	}
}

func rejectMCPAdmissionRequest(writer http.ResponseWriter, request *http.Request, marker string) {
	CloseRejectedRequestBody(writer, request)
	if marker == "" || request == nil || request.Context().Err() != nil {
		return
	}
	writer.Header().Set("X-Loomhelm-MCP-Response", marker)
	writer.Header().Set("Retry-After", "1")
	writer.WriteHeader(http.StatusServiceUnavailable)
}

// CloseRejectedRequestBody bounds the body cleanup needed when an MCP request
// is rejected before the adapter can read it. Keeping the read deadline active
// when Close blocks lets net/http finish the request without an unbounded body
// drain on a rejected HTTP/1.1 connection.
func CloseRejectedRequestBody(writer http.ResponseWriter, request *http.Request) {
	if request == nil || request.Body == nil {
		return
	}
	clearReadDeadline := setRequestBodyReadDeadline(writer, requestBodyCloseWait)
	if closeRequestBodyWithin(request.Body, requestBodyCloseWait) {
		clearReadDeadline()
	}
}

type requestIDLimitHandler struct {
	next    http.Handler
	maxBody int64
	maxID   int64
}

func (h *requestIDLimitHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Body == nil || h.maxBody < 1 || h.maxID < 1 {
		h.next.ServeHTTP(writer, request)
		return
	}
	clearReadDeadline := setRequestBodyReadDeadline(writer, defaultRequestBodyReadTimeout)
	body, err := readRequestBody(request.Context(), request.Body, h.maxBody+1, defaultRequestBodyReadTimeout)
	if err == nil {
		// A capped read may leave a chunked body waiting for its terminating
		// frame. Keep that cleanup bounded so one oversized request cannot hold
		// the MCP admission slot for the entire body-read budget.
		closeReadDeadline := setRequestBodyReadDeadline(writer, requestBodyCloseWait)
		if closeRequestBodyWithin(request.Body, requestBodyCloseWait) {
			closeReadDeadline()
			clearReadDeadline()
		}
	}
	if errors.Is(err, errRequestBodyReadTimeout) {
		writer.Header().Set("X-Loomhelm-MCP-Response", "request_body_timeout")
		writer.WriteHeader(http.StatusRequestTimeout)
		return
	}
	if err != nil {
		if request.Context().Err() != nil {
			return
		}
		writer.Header().Set("X-Loomhelm-MCP-Response", "request_body_unreadable")
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), requestBodyContextKey{}, body))
	if int64(len(body)) <= h.maxBody {
		if requestBatchTooLarge(body, maxMCPBatchRequests) {
			writer.Header().Set("X-Loomhelm-MCP-Response", "batch_too_large")
			writer.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		if requestIDTooLarge(body, h.maxID) {
			writer.Header().Set("X-Loomhelm-MCP-Response", "request_id_too_large")
			writer.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
	}
	h.next.ServeHTTP(writer, request)
}

var errRequestBodyReadTimeout = errors.New("MCP request body read timed out")

func readRequestBody(ctx context.Context, body io.ReadCloser, limit int64, timeout time.Duration) ([]byte, error) {
	result := make(chan struct {
		body []byte
		err  error
	}, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(body, limit))
		result <- struct {
			body []byte
			err  error
		}{body: data, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case outcome := <-result:
		if outcome.err != nil {
			closeRequestBody(body)
		}
		return outcome.body, outcome.err
	case <-ctx.Done():
		closeRequestBody(body)
		return nil, ctx.Err()
	case <-timer.C:
		closeRequestBody(body)
		return nil, errRequestBodyReadTimeout
	}
}

func closeRequestBody(body io.Closer) bool {
	return closeRequestBodyWithin(body, requestBodyCloseWait)
}

func closeRequestBodyWithin(body io.Closer, wait time.Duration) bool {
	if body == nil {
		return true
	}
	if wait <= 0 {
		wait = requestBodyCloseWait
	}
	done := make(chan struct{})
	go func() {
		_ = body.Close()
		close(done)
	}()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func setRequestBodyReadDeadline(writer http.ResponseWriter, timeout time.Duration) func() {
	controller := http.NewResponseController(writer)
	if err := controller.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return func() {}
	}
	return func() {
		_ = controller.SetReadDeadline(time.Time{})
	}
}

func requestIDTooLarge(body []byte, maxBytes int64) bool {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body, &object); err == nil {
		return rawIDTooLarge(object["id"], maxBytes)
	}
	var batch []json.RawMessage
	if err := json.Unmarshal(body, &batch); err != nil {
		return false
	}
	for _, item := range batch {
		var entry map[string]json.RawMessage
		if json.Unmarshal(item, &entry) == nil && rawIDTooLarge(entry["id"], maxBytes) {
			return true
		}
	}
	return false
}

func requestBatchTooLarge(body []byte, maxRequests int) bool {
	var batch []json.RawMessage
	if err := json.Unmarshal(body, &batch); err != nil {
		return false
	}
	return len(batch) > maxRequests
}

func rawIDTooLarge(raw json.RawMessage, maxBytes int64) bool {
	if len(raw) == 0 || maxBytes < 1 {
		return false
	}

	// The SDK re-encodes the request ID in the response. Measure that encoded
	// representation rather than the request token so characters such as
	// U+2028 cannot bypass the legacy batch response budget.
	encoded, ok := encodedJSONValue(raw)
	return !ok || int64(len(encoded)) > maxBytes
}

func encodedJSONValue(raw json.RawMessage) ([]byte, bool) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	encoded, err := json.Marshal(value)
	return encoded, err == nil
}

func decodeAPIError(status int, body []byte) protocol.ApiError {
	var apiError protocol.ApiError
	if json.Unmarshal(body, &apiError) != nil || apiError.Message == "" {
		apiError = protocol.ApiError{Code: errorCodeForHTTP(status), Message: messageForHTTP(status)}
	}
	if apiError.Code == "" {
		apiError.Code = errorCodeForHTTP(status)
	}
	if apiError.Message == "" {
		apiError.Message = messageForHTTP(status)
	}
	return apiError
}

func rpcCodeForHTTP(status int) int {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return -32001
	case http.StatusNotFound:
		return -32004
	case http.StatusConflict:
		return -32009
	default:
		return jsonrpc.CodeInternalError
	}
}

func errorCodeForHTTP(status int) protocol.ErrorCode {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return protocol.ErrorCodeUnauthorized
	case http.StatusNotFound:
		return protocol.ErrorCodeNotFound
	case http.StatusConflict:
		return protocol.ErrorCodeConflict
	default:
		return protocol.ErrorCodeInvalidRequest
	}
}

func messageForHTTP(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return "authentication required"
	case http.StatusForbidden:
		return "operation is not authorized"
	case http.StatusNotFound:
		return "resource is unavailable"
	case http.StatusConflict:
		return "operation conflicts with persisted state"
	default:
		return "application service is temporarily unavailable"
	}
}
