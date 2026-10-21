package content

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCommittedR02FixturesPreserveBasicAndUnknownContent(t *testing.T) {
	root := repositoryRoot(t)
	paths, err := filepath.Glob(filepath.Join(root, "fixtures", "codex", "samples", "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 3 {
		t.Fatalf("fixture count = %d, want 3", len(paths))
	}

	categories := map[Category]int{}
	for _, path := range paths {
		source, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		records, parseErr := ParseJSONL(source, DefaultMaxRecordBytes)
		_ = source.Close()
		if parseErr != nil {
			t.Fatalf("parse %s: %v", path, parseErr)
		}
		for _, record := range records {
			categories[record.Category]++
		}
	}
	for _, category := range []Category{CategoryMessage, CategoryTool, CategoryApproval, CategoryInterrupt, CategoryReconnect, CategoryArtifact, CategoryUnknown} {
		if categories[category] == 0 {
			t.Fatalf("fixture category %q is missing: %#v", category, categories)
		}
	}
}

func TestUnknownFixtureRoundTripsExactJSONAndFields(t *testing.T) {
	path := filepath.Join(repositoryRoot(t), "fixtures", "codex", "samples", "unknown-event.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	line := bytes.TrimSpace(bytes.Split(data, []byte("\n"))[0])
	record, err := Decode(line)
	if err != nil {
		t.Fatal(err)
	}
	if record.Category != CategoryUnknown || record.Method != "item/futureRenderer/v9" {
		t.Fatalf("unknown record indexes = %#v", record)
	}
	encoded, err := Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, line) {
		t.Fatalf("raw JSON changed:\n got %s\nwant %s", encoded, line)
	}
	var payload map[string]any
	if err := json.Unmarshal(record.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	params := payload["params"].(map[string]any)
	future := params["xFutureField"].(map[string]any)
	if future["nested"] != "preserve-me" {
		t.Fatalf("unknown nested field = %#v", future)
	}
}

func TestContentPreservesPayloadWithoutExecutingIt(t *testing.T) {
	input := `{"schema":"loomhelm.codex.fixture/v1","source":"test","stream":"app-server","sequence":1,"payload":{"method":"item/futureRenderer/v9","html":"<script>throw new Error('must not run')</script>"}}`
	record, err := Decode([]byte(input))
	if err != nil {
		t.Fatal(err)
	}
	if record.Category != CategoryUnknown || !bytes.Contains(record.Payload, []byte("<script>")) || !bytes.Contains(record.RawJSON, []byte("must not run")) {
		t.Fatalf("payload was not retained safely: %#v", record)
	}
}

func TestParseJSONLPreservesRawLineWhitespace(t *testing.T) {
	line := `  {"schema":"loomhelm.codex.fixture/v1","source":"test","stream":"app-server","sequence":1,"payload":{"method":"item/futureRenderer/v9"}}  `
	records, err := ParseJSONL(strings.NewReader(line+"\n"), len(line))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !bytes.Equal(records[0].RawJSON, []byte(line)) {
		t.Fatalf("raw JSON = %q, want %q", records[0].RawJSON, line)
	}
	encoded, err := Encode(records[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, []byte(line)) {
		t.Fatalf("encoded JSON = %q, want %q", encoded, line)
	}
}

func TestDecodeAndParseRejectMalformedOrOversizedRecords(t *testing.T) {
	for name, input := range map[string]string{
		"wrong schema":  `{"schema":"other","source":"test","stream":"app-server","sequence":1,"payload":{}}`,
		"wrong stream":  `{"schema":"loomhelm.codex.fixture/v1","source":"test","stream":"private","sequence":1,"payload":{}}`,
		"array payload": `{"schema":"loomhelm.codex.fixture/v1","source":"test","stream":"app-server","sequence":1,"payload":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Decode([]byte(input)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("decode error = %v, want %v", err, ErrInvalid)
			}
		})
	}
	if _, err := ParseJSONL(strings.NewReader(strings.Repeat("x", 128)), 32); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized parse error = %v, want %v", err, ErrTooLarge)
	}
	if _, err := ParseJSONL(strings.NewReader(`{"schema":"loomhelm.codex.fixture/v1","source":"test","stream":"app-server","sequence":2,"payload":{}}`), 128); !errors.Is(err, ErrInvalid) {
		t.Fatalf("sequence parse error = %v, want %v", err, ErrInvalid)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller unavailable")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
}
