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
