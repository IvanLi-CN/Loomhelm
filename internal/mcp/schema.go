package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type routeSpec struct {
	method      string
	path        string
	pathParams  []string
	queryParams []string
	body        bool
	inputSchema json.RawMessage
	required    []string
	allowed     map[string]bool
}

type toolSpec struct {
	name        string
	description string
	route       routeSpec
	inputSchema json.RawMessage
	required    []string
	allowed     map[string]bool
}

type resourceSpec struct {
	name        string
	uri         string
	operationID string
	route       routeSpec
	template    ResourceTemplate
}

func toolSpecFor(operationID string) (toolSpec, bool) {
	route, ok := routeForOperation(operationID)
	if !ok {
		return toolSpec{}, false
	}
	route.inputSchema, route.required, route.allowed = schemaForOperation(operationID)
	return toolSpec{
		route:       route,
		inputSchema: route.inputSchema,
		required:    route.required,
		allowed:     route.allowed,
	}, true
}

func resourceSpecFor(definition protocol.MCPResourceDefinition) (resourceSpec, bool) {
	route, ok := routeForOperation(definition.OperationID)
	if !ok {
		return resourceSpec{}, false
	}
	pathParams := resourcePathParams(definition.URI)
	if len(pathParams) == 0 {
		return resourceSpec{}, false
	}
	route.pathParams = pathParams
	return resourceSpec{
		name:        definition.Name,
		uri:         definition.URI,
		operationID: definition.OperationID,
		route:       route,
		template: ResourceTemplate{
			Name:        definition.Name,
			URITemplate: definition.URI,
			Description: resourceDescription(definition.Name),
			MIMEType:    "application/json",
		},
	}, true
}

func routeForOperation(operationID string) (routeSpec, bool) {
	routes := map[string]routeSpec{
		"listUserCredentials":  {method: "GET", path: "/credentials"},
		"createUserCredential": {method: "POST", path: "/credentials", body: true},
		"revokeUserCredential": {method: "DELETE", path: "/credentials/{credential_id}", pathParams: []string{"credential_id"}},
		"listProjects":         {method: "GET", path: "/projects", queryParams: []string{"after_cursor", "limit"}},
		"createProject":        {method: "POST", path: "/projects", body: true},
		"getProject":           {method: "GET", path: "/projects/{project_id}", pathParams: []string{"project_id"}},
		"updateProject":        {method: "PATCH", path: "/projects/{project_id}", pathParams: []string{"project_id"}, body: true},
		"deleteProject":        {method: "DELETE", path: "/projects/{project_id}", pathParams: []string{"project_id"}},
		"listProjectMembers":   {method: "GET", path: "/projects/{project_id}/members", pathParams: []string{"project_id"}},
		"grantProjectMember":   {method: "PUT", path: "/projects/{project_id}/members/{user_id}", pathParams: []string{"project_id", "user_id"}, body: true},
		"revokeProjectMember":  {method: "DELETE", path: "/projects/{project_id}/members/{user_id}", pathParams: []string{"project_id", "user_id"}},
		"listTasks":            {method: "GET", path: "/tasks", queryParams: []string{"project_id", "after_cursor", "limit"}},
		"createTask":           {method: "POST", path: "/tasks", body: true},
		"getTask":              {method: "GET", path: "/tasks/{task_id}", pathParams: []string{"task_id"}},
		"updateTask":           {method: "PATCH", path: "/tasks/{task_id}", pathParams: []string{"task_id"}, body: true},
		"deleteTask":           {method: "DELETE", path: "/tasks/{task_id}", pathParams: []string{"task_id"}},
		"getTaskRelationships": {method: "GET", path: "/tasks/{task_id}/relationships", pathParams: []string{"task_id"}},
		"addTaskParent":        {method: "POST", path: "/tasks/{task_id}/parents/{parent_task_id}", pathParams: []string{"task_id", "parent_task_id"}},
		"removeTaskParent":     {method: "DELETE", path: "/tasks/{task_id}/parents/{parent_task_id}", pathParams: []string{"task_id", "parent_task_id"}},
		"addTaskDependency":    {method: "POST", path: "/tasks/{task_id}/dependencies/{prerequisite_task_id}", pathParams: []string{"task_id", "prerequisite_task_id"}},
		"removeTaskDependency": {method: "DELETE", path: "/tasks/{task_id}/dependencies/{prerequisite_task_id}", pathParams: []string{"task_id", "prerequisite_task_id"}},
		"createSession":        {method: "POST", path: "/sessions", body: true},
		"getSession":           {method: "GET", path: "/sessions/{session_id}", pathParams: []string{"session_id"}},
		"bindSessionTask":      {method: "POST", path: "/sessions/{session_id}/task", pathParams: []string{"session_id"}, body: true},
		"submitRun":            {method: "POST", path: "/sessions/{session_id}/runs", pathParams: []string{"session_id"}, body: true},
		"listRunApprovals":     {method: "GET", path: "/runs/{run_id}/approvals", pathParams: []string{"run_id"}, queryParams: []string{"after_cursor", "limit"}},
		"resolveApproval":      {method: "POST", path: "/runs/{run_id}/approvals/{approval_id}", pathParams: []string{"run_id", "approval_id"}, body: true},
		"interruptRun":         {method: "POST", path: "/runs/{run_id}/interrupt", pathParams: []string{"run_id"}, body: true},
		"listRunEvents":        {method: "GET", path: "/runs/{run_id}/events", pathParams: []string{"run_id"}, queryParams: []string{"after_cursor", "limit"}},
		"getArtifact":          {method: "GET", path: "/artifacts/{artifact_id}", pathParams: []string{"artifact_id"}},
	}
	route, ok := routes[operationID]
	return route, ok
}

func schemaForOperation(operationID string) (json.RawMessage, []string, map[string]bool) {
	stringField := func() map[string]any { return map[string]any{"type": "string"} }
	integerField := func() map[string]any { return map[string]any{"type": "integer"} }
	booleanField := func() map[string]any { return map[string]any{"type": "boolean"} }
	arrayOfStrings := func() map[string]any {
		return map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
	}
	enumField := func(values ...string) map[string]any {
		return map[string]any{"type": "string", "enum": values}
	}
	fields := map[string]map[string]any{}
	required := []string{}
	add := func(name string, field map[string]any, isRequired bool) {
		fields[name] = field
		if isRequired {
			required = append(required, name)
		}
	}

	switch operationID {
	case "createUserCredential":
		add("name", stringField(), true)
		add("project_ids", arrayOfStrings(), false)
	case "revokeUserCredential":
		add("credential_id", stringField(), true)
	case "listProjects":
		add("after_cursor", stringField(), false)
		add("limit", integerField(), false)
	case "createProject":
		add("id", stringField(), false)
		add("name", stringField(), true)
		add("description", stringField(), false)
	case "getProject", "updateProject", "deleteProject":
		add("project_id", stringField(), true)
		if operationID == "updateProject" {
			add("name", stringField(), false)
			add("description", stringField(), false)
		}
	case "listProjectMembers":
		add("project_id", stringField(), true)
	case "grantProjectMember":
		add("project_id", stringField(), true)
		add("user_id", stringField(), true)
		add("role", enumField("viewer", "operator"), true)
	case "revokeProjectMember":
		add("project_id", stringField(), true)
		add("user_id", stringField(), true)
	case "listTasks":
		add("project_id", stringField(), false)
		add("after_cursor", stringField(), false)
		add("limit", integerField(), false)
	case "createTask":
		add("id", stringField(), false)
		add("project_id", stringField(), true)
		add("title", stringField(), true)
		add("goal", stringField(), true)
		add("status", enumField("todo", "in_progress", "blocked", "done", "cancelled"), false)
	case "getTask", "updateTask", "deleteTask":
		add("task_id", stringField(), true)
		if operationID == "updateTask" {
			add("title", stringField(), false)
			add("goal", stringField(), false)
			add("status", enumField("todo", "in_progress", "blocked", "done", "cancelled"), false)
		}
	case "getTaskRelationships":
		add("task_id", stringField(), true)
	case "addTaskParent", "removeTaskParent":
		add("task_id", stringField(), true)
		add("parent_task_id", stringField(), true)
	case "addTaskDependency", "removeTaskDependency":
		add("task_id", stringField(), true)
		add("prerequisite_task_id", stringField(), true)
	case "createSession":
		add("command_id", stringField(), true)
		add("path", enumField("new", "existing_active"), true)
		add("project_id", stringField(), false)
		add("task_id", stringField(), false)
		add("prompt", stringField(), false)
		add("active_thread_ref", stringField(), false)
	case "getSession":
		add("session_id", stringField(), true)
	case "bindSessionTask":
		add("session_id", stringField(), true)
		add("task_id", stringField(), true)
		add("confirm_share", booleanField(), false)
	case "submitRun":
		add("session_id", stringField(), true)
		add("command_id", stringField(), true)
		add("prompt", stringField(), true)
		add("model", stringField(), false)
		add("reasoning_effort", stringField(), false)
	case "listRunApprovals", "listRunEvents":
		add("run_id", stringField(), true)
		add("after_cursor", stringField(), false)
		add("limit", integerField(), false)
	case "resolveApproval":
		add("run_id", stringField(), true)
		add("approval_id", stringField(), true)
		add("command_id", stringField(), true)
		add("revision", integerField(), true)
		add("decision", enumField("approve", "deny"), true)
	case "interruptRun":
		add("run_id", stringField(), true)
		add("command_id", stringField(), true)
		add("reason", stringField(), false)
	case "getArtifact":
		add("artifact_id", stringField(), true)
	}

	properties := make(map[string]any, len(fields))
	allowed := make(map[string]bool, len(fields))
	for name, field := range fields {
		properties[name] = field
		allowed[name] = true
	}
	return objectSchema(required, properties), required, allowed
}

func objectSchema(required []string, properties map[string]any) json.RawMessage {
	payload := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) != 0 {
		payload["required"] = required
	}
	data, _ := json.Marshal(payload)
	return data
}

func resourcePathParams(uriTemplate string) []string {
	start := strings.IndexByte(uriTemplate, '{')
	end := strings.IndexByte(uriTemplate, '}')
	if start < 0 || end <= start+1 {
		return nil
	}
	return []string{uriTemplate[start+1 : end]}
}

func resourceDescription(name string) string {
	switch name {
	case "session":
		return "Read an authorized Loomhelm session."
	case "run-events":
		return "Read ordered events for an authorized run."
	case "artifact":
		return "Read authorized conversation artifact metadata."
	default:
		return "Read an authorized Loomhelm resource."
	}
}

func matchResourceURI(resources []resourceSpec, rawURI string) (resourceSpec, map[string]json.RawMessage, bool) {
	parsed, err := url.Parse(rawURI)
	if err != nil || parsed.Scheme != "loomhelm" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return resourceSpec{}, nil, false
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(segments) == 1 && segments[0] == "" {
		return resourceSpec{}, nil, false
	}
	for _, resource := range resources {
		var argument string
		switch resource.name {
		case "session":
			if parsed.Host != "sessions" || len(segments) != 1 {
				continue
			}
			argument = segments[0]
		case "run-events":
			if parsed.Host != "runs" || len(segments) != 2 || segments[1] != "events" {
				continue
			}
			argument = segments[0]
		case "artifact":
			if parsed.Host != "artifacts" || len(segments) != 1 {
				continue
			}
			argument = segments[0]
		default:
			continue
		}
		argument, err = url.PathUnescape(argument)
		if err != nil || argument == "" || strings.Contains(argument, "/") {
			return resourceSpec{}, nil, false
		}
		return resource, map[string]json.RawMessage{
			resource.route.pathParams[0]: json.RawMessage(mustMarshalString(argument)),
		}, true
	}
	return resourceSpec{}, nil, false
}

func mustMarshalString(value string) []byte {
	data, _ := json.Marshal(value)
	return data
}

func decodeArguments(raw json.RawMessage, spec toolSpec) (map[string]json.RawMessage, error) {
	arguments, err := decodeObject(raw, spec.required)
	if err != nil {
		return nil, err
	}
	for name := range arguments {
		if !spec.allowed[name] {
			return nil, fmt.Errorf("unknown MCP tool argument %q", name)
		}
	}
	return arguments, nil
}

func decodeObject(raw json.RawMessage, required []string) (map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte(`{}`)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("MCP tool arguments must be an object")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, errors.New("MCP tool arguments must be an object")
	}
	for _, name := range required {
		value, ok := object[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, fmt.Errorf("MCP parameter %q is required", name)
		}
	}
	return object, nil
}

func routePath(template string, pathParams []string, arguments map[string]json.RawMessage) (string, error) {
	path := template
	for _, name := range pathParams {
		value, err := stringArgument(arguments, name)
		if err != nil {
			return "", err
		}
		path = strings.Replace(path, "{"+name+"}", url.PathEscape(value), 1)
	}
	return path, nil
}

func routeQuery(names []string, arguments map[string]json.RawMessage) (string, error) {
	values := url.Values{}
	for _, name := range names {
		raw, ok := arguments[name]
		if !ok {
			continue
		}
		if name == "limit" {
			var value int64
			if err := json.Unmarshal(raw, &value); err == nil {
				values.Set(name, strconv.FormatInt(value, 10))
				continue
			}
			var stringValue string
			if err := json.Unmarshal(raw, &stringValue); err == nil {
				values.Set(name, stringValue)
				continue
			}
			// Preserve malformed values for the REST parser so that its established
			// 400 response and validation message remain authoritative.
			values.Set(name, strings.TrimSpace(string(raw)))
			continue
		}
		value, err := stringArgument(arguments, name)
		if err != nil {
			return "", err
		}
		values.Set(name, value)
	}
	return values.Encode(), nil
}

func routeBody(route routeSpec, arguments map[string]json.RawMessage) ([]byte, error) {
	if !route.body {
		return nil, nil
	}
	body := make(map[string]json.RawMessage, len(arguments))
	pathNames := make(map[string]struct{}, len(route.pathParams))
	for _, name := range route.pathParams {
		pathNames[name] = struct{}{}
	}
	queryNames := make(map[string]struct{}, len(route.queryParams))
	for _, name := range route.queryParams {
		queryNames[name] = struct{}{}
	}
	for name, value := range arguments {
		if _, ok := pathNames[name]; ok {
			continue
		}
		if _, ok := queryNames[name]; ok {
			continue
		}
		body[name] = value
	}
	return json.Marshal(body)
}

func stringArgument(arguments map[string]json.RawMessage, name string) (string, error) {
	raw, ok := arguments[name]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("MCP parameter %q is required", name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("MCP parameter %q must be a string", name)
	}
	if value == "" {
		return "", fmt.Errorf("MCP parameter %q must not be empty", name)
	}
	return value, nil
}
