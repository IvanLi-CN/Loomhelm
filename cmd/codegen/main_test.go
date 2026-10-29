package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestBrowserAuthenticationDoesNotBecomeAnMCPTool(t *testing.T) {
	data, err := os.ReadFile("../../contracts/loomhelm-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var source contract
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if err := validate(source); err != nil {
		t.Fatal(err)
	}

	for i := range source.REST.Operations {
		op := &source.REST.Operations[i]
		if op.OperationID != "getBrowserSession" {
			continue
		}
		op.BrowserOnly = false
		if err := validate(source); err == nil || !strings.Contains(err.Error(), "must declare an MCP tool") {
			t.Fatalf("business operation without MCP definition: %v", err)
		}
		op.BrowserOnly = true
		op.MCPTool = &mcpTool{Name: "browser.session", Description: "Invalid browser exposure"}
		if err := validate(source); err == nil || !strings.Contains(err.Error(), "must not declare an MCP tool") {
			t.Fatalf("browser authentication exposed as MCP: %v", err)
		}
		return
	}
	t.Fatal("browser session operation missing from contract")
}

func TestArtifactDownloadUsesBinaryBrowserClientResponse(t *testing.T) {
	data, err := os.ReadFile("../../contracts/loomhelm-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var source contract
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if err := validate(source); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, operation := range source.REST.Operations {
		if operation.OperationID != "downloadArtifact" {
			continue
		}
		found = true
		if !operation.BrowserOnly || operation.MCPTool != nil {
			t.Fatal("artifact download must remain browser-only")
		}
		if source.Types[operation.ResponseType].Kind != "binary" {
			t.Fatalf("artifact download response kind = %q, want binary", source.Types[operation.ResponseType].Kind)
		}
		generated := (generator{contract: source}).apiClientTypeScript()
		if !strings.Contains(generated, "async downloadArtifact(request: DownloadArtifactParams): Promise<Response>") || !strings.Contains(generated, "application/octet-stream") || !strings.Contains(generated, "undefined, [200, 206], true") {
			t.Fatal("generated artifact download client does not preserve the binary response")
		}
	}
	if !found {
		t.Fatal("artifact download operation missing from contract")
	}
}

func TestArtifactContentDownloadExposesCursorAddressedAPIMCPResponse(t *testing.T) {
	data, err := os.ReadFile("../../contracts/loomhelm-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var source contract
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if err := validate(source); err != nil {
		t.Fatal(err)
	}
	for _, operation := range source.REST.Operations {
		if operation.OperationID != "downloadArtifactContent" {
			continue
		}
		if operation.BrowserOnly || operation.MCPTool == nil || operation.QueryType != "DownloadArtifactContentQuery" {
			t.Fatalf("artifact content operation is not an API/MCP query: %#v", operation)
		}
		if operation.ResponseType != "ArtifactContentResponse" {
			t.Fatalf("artifact content response type = %q", operation.ResponseType)
		}
		generated := (generator{contract: source}).apiClientTypeScript()
		if !strings.Contains(generated, "async downloadArtifactContent(request: DownloadArtifactContentParams): Promise<Protocol.ArtifactContentResponse>") || !strings.Contains(generated, "artifacts/${encodeURIComponent(request.artifact_id)}/content") {
			t.Fatal("generated artifact content client does not preserve the API response and cursor path")
		}
		return
	}
	t.Fatal("artifact content download operation missing from contract")
}
