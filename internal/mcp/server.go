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
	maxToolErrorMessageBytes            = 160
	maxToolErrorRequestIDBytes          = 64
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
	if config.MaxResponseBytes < minimumMaxResponseBytes {
		return nil, fmt.Errorf("MCP response limit must be at least %d bytes", minimumMaxResponseBytes)
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
	server.handler = &noStoreHandler{next: &originHandler{
		next: &requestConcurrencyHandler{
			next: &requestIDLimitHandler{
				next: &responseLimitHandler{
					next: transport,
					max:  config.MaxResponseBytes,
				},
				maxBody: config.MaxBodyBytes,
				maxID:   config.MaxResponseBytes / 8,
			},
			slots: make(chan struct{}, concurrentMCPRequestSlots(config.MaxBodyBytes, config.MaxResponseBytes)),
			wait:  defaultMCPAdmissionWait,
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
			return toolError(response.status, decodeAPIError(response.status, response.body)), nil
		}
		if !validToolResponse(spec.operationID, response.body) {
			return unknownOutcomeResult(), nil
		}
		result, err := toolSuccess(response.body)
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
	if operationID != "createUserCredential" {
		return true
	}
	var response protocol.CreateUserCredentialResponse
	return json.Unmarshal(body, &response) == nil && strings.TrimSpace(response.Credential.Token) != ""
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

func encodedResponseWithinBudget(value any, maxResponse int64) bool {
	if maxResponse < 4 {
		return false
	}
	data, err := json.Marshal(value)
	return err == nil && int64(len(data)) <= maxResponse/4
}

func toolError(status int, apiError protocol.ApiError) *sdk.CallToolResult {
	if apiError.Code == "" {
		apiError.Code = errorCodeForHTTP(status)
	}
	if apiError.Message == "" {
		apiError.Message = messageForHTTP(status)
	}
	apiError.Details = nil
	apiError.Message = truncateUTF8(apiError.Message, maxToolErrorMessageBytes)
	apiError.RequestID = truncateUTF8(apiError.RequestID, maxToolErrorRequestIDBytes)
	data, _ := json.Marshal(map[string]any{"http_status": status, "error": apiError})
	return &sdk.CallToolResult{
		Content:           []sdk.Content{&sdk.TextContent{Text: string(data)}},
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
			http.Error(writer, "MCP request origin is not allowed", http.StatusForbidden)
			return
		}
	} else if h.crossOrigin != nil {
		if err := h.crossOrigin.Check(request); err != nil {
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
	next http.Handler
	max  int64
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
	if maxBody > 1<<60 || maxResponse > 1<<61 {
		return 1
	}
	perRequest := maxBody*4 + maxResponse*2
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
	next  http.Handler
	slots chan struct{}
	wait  time.Duration
}

func (h *requestConcurrencyHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if h.slots == nil {
		h.next.ServeHTTP(writer, request)
		return
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
	case <-timer.C:
		writer.Header().Set("X-Loomhelm-MCP-Response", "concurrency_limited")
		writer.Header().Set("Retry-After", "1")
		writer.WriteHeader(http.StatusServiceUnavailable)
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
	body, err := readRequestBody(request.Context(), request.Body, h.maxBody+1, defaultRequestBodyReadTimeout)
	_ = request.Body.Close()
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
		return outcome.body, outcome.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		_ = body.Close()
		return nil, errRequestBodyReadTimeout
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
	return len(raw) != 0 && int64(len(raw)) > maxBytes
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
