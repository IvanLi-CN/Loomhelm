package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	contractSchema  = "loomhelm.public-contract/v1"
	defaultContract = "contracts/loomhelm-v1.json"
)

type contract struct {
	Schema  string            `json:"schema"`
	Version string            `json:"version"`
	Types   map[string]schema `json:"types"`
	REST    restContract      `json:"rest"`
	MCP     mcpContract       `json:"mcp"`
}

type schema struct {
	Kind                 string            `json:"kind"`
	Ref                  string            `json:"$ref"`
	Type                 string            `json:"type"`
	Format               string            `json:"format"`
	Enum                 []string          `json:"enum"`
	Required             []string          `json:"required"`
	Properties           map[string]schema `json:"properties"`
	Items                *schema           `json:"items"`
	AdditionalProperties json.RawMessage   `json:"additionalProperties"`
}

type restContract struct {
	BasePath   string      `json:"base_path"`
	Operations []operation `json:"operations"`
}

type operation struct {
	OperationID    string            `json:"operation_id"`
	Method         string            `json:"method"`
	Path           string            `json:"path"`
	PathParams     map[string]string `json:"path_params"`
	QueryType      string            `json:"query_type"`
	BodyType       string            `json:"body_type"`
	ResponseType   string            `json:"response_type"`
	ResponseStatus int               `json:"response_status"`
	Summary        string            `json:"summary"`
	MCPTool        *mcpTool          `json:"mcp_tool"`
}

type mcpTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type mcpContract struct {
	Resources []mcpResource `json:"resources"`
}

type mcpResource struct {
	Name        string `json:"name"`
	URI         string `json:"uri"`
	OperationID string `json:"operation_id"`
}

type generator struct {
	root         string
	contract     contract
	digest       string
	contractPath string
}

func main() {
	rootFlag := flag.String("root", ".", "repository root")
	contractFlag := flag.String("contract", defaultContract, "path to the canonical contract")
	check := flag.Bool("check", false, "check generated files without writing them")
	flag.Parse()

	root, err := filepath.Abs(*rootFlag)
	if err != nil {
		fatal(err)
	}
	contractPath := *contractFlag
	if !filepath.IsAbs(contractPath) {
		contractPath = filepath.Join(root, contractPath)
	}
	data, err := os.ReadFile(contractPath)
	if err != nil {
		fatal(fmt.Errorf("read contract %s: %w", contractPath, err))
	}

	var source contract
	if err := json.Unmarshal(data, &source); err != nil {
		fatal(fmt.Errorf("decode contract %s: %w", contractPath, err))
	}
	if err := validate(source); err != nil {
		fatal(fmt.Errorf("validate contract: %w", err))
	}
	digest := sha256.Sum256(data)
	g := generator{
		root:         root,
		contract:     source,
		digest:       hex.EncodeToString(digest[:]),
		contractPath: filepath.ToSlash(filepath.Join("contracts", filepath.Base(contractPath))),
	}

	outputs := map[string][]byte{}
	goSource, err := g.goSource()
	if err != nil {
		fatal(err)
	}
	outputs[filepath.Join(root, "internal/protocol/generated.go")] = goSource
	outputs[filepath.Join(root, "packages/protocol/src/generated.ts")] = []byte(g.protocolTypeScript())
	outputs[filepath.Join(root, "packages/api-client/src/generated.ts")] = []byte(g.apiClientTypeScript())

	if *check {
		if err := checkOutputs(outputs); err != nil {
			fatal(err)
		}
		return
	}
	for path, output := range outputs {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fatal(fmt.Errorf("create output directory for %s: %w", path, err))
		}
		if err := os.WriteFile(path, output, 0o644); err != nil {
			fatal(fmt.Errorf("write generated file %s: %w", path, err))
		}
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func validate(source contract) error {
	if source.Schema != contractSchema {
		return fmt.Errorf("schema must be %q", contractSchema)
	}
	if source.Version == "" {
		return fmt.Errorf("version must not be empty")
	}
	if len(source.Types) == 0 {
		return fmt.Errorf("types must not be empty")
	}
	for name, value := range source.Types {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("type name must not be empty")
		}
		if err := validateSchema(source.Types, value, fmt.Sprintf("type %s", name)); err != nil {
			return err
		}
	}
	if source.REST.BasePath == "" || !strings.HasPrefix(source.REST.BasePath, "/") {
		return fmt.Errorf("rest.base_path must be an absolute path")
	}
	seenOperations := map[string]bool{}
	for _, operation := range source.REST.Operations {
		if operation.OperationID == "" || seenOperations[operation.OperationID] {
			return fmt.Errorf("REST operation ids must be unique and non-empty")
		}
		seenOperations[operation.OperationID] = true
		if !map[string]bool{"GET": true, "POST": true, "PATCH": true, "PUT": true, "DELETE": true}[operation.Method] {
			return fmt.Errorf("operation %s has unsupported method %q", operation.OperationID, operation.Method)
		}
		if !strings.HasPrefix(operation.Path, "/") {
			return fmt.Errorf("operation %s path must start with /", operation.OperationID)
		}
		for name := range operation.PathParams {
			if !strings.Contains(operation.Path, "{"+name+"}") {
				return fmt.Errorf("operation %s path parameter %q is not in the path", operation.OperationID, name)
			}
		}
		for name := range pathParameters(operation.Path) {
			if _, ok := operation.PathParams[name]; !ok {
				return fmt.Errorf("operation %s path parameter %q is not declared", operation.OperationID, name)
			}
		}
		for typeName, label := range map[string]string{
			operation.QueryType:    "query type",
			operation.BodyType:     "body type",
			operation.ResponseType: "response type",
		} {
			if typeName != "" {
				if _, ok := source.Types[typeName]; !ok {
					return fmt.Errorf("operation %s references missing %s %q", operation.OperationID, label, typeName)
				}
			}
		}
		if operation.ResponseStatus != 0 && (operation.ResponseStatus < 200 || operation.ResponseStatus > 299) {
			return fmt.Errorf("operation %s response status must be successful", operation.OperationID)
		}
		if operation.ResponseStatus == 204 {
			if operation.ResponseType != "" {
				return fmt.Errorf("operation %s cannot declare a response body for status 204", operation.OperationID)
			}
		} else if operation.ResponseType == "" {
			return fmt.Errorf("operation %s response type must not be empty unless status is 204", operation.OperationID)
		}
		if operation.MCPTool == nil || operation.MCPTool.Name == "" || operation.MCPTool.Description == "" {
			return fmt.Errorf("operation %s must declare an MCP tool", operation.OperationID)
		}
	}
	seenResources := map[string]bool{}
	for _, resource := range source.MCP.Resources {
		if resource.Name == "" || resource.URI == "" || resource.OperationID == "" {
			return fmt.Errorf("MCP resources require name, uri, and operation_id")
		}
		if seenResources[resource.Name] {
			return fmt.Errorf("MCP resource names must be unique")
		}
		seenResources[resource.Name] = true
		if !seenOperations[resource.OperationID] {
			return fmt.Errorf("MCP resource %s references missing operation %q", resource.Name, resource.OperationID)
		}
	}
	return nil
}

func validateSchema(types map[string]schema, value schema, location string) error {
	if value.Ref != "" {
		const prefix = "#/types/"
		if !strings.HasPrefix(value.Ref, prefix) {
			return fmt.Errorf("%s has unsupported ref %q", location, value.Ref)
		}
		if _, ok := types[strings.TrimPrefix(value.Ref, prefix)]; !ok {
			return fmt.Errorf("%s references missing type %q", location, value.Ref)
		}
		return nil
	}
	if value.Kind == "json-value" || value.Kind == "raw-json" {
		return nil
	}
	if value.Type == "" {
		return fmt.Errorf("%s must declare type, ref, or kind", location)
	}
	if value.Type == "string" && len(value.Enum) > 0 {
		for _, item := range value.Enum {
			if item == "" {
				return fmt.Errorf("%s enum values must not be empty", location)
			}
		}
	}
	if value.Type == "object" {
		for property, child := range value.Properties {
			if err := validateSchema(types, child, location+"."+property); err != nil {
				return err
			}
		}
		for _, required := range value.Required {
			if _, ok := value.Properties[required]; !ok {
				return fmt.Errorf("%s requires missing property %q", location, required)
			}
		}
	}
	if value.Type == "array" {
		if value.Items == nil {
			return fmt.Errorf("%s array must declare items", location)
		}
		if err := validateSchema(types, *value.Items, location+"[]"); err != nil {
			return err
		}
	}
	return nil
}

func pathParameters(path string) map[string]bool {
	result := map[string]bool{}
	for {
		start := strings.IndexByte(path, '{')
		if start < 0 {
			return result
		}
		end := strings.IndexByte(path[start:], '}')
		if end < 0 {
			return result
		}
		result[path[start+1:start+end]] = true
		path = path[start+end+1:]
	}
}

func checkOutputs(outputs map[string][]byte) error {
	var mismatches []string
	paths := make([]string, 0, len(outputs))
	for path := range outputs {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		actual, err := os.ReadFile(path)
		if err != nil {
			mismatches = append(mismatches, filepath.ToSlash(path)+": missing")
			continue
		}
		if !bytes.Equal(actual, outputs[path]) {
			mismatches = append(mismatches, filepath.ToSlash(path)+": differs")
		}
	}
	if len(mismatches) > 0 {
		return fmt.Errorf("generated files are out of date:\n- %s", strings.Join(mismatches, "\n- "))
	}
	return nil
}

func (g generator) goSource() ([]byte, error) {
	var out strings.Builder
	fmt.Fprintf(&out, "// Code generated by cmd/codegen from %s; DO NOT EDIT.\n", g.contractPath)
	fmt.Fprintf(&out, "// Contract SHA256: %s\n\n", g.digest)
	out.WriteString("package protocol\n\n")
	out.WriteString("import (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"fmt\"\n)\n\n")
	out.WriteString("type JSONValue = any\n\n")

	names := sortedKeys(g.contract.Types)
	for _, name := range names {
		value := g.contract.Types[name]
		if value.Kind == "json-value" || value.Kind == "raw-json" {
			continue
		}
		if len(value.Enum) > 0 {
			fmt.Fprintf(&out, "type %s string\n\nconst (\n", name)
			for _, item := range value.Enum {
				fmt.Fprintf(&out, "\t%s%s %s = %q\n", name, pascal(item), name, item)
			}
			out.WriteString(")\n\n")
			continue
		}
		if value.Type != "object" {
			fmt.Fprintf(&out, "type %s %s\n\n", name, g.goType(value, true))
			continue
		}
		fmt.Fprintf(&out, "type %s struct {\n", name)
		for _, property := range sortedKeys(value.Properties) {
			child := value.Properties[property]
			required := contains(value.Required, property)
			fieldType := g.goType(child, required)
			tagValue := property
			if !required {
				tagValue += ",omitempty"
			}
			tag := fmt.Sprintf("json:%q", tagValue)
			fmt.Fprintf(&out, "\t%s %s `%s`\n", goFieldName(property), fieldType, tag)
		}
		out.WriteString("}\n\n")
	}

	out.WriteString("type RESTOperation struct {\n\tOperationID string\n\tMethod string\n\tPath string\n\tRequestType string\n\tResponseType string\n\tResponseStatus int\n}\n\n")
	out.WriteString("var RESTOperations = []RESTOperation{\n")
	for _, operation := range g.contract.REST.Operations {
		requestType := operationRequestType(operation)
		fmt.Fprintf(&out, "\t{OperationID: %q, Method: %q, Path: %q, RequestType: %q, ResponseType: %q, ResponseStatus: %d},\n", operation.OperationID, operation.Method, g.contract.REST.BasePath+operation.Path, requestType, operation.ResponseType, operation.ResponseStatus)
	}
	out.WriteString("}\n\n")

	out.WriteString("type MCPToolDefinition struct {\n\tName string\n\tDescription string\n\tOperationID string\n\tInputType string\n}\n\n")
	out.WriteString("var MCPTools = []MCPToolDefinition{\n")
	for _, operation := range g.contract.REST.Operations {
		fmt.Fprintf(&out, "\t{Name: %q, Description: %q, OperationID: %q, InputType: %q},\n", operation.MCPTool.Name, operation.MCPTool.Description, operation.OperationID, operationRequestType(operation))
	}
	out.WriteString("}\n\n")

	out.WriteString("type MCPResourceDefinition struct {\n\tName string\n\tURI string\n\tOperationID string\n}\n\n")
	out.WriteString("var MCPResources = []MCPResourceDefinition{\n")
	for _, resource := range g.contract.MCP.Resources {
		fmt.Fprintf(&out, "\t{Name: %q, URI: %q, OperationID: %q},\n", resource.Name, resource.URI, resource.OperationID)
	}
	out.WriteString("}\n\n")

	out.WriteString(`func DecodeFixtureEnvelope(data []byte) (FixtureEnvelope, error) {
	var value FixtureEnvelope
	if err := json.Unmarshal(data, &value); err != nil {
		return FixtureEnvelope{}, fmt.Errorf("decode fixture envelope: %w", err)
	}
	if err := value.Validate(); err != nil {
		return FixtureEnvelope{}, err
	}
	return value, nil
}

func EncodeFixtureEnvelope(value FixtureEnvelope) ([]byte, error) {
	if err := value.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func DecodeCodexFixtureEnvelope(data []byte) (CodexFixtureEnvelope, error) {
	return DecodeFixtureEnvelope(data)
}

func EncodeCodexFixtureEnvelope(value CodexFixtureEnvelope) ([]byte, error) {
	return EncodeFixtureEnvelope(value)
}

func (value FixtureEnvelope) Validate() error {
	if value.Schema == "" || value.Source == "" {
		return fmt.Errorf("fixture envelope schema and source are required")
	}
	if value.Stream == "" || value.Sequence < 1 {
		return fmt.Errorf("fixture envelope stream and positive sequence are required")
	}
	trimmed := bytes.TrimSpace(value.Payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("fixture envelope payload must be a JSON object")
	}
	return nil
}

type CodexFixtureEnvelope = FixtureEnvelope
`)

	formatted, err := format.Source([]byte(out.String()))
	if err != nil {
		return nil, fmt.Errorf("format generated Go: %w", err)
	}
	return formatted, nil
}

func (g generator) protocolTypeScript() string {
	var out strings.Builder
	fmt.Fprintf(&out, "// Code generated by cmd/codegen from %s; DO NOT EDIT.\n", g.contractPath)
	fmt.Fprintf(&out, "// Contract SHA256: %s\n\n", g.digest)
	out.WriteString("export type JsonPrimitive = boolean | null | number | string;\n")
	out.WriteString("export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };\n")
	out.WriteString("export type JSONValue = JsonValue;\n\n")

	for _, name := range sortedKeys(g.contract.Types) {
		value := g.contract.Types[name]
		if value.Kind == "json-value" || value.Kind == "raw-json" {
			continue
		}
		if len(value.Enum) > 0 {
			quoted := make([]string, len(value.Enum))
			for i, item := range value.Enum {
				quoted[i] = fmt.Sprintf("%q", item)
			}
			fmt.Fprintf(&out, "export type %s = %s;\n\n", name, strings.Join(quoted, " | "))
			continue
		}
		if value.Type != "object" {
			fmt.Fprintf(&out, "export type %s = %s;\n\n", name, g.tsType(value))
			continue
		}
		fmt.Fprintf(&out, "export interface %s {\n", name)
		for _, property := range sortedKeys(value.Properties) {
			child := value.Properties[property]
			optional := !contains(value.Required, property)
			fmt.Fprintf(&out, "  %s%s: %s;\n", property, ternary(optional, "?", ""), g.tsType(child))
		}
		out.WriteString("}\n\n")
	}

	out.WriteString("export interface RestOperation { operationId: string; method: string; path: string; requestType: string; responseType: string; responseStatus: number; }\n")
	out.WriteString("export const REST_OPERATIONS = [\n")
	for _, operation := range g.contract.REST.Operations {
		fmt.Fprintf(&out, "  { operationId: %q, method: %q, path: %q, requestType: %q, responseType: %q, responseStatus: %d },\n", operation.OperationID, operation.Method, g.contract.REST.BasePath+operation.Path, operationRequestType(operation), operation.ResponseType, operation.ResponseStatus)
	}
	out.WriteString("] as const satisfies readonly RestOperation[];\n\n")

	out.WriteString("export interface McpToolDefinition { name: string; description: string; operationId: string; inputType: string; }\n")
	out.WriteString("export const MCP_TOOLS = [\n")
	for _, operation := range g.contract.REST.Operations {
		fmt.Fprintf(&out, "  { name: %q, description: %q, operationId: %q, inputType: %q },\n", operation.MCPTool.Name, operation.MCPTool.Description, operation.OperationID, operationRequestType(operation))
	}
	out.WriteString("] as const satisfies readonly McpToolDefinition[];\n\n")

	out.WriteString("export interface McpResourceDefinition { name: string; uri: string; operationId: string; }\n")
	out.WriteString("export const MCP_RESOURCES = [\n")
	for _, resource := range g.contract.MCP.Resources {
		fmt.Fprintf(&out, "  { name: %q, uri: %q, operationId: %q },\n", resource.Name, resource.URI, resource.OperationID)
	}
	out.WriteString("] as const satisfies readonly McpResourceDefinition[];\n\n")

	out.WriteString(`export function encodeFixtureEnvelope(value: FixtureEnvelope): string {
  return JSON.stringify(value);
}

export function decodeFixtureEnvelope(text: string): FixtureEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("decode fixture envelope: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!isRecord(value)) throw new Error("fixture envelope must be an object");
  if (typeof value.schema !== "string" || typeof value.source !== "string") throw new Error("fixture envelope schema and source are required");
  if (typeof value.stream !== "string" || typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1) throw new Error("fixture envelope stream and positive sequence are required");
  if (!isRecord(value.payload)) throw new Error("fixture envelope payload must be an object");
  return value as unknown as FixtureEnvelope;
}

export const encodeCodexFixtureEnvelope = encodeFixtureEnvelope;
export const decodeCodexFixtureEnvelope = decodeFixtureEnvelope;

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`)
	return out.String()
}

func (g generator) apiClientTypeScript() string {
	var out strings.Builder
	fmt.Fprintf(&out, "// Code generated by cmd/codegen from %s; DO NOT EDIT.\n", g.contractPath)
	fmt.Fprintf(&out, "// Contract SHA256: %s\n\n", g.digest)
	out.WriteString("import type * as Protocol from \"../../protocol/src/generated\";\n\n")
	out.WriteString("export interface ApiClientOptions { baseUrl?: string; fetch?: typeof globalThis.fetch; headers?: HeadersInit; }\n\n")
	out.WriteString("export class ApiClientError extends Error {\n  readonly status: number;\n  readonly body: unknown;\n\n  constructor(status: number, body: unknown) {\n    super(\"Loomhelm API request failed with status \" + status);\n    this.name = \"ApiClientError\";\n    this.status = status;\n    this.body = body;\n  }\n}\n\n")

	for _, operation := range g.contract.REST.Operations {
		paramsType := operationParamsType(operation)
		fmt.Fprintf(&out, "export interface %s {\n", paramsType)
		for _, property := range sortedKeys(operation.PathParams) {
			fmt.Fprintf(&out, "  %s: %s;\n", property, tsPrimitive(operation.PathParams[property]))
		}
		if operation.QueryType != "" {
			query := g.contract.Types[operation.QueryType]
			for _, property := range sortedKeys(query.Properties) {
				child := query.Properties[property]
				fmt.Fprintf(&out, "  %s?: %s;\n", property, g.tsType(child))
			}
		}
		if operation.BodyType != "" {
			fmt.Fprintf(&out, "  body: Protocol.%s;\n", operation.BodyType)
		}
		out.WriteString("}\n\n")
	}

	out.WriteString("export class LoomhelmApiClient {\n  private readonly options: ApiClientOptions;\n\n  constructor(options: ApiClientOptions = {}) {\n    this.options = options;\n  }\n\n")
	for _, operation := range g.contract.REST.Operations {
		paramsType := operationParamsType(operation)
		requestOptional := len(operation.PathParams) == 0 && operation.BodyType == ""
		responseType := "void"
		if operation.ResponseType != "" {
			responseType = "Protocol." + operation.ResponseType
		}
		if requestOptional {
			fmt.Fprintf(&out, "  async %s(request: %s = {}): Promise<%s> {\n", operation.OperationID, paramsType, responseType)
		} else {
			fmt.Fprintf(&out, "  async %s(request: %s): Promise<%s> {\n", operation.OperationID, paramsType, responseType)
		}
		pathExpression := g.tsPathExpression(operation)
		fmt.Fprintf(&out, "    const path = %s;\n", pathExpression)
		if operation.QueryType != "" {
			fmt.Fprintf(&out, "    const query = new URLSearchParams();\n")
			for _, property := range sortedKeys(g.contract.Types[operation.QueryType].Properties) {
				fmt.Fprintf(&out, "    if (request.%s !== undefined) query.set(%q, String(request.%s));\n", property, property, property)
			}
			out.WriteString("    const queryText = query.toString();\n    const requestPath = queryText ? `${path}?${queryText}` : path;\n")
		} else {
			out.WriteString("    const requestPath = path;\n")
		}
		if operation.ResponseStatus != 0 {
			body := "undefined"
			if operation.BodyType != "" {
				body = "request.body"
			}
			fmt.Fprintf(&out, "    return this.request<%s>(%q, requestPath, %s, %d);\n", responseType, operation.Method, body, operation.ResponseStatus)
		} else if operation.BodyType != "" {
			fmt.Fprintf(&out, "    return this.request<%s>(%q, requestPath, request.body);\n", responseType, operation.Method)
		} else {
			fmt.Fprintf(&out, "    return this.request<%s>(%q, requestPath);\n", responseType, operation.Method)
		}
		out.WriteString("  }\n\n")
	}
	out.WriteString(`  private async request<T>(method: string, path: string, body?: unknown, expectedStatus?: number): Promise<T> {
    const baseUrl = this.options.baseUrl ?? (typeof location === "undefined" ? "http://localhost" : location.origin);
    const url = new URL(path, baseUrl);
    const fetcher = this.options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new Error("a fetch implementation is required");
    const headers = new Headers(this.options.headers);
    headers.set("Accept", "application/json");
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    const response = await fetcher(url, init);
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) throw new ApiClientError(response.status, parsed);
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new Error("Loomhelm API returned status " + response.status + "; expected " + expectedStatus);
    }
    return parsed as T;
  }
}

export function createGeneratedApiClient(options: ApiClientOptions = {}): LoomhelmApiClient {
  return new LoomhelmApiClient(options);
}
`)
	return out.String()
}

func (g generator) goType(value schema, required bool) string {
	var result string
	switch {
	case value.Ref != "":
		result = strings.TrimPrefix(value.Ref, "#/types/")
	case value.Kind == "raw-json":
		result = "json.RawMessage"
	case value.Kind == "json-value":
		result = "JSONValue"
	case value.Type == "string":
		result = "string"
	case value.Type == "integer":
		result = "int64"
	case value.Type == "number":
		result = "float64"
	case value.Type == "boolean":
		result = "bool"
	case value.Type == "array":
		result = "[]" + g.goType(*value.Items, true)
	case value.Type == "object":
		if len(value.Properties) > 0 {
			result = "map[string]any"
		} else {
			result = "map[string]any"
		}
	default:
		result = "any"
	}
	if !required && isPointerCandidate(result) {
		return "*" + result
	}
	return result
}

func (g generator) tsType(value schema) string {
	switch {
	case value.Ref != "":
		return strings.TrimPrefix(value.Ref, "#/types/")
	case value.Kind == "raw-json", value.Kind == "json-value":
		return "JsonValue"
	case value.Type == "string":
		return "string"
	case value.Type == "integer", value.Type == "number":
		return "number"
	case value.Type == "boolean":
		return "boolean"
	case value.Type == "array":
		return "ReadonlyArray<" + g.tsType(*value.Items) + ">"
	case value.Type == "object":
		return "{ readonly [key: string]: JsonValue }"
	default:
		return "JsonValue"
	}
}

func operationRequestType(value operation) string {
	return operationParamsType(value)
}

func operationParamsType(value operation) string {
	return pascal(value.OperationID) + "Params"
}

func (g generator) tsPathExpression(value operation) string {
	path := g.contract.REST.BasePath + value.Path
	if len(value.PathParams) == 0 {
		return strconv.Quote(path)
	}
	var out strings.Builder
	out.WriteByte('`')
	for {
		start := strings.IndexByte(path, '{')
		if start < 0 {
			out.WriteString(path)
			break
		}
		out.WriteString(path[:start])
		end := strings.IndexByte(path[start:], '}')
		name := path[start+1 : start+end]
		out.WriteString("${encodeURIComponent(request.")
		out.WriteString(name)
		out.WriteString(")}")
		path = path[start+end+1:]
	}
	out.WriteByte('`')
	return out.String()
}

func tsPrimitive(value string) string {
	switch value {
	case "string":
		return "string"
	case "integer", "number":
		return "number"
	case "boolean":
		return "boolean"
	default:
		return "string"
	}
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func isPointerCandidate(value string) bool {
	return value == "string" || value == "int64" || value == "float64" || value == "bool" || strings.Contains(value, " ") == false && strings.HasPrefix(value, "map[") == false && strings.HasPrefix(value, "[]") == false && value != "json.RawMessage" && value != "JSONValue"
}

func goFieldName(value string) string {
	parts := strings.Split(value, "_")
	var out strings.Builder
	for _, part := range parts {
		if part == "" {
			continue
		}
		upper := strings.ToUpper(part)
		switch upper {
		case "API", "HTTP", "ID", "MCP", "RPC", "SHA", "URL":
			out.WriteString(upper)
		default:
			out.WriteString(strings.ToUpper(part[:1]) + part[1:])
		}
	}
	return out.String()
}

func pascal(value string) string {
	parts := strings.FieldsFunc(value, func(r rune) bool { return r == '_' || r == '-' || r == '.' || r == ' ' })
	var out strings.Builder
	for _, part := range parts {
		if part == "" {
			continue
		}
		out.WriteString(strings.ToUpper(part[:1]) + part[1:])
	}
	return out.String()
}

func ternary(condition bool, yes, no string) string {
	if condition {
		return yes
	}
	return no
}
