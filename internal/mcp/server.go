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
	"net/http"
	"strings"

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

	defaultMaxBodyBytes     int64 = 1 << 20
	defaultMaxResponseBytes int64 = 4 << 20
)

var (
	errRESTHandlerRequired = errors.New("MCP REST application handler is required")
	errResponseTooLarge    = errors.New("MCP application response is too large")
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
	// An empty value uses the SDK's current supported list.
	ProtocolVersions []string

	// AllowedOrigins is an exact allowlist. An absent Origin header is accepted;
	// a present Origin is rejected unless it is listed here. Wildcards are not
	// accepted because this endpoint may control real execution.
	AllowedOrigins []string

	MaxBodyBytes     int64
	MaxResponseBytes int64
}

// Server is an MCP endpoint backed by the official Go SDK's stateless
// Streamable HTTP transport.
type Server struct {
	sdkServer      *sdk.Server
	handler        http.Handler
	restHandler    http.Handler
	restPathPrefix string
	maxResponse    int64
	tools          []Tool
	resources      []resourceSpec
	toolByName     map[string]toolSpec
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
	if config.MaxBodyBytes < 1 || config.MaxResponseBytes < 1 {
		return nil, fmt.Errorf("MCP body and response limits must be positive")
	}

	sdkServer := sdk.NewServer(
		&sdk.Implementation{Name: config.ServerName, Version: config.ServerVersion},
		&sdk.ServerOptions{
			Capabilities:              &sdk.ServerCapabilities{},
			SupportedProtocolVersions: protocols,
		},
	)
	server := &Server{
		sdkServer:      sdkServer,
		restHandler:    config.RESTHandler,
		restPathPrefix: strings.TrimRight(config.RESTPathPrefix, "/"),
		maxResponse:    config.MaxResponseBytes,
		toolByName:     make(map[string]toolSpec, len(protocol.MCPTools)),
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
	server.handler = &originHandler{next: transport, allowed: origins}
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
			return toolError(http.StatusServiceUnavailable, protocol.ApiError{
				Code:    protocol.ErrorCodeInvalidRequest,
				Message: "application service is unavailable",
			}), nil
		}
		if response.status < http.StatusOK || response.status >= http.StatusMultipleChoices {
			return toolError(response.status, decodeAPIError(response.status, response.body)), nil
		}
		return toolSuccess(response.body)
	}
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
	return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{
		URI:      request.Params.URI,
		MIMEType: "application/json",
		Text:     string(body),
	}}}, nil
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
		return restResponse{}, err
	}
	query, err := routeQuery(route.queryParams, arguments)
	if err != nil {
		return restResponse{}, err
	}
	if s.restPathPrefix != "" {
		path = s.restPathPrefix + "/" + strings.TrimLeft(path, "/")
	}
	if query != "" {
		path += "?" + query
	}
	payload, err := routeBody(route, arguments)
	if err != nil {
		return restResponse{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	internalRequest, err := http.NewRequestWithContext(ctx, route.method, path, bytes.NewReader(payload))
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
	return restResponse{status: response.status, body: response.body.Bytes()}, nil
}

type restResponse struct {
	status int
	body   []byte
}

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

func toolError(status int, apiError protocol.ApiError) *sdk.CallToolResult {
	if apiError.Code == "" {
		apiError.Code = errorCodeForHTTP(status)
	}
	if apiError.Message == "" {
		apiError.Message = messageForHTTP(status)
	}
	data, _ := json.Marshal(map[string]any{"http_status": status, "error": apiError})
	return &sdk.CallToolResult{
		Content:           []sdk.Content{&sdk.TextContent{Text: string(data)}},
		StructuredContent: json.RawMessage(data),
		IsError:           true,
	}
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
	next    http.Handler
	allowed map[string]struct{}
}

func (h *originHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if origin := request.Header.Get("Origin"); origin != "" {
		if _, ok := h.allowed[origin]; !ok {
			http.Error(writer, "MCP request origin is not allowed", http.StatusForbidden)
			return
		}
	}
	h.next.ServeHTTP(writer, request)
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
