package approvals

import (
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

func TestCursorRoundTripPreservesRunBoundPosition(t *testing.T) {
	want := Cursor{
		RunID:     "run-1",
		CreatedAt: time.Date(2026, 10, 25, 12, 34, 56, 789000000, time.FixedZone("test", 8*60*60)),
		ID:        "approval-1",
	}
	got, err := DecodeCursor(EncodeCursor(want))
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if got.RunID != want.RunID || !got.CreatedAt.Equal(want.CreatedAt) || got.ID != want.ID {
		t.Fatalf("decoded cursor = %+v, want %+v", got, want)
	}
	if got.Version != 1 || got.Revision != 0 {
		t.Fatalf("legacy cursor = %+v, want version 1 without revision", got)
	}
	if got.CreatedAt.Location() != time.UTC {
		t.Fatalf("decoded cursor location = %v, want UTC", got.CreatedAt.Location())
	}
}

func TestCursorV2RoundTripPreservesRevisionKey(t *testing.T) {
	want := Cursor{
		Version:   2,
		RunID:     "run-1",
		CreatedAt: time.Date(2026, 10, 25, 12, 34, 56, 789000000, time.UTC),
		ID:        "approval-1",
		Revision:  9,
	}
	got, err := DecodeCursor(EncodeCursor(want))
	if err != nil {
		t.Fatalf("decode v2 cursor: %v", err)
	}
	if got.Version != 2 || got.RunID != want.RunID || !got.CreatedAt.Equal(want.CreatedAt) || got.ID != want.ID || got.Revision != want.Revision {
		t.Fatalf("decoded v2 cursor = %+v, want %+v", got, want)
	}
}

func TestDecodeCursorRejectsMalformedAndUnboundValues(t *testing.T) {
	for _, raw := range []string{
		"",
		"not-base64",
		EncodeCursor(Cursor{CreatedAt: time.Now(), ID: "id"}),
		base64.RawURLEncoding.EncodeToString([]byte("run\x00not-time\x00id")),
	} {
		if _, err := DecodeCursor(raw); !errors.Is(err, auth.ErrInvalid) {
			t.Fatalf("decode %q error = %v, want auth.ErrInvalid", raw, err)
		}
	}
}
