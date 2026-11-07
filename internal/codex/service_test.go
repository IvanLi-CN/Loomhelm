package codex

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestConversationCursorRoundTripPreservesSnapshotFence(t *testing.T) {
	cursor := conversationCursor{
		UpdatedAt:    time.Date(2026, time.November, 7, 8, 9, 10, 123456789, time.UTC),
		ThreadID:     "thread-101",
		SnapshotAsOf: time.Date(2026, time.November, 7, 8, 0, 0, 0, time.UTC),
	}

	decoded := decodeConversationCursor(encodeConversationCursor(cursor))
	if decoded == nil {
		t.Fatal("decodeConversationCursor() returned nil")
	}
	if !decoded.UpdatedAt.Equal(cursor.UpdatedAt) || decoded.ThreadID != cursor.ThreadID || !decoded.SnapshotAsOf.Equal(cursor.SnapshotAsOf) {
		t.Fatalf("decoded cursor = %+v, want %+v", *decoded, cursor)
	}
}

func TestConversationCursorDecodeAcceptsLegacyCursorWithoutSnapshotFence(t *testing.T) {
	data, err := json.Marshal(map[string]string{
		"updated_at": "2026-11-07T08:09:10.123456789Z",
		"thread_id":  "thread-legacy",
	})
	if err != nil {
		t.Fatalf("marshal legacy cursor: %v", err)
	}

	decoded := decodeConversationCursor(base64.RawURLEncoding.EncodeToString(data))
	if decoded == nil {
		t.Fatal("decodeConversationCursor() rejected a legacy cursor")
	}
	if decoded.ThreadID != "thread-legacy" || !decoded.SnapshotAsOf.IsZero() {
		t.Fatalf("decoded legacy cursor = %+v", *decoded)
	}
}
