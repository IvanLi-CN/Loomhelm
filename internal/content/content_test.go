package content

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
	if _, err := ParseJSONL(strings.NewReader("{}"), DefaultMaxRecordBytes+1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized configured record limit error = %v, want %v", err, ErrInvalid)
	}
	if _, err := Decode(bytes.Repeat([]byte("x"), DefaultMaxRecordBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized decode error = %v, want %v", err, ErrTooLarge)
	}
	payload := json.RawMessage(fmt.Sprintf(`{"blob":%q}`, strings.Repeat("x", DefaultMaxRecordBytes-64)))
	if len(payload) >= DefaultMaxRecordBytes {
		t.Fatalf("test payload = %d bytes, want less than %d", len(payload), DefaultMaxRecordBytes)
	}
	if _, err := Encode(Record{Source: "test", Stream: "app-server", Sequence: 1, Payload: payload}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized encoded record error = %v, want %v", err, ErrTooLarge)
	}
}

func TestContentBatchLimitsRejectWithoutTruncation(t *testing.T) {
	blankLine := append(bytes.Repeat([]byte{' '}, DefaultMaxRecordBytes-1), '\n')
	exactBatch := bytes.Repeat(blankLine, DefaultMaxBatchBytes/DefaultMaxRecordBytes)
	if records, err := ParseJSONL(bytes.NewReader(exactBatch), DefaultMaxRecordBytes); err != nil || len(records) != 0 {
		t.Fatalf("exact consumed batch boundary = %d records, err=%v", len(records), err)
	}
	batch := bytes.Repeat(blankLine, DefaultMaxBatchBytes/(DefaultMaxRecordBytes)+1)
	if _, err := ParseJSONL(bytes.NewReader(batch), DefaultMaxRecordBytes); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized consumed batch error = %v, want %v", err, ErrTooLarge)
	}

	var records bytes.Buffer
	for sequence := 1; sequence <= MaxBatchRecords; sequence++ {
		records.WriteString(contentLine(int64(sequence)))
	}
	parsed, err := ParseJSONL(bytes.NewReader(records.Bytes()), DefaultMaxRecordBytes)
	if err != nil || len(parsed) != MaxBatchRecords {
		t.Fatalf("exact record-count boundary = %d records, err=%v", len(parsed), err)
	}
	records.Reset()
	for sequence := 1; sequence <= MaxBatchRecords+1; sequence++ {
		records.WriteString(contentLine(int64(sequence)))
	}
	if _, err := ParseJSONL(bytes.NewReader(records.Bytes()), DefaultMaxRecordBytes); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized record-count batch error = %v, want %v", err, ErrTooLarge)
	}
}

func TestContentRuntimeParserClosesBlockedInputOnCancellation(t *testing.T) {
	source := newBlockingContentSource()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := ParseJSONLContext(ctx, source, DefaultMaxRecordBytes)
		result <- err
	}()
	select {
	case <-source.started:
	case <-time.After(2 * time.Second):
		t.Fatal("runtime parser did not start reading")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("runtime cancellation error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runtime parser did not return after cancellation")
	}
	if got := source.closeCount.Load(); got != 1 {
		t.Fatalf("runtime source close count = %d, want 1", got)
	}
}

func TestContentRuntimeParserClosesPreCanceledInput(t *testing.T) {
	source := newBlockingContentSource()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ParseJSONLContext(ctx, source, DefaultMaxRecordBytes); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled parser error = %v, want %v", err, context.Canceled)
	}
	if got := source.closeCount.Load(); got != 1 {
		t.Fatalf("pre-cancelled source close count = %d, want 1", got)
	}
}

func TestContentRuntimeParserDoesNotLeakReaderErrors(t *testing.T) {
	secretPath := "/private/fixture/secret.jsonl"
	source := &errorContentSource{err: errors.New(secretPath)}
	_, err := ParseJSONLContext(context.Background(), source, DefaultMaxRecordBytes)
	if !errors.Is(err, ErrInvalid) || strings.Contains(err.Error(), secretPath) {
		t.Fatalf("reader error = %v, want redacted invalid error", err)
	}
}

func contentLine(sequence int64) string {
	return fmt.Sprintf(`{"schema":"%s","source":"test","stream":"app-server","sequence":%d,"payload":{"method":"item/futureRenderer/v9"}}`, FixtureSchema, sequence) + "\n"
}

type blockingContentSource struct {
	started    chan struct{}
	release    chan struct{}
	startOnce  sync.Once
	closeOnce  sync.Once
	closeCount atomic.Int32
}

func newBlockingContentSource() *blockingContentSource {
	return &blockingContentSource{started: make(chan struct{}), release: make(chan struct{})}
}

func (s *blockingContentSource) Read([]byte) (int, error) {
	s.startOnce.Do(func() { close(s.started) })
	<-s.release
	return 0, io.EOF
}

func (s *blockingContentSource) Close() error {
	s.closeCount.Add(1)
	s.closeOnce.Do(func() { close(s.release) })
	return nil
}

type errorContentSource struct{ err error }

func (s *errorContentSource) Read([]byte) (int, error) { return 0, s.err }

func (s *errorContentSource) Close() error { return nil }

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller unavailable")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
}
