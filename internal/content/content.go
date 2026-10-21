// Package content preserves and classifies the bounded basic Codex content
// contract used by the R02 fixtures. It does not execute or render payloads.
package content

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const (
	FixtureSchema         = "loomhelm.codex.fixture/v1"
	DefaultMaxRecordBytes = 4 << 20
)

var (
	ErrInvalid  = errors.New("invalid Codex content")
	ErrTooLarge = errors.New("Codex content record exceeds the configured size limit")
)

type Category string

const (
	CategoryMessage   Category = "message"
	CategoryTool      Category = "tool"
	CategoryApproval  Category = "approval"
	CategoryReconnect Category = "reconnect"
	CategoryInterrupt Category = "interrupt"
	CategoryLifecycle Category = "lifecycle"
	CategoryRPC       Category = "rpc"
	CategoryArtifact  Category = "artifact"
	CategoryUnknown   Category = "unknown"
)

// Record exposes derived indexes alongside the exact envelope and payload
// bytes. RawJSON is returned unchanged by Encode, so unknown fields survive
// a decode/encode cycle without being interpreted by this package.
type Record struct {
	Schema   string
	Source   string
	Stream   protocol.EventSource
	Sequence int64
	Payload  json.RawMessage
	RawJSON  json.RawMessage
	Method   string
	ItemType string
	Category Category
}

func Decode(data []byte) (Record, error) {
	if len(data) == 0 {
		return Record{}, fmt.Errorf("content record is empty: %w", ErrInvalid)
	}
	var envelope struct {
		Schema   string               `json:"schema"`
		Source   string               `json:"source"`
		Stream   protocol.EventSource `json:"stream"`
		Sequence int64                `json:"sequence"`
		Payload  json.RawMessage      `json:"payload"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Record{}, fmt.Errorf("decode content record: %w", ErrInvalid)
	}
	if envelope.Schema != FixtureSchema || envelope.Source == "" || !validStream(envelope.Stream) || envelope.Sequence < 1 {
		return Record{}, fmt.Errorf("content envelope has invalid schema, source, stream, or sequence: %w", ErrInvalid)
	}
	if !isJSONObject(envelope.Payload) {
		return Record{}, fmt.Errorf("content payload must be a JSON object: %w", ErrInvalid)
	}
	method, itemType, category := classify(envelope.Payload, envelope.Stream)
	return Record{
		Schema:   envelope.Schema,
		Source:   envelope.Source,
		Stream:   envelope.Stream,
		Sequence: envelope.Sequence,
		Payload:  cloneBytes(envelope.Payload),
		RawJSON:  cloneBytes(data),
		Method:   method,
		ItemType: itemType,
		Category: category,
	}, nil
}

func Encode(record Record) ([]byte, error) {
	if len(record.RawJSON) != 0 {
		decoded, err := Decode(record.RawJSON)
		if err != nil {
			return nil, err
		}
		return cloneBytes(decoded.RawJSON), nil
	}
	if record.Schema == "" {
		record.Schema = FixtureSchema
	}
	if record.Schema != FixtureSchema || record.Source == "" || !validStream(record.Stream) || record.Sequence < 1 || !isJSONObject(record.Payload) {
		return nil, fmt.Errorf("content record is incomplete: %w", ErrInvalid)
	}
	value := struct {
		Schema   string               `json:"schema"`
		Source   string               `json:"source"`
		Stream   protocol.EventSource `json:"stream"`
		Sequence int64                `json:"sequence"`
		Payload  json.RawMessage      `json:"payload"`
	}{record.Schema, record.Source, record.Stream, record.Sequence, record.Payload}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode content record: %w", err)
	}
	return encoded, nil
}

// ParseJSONL decodes a bounded JSONL stream and preserves each source line.
// Sequence numbers are required to be contiguous, matching the R02 parser.
func ParseJSONL(source io.Reader, maxRecordBytes int) ([]Record, error) {
	if source == nil {
		return nil, fmt.Errorf("content source must not be nil: %w", ErrInvalid)
	}
	if maxRecordBytes == 0 {
		maxRecordBytes = DefaultMaxRecordBytes
	}
	if maxRecordBytes < 1 {
		return nil, fmt.Errorf("content size limit must be positive: %w", ErrInvalid)
	}
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 1024), maxRecordBytes+1)
	records := make([]Record, 0)
	expectedSequence := int64(1)
	for scanner.Scan() {
		rawLine := scanner.Bytes()
		line := bytes.TrimSpace(rawLine)
		if len(line) == 0 {
			continue
		}
		if len(rawLine) > maxRecordBytes {
			return nil, ErrTooLarge
		}
		record, err := Decode(rawLine)
		if err != nil {
			return nil, fmt.Errorf("decode content sequence %d: %w", expectedSequence, err)
		}
		if record.Sequence != expectedSequence {
			return nil, fmt.Errorf("content sequence is %d, want %d: %w", record.Sequence, expectedSequence, ErrInvalid)
		}
		expectedSequence++
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return nil, ErrTooLarge
		}
		return nil, fmt.Errorf("read content stream: %w", err)
	}
	return records, nil
}

func classify(payload json.RawMessage, stream protocol.EventSource) (string, string, Category) {
	value := map[string]json.RawMessage{}
	if err := json.Unmarshal(payload, &value); err != nil {
		return "", "", CategoryUnknown
	}
	method := rawString(value["method"])
	params := rawObject(value["params"])
	item := rawObject(params["item"])
	if item == nil {
		item = rawObject(value["item"])
	}
	itemType := rawString(item["type"])
	turn := rawObject(params["turn"])
	if turn == nil {
		turn = rawObject(value["turn"])
	}
	event := rawString(value["event"])

	if stream == protocol.EventSourceArtifact || method == "turn/diff/updated" || itemType == "fileChange" || itemType == "artifact" {
		return method, itemType, CategoryArtifact
	}
	lowerEvent := strings.ToLower(event)
	if stream == protocol.EventSourceHostObservation && (strings.Contains(lowerEvent, "disconnect") || strings.Contains(lowerEvent, "reconnect") || strings.Contains(lowerEvent, "resume")) {
		return method, itemType, CategoryReconnect
	}
	if method == "turn/interrupt" || rawString(turn["status"]) == "interrupted" {
		return method, itemType, CategoryInterrupt
	}
	if method == "thread/resume" || method == "thread/read" || method == "thread/turns/list" {
		return method, itemType, CategoryReconnect
	}
	if strings.HasSuffix(strings.ToLower(method), "requestapproval") || method == "serverRequest/resolved" || method == "tool/requestUserInput" {
		return method, itemType, CategoryApproval
	}
	if method == "item/agentMessage/delta" || itemType == "agentMessage" || itemType == "userMessage" {
		return method, itemType, CategoryMessage
	}
	if itemType == "commandExecution" || itemType == "mcpToolCall" || itemType == "dynamicToolCall" || itemType == "collabToolCall" || itemType == "webSearch" || strings.Contains(method, "commandExecution") || method == "item/tool/call" {
		return method, itemType, CategoryTool
	}
	if strings.HasPrefix(method, "thread/") || strings.HasPrefix(method, "turn/") || method == "item/started" || method == "item/completed" {
		return method, itemType, CategoryLifecycle
	}
	if value["result"] != nil || value["error"] != nil {
		return method, itemType, CategoryRPC
	}
	return method, itemType, CategoryUnknown
}

func validStream(stream protocol.EventSource) bool {
	switch stream {
	case protocol.EventSourceAppServer, protocol.EventSourceHostObservation, protocol.EventSourceArtifact:
		return true
	default:
		return false
	}
}

func isJSONObject(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) > 1 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

func rawObject(value json.RawMessage) map[string]json.RawMessage {
	if !isJSONObject(value) {
		return nil
	}
	result := map[string]json.RawMessage{}
	if json.Unmarshal(value, &result) != nil {
		return nil
	}
	return result
}

func rawString(value json.RawMessage) string {
	var result string
	if len(value) == 0 || json.Unmarshal(value, &result) != nil {
		return ""
	}
	return result
}

func cloneBytes(value []byte) []byte {
	return append([]byte(nil), value...)
}
