package runs

import (
	"errors"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

func TestRunCursorRoundTripBindsSession(t *testing.T) {
	createdAt := time.Date(2026, 10, 29, 8, 30, 0, 123456789, time.FixedZone("CST", 8*60*60))
	original := Cursor{Version: 1, SessionID: "session-1", CreatedAt: createdAt, ID: "run-2"}

	decoded, err := DecodeCursor(EncodeCursor(original))
	if err != nil {
		t.Fatalf("DecodeCursor() error = %v", err)
	}
	if decoded.Version != 1 || decoded.SessionID != original.SessionID || decoded.ID != original.ID || !decoded.CreatedAt.Equal(createdAt) {
		t.Fatalf("decoded cursor = %+v, want %+v", decoded, original)
	}
}

func TestDecodeRunCursorRejectsMalformedValues(t *testing.T) {
	for _, raw := range []string{"", "not-base64", EncodeCursor(Cursor{SessionID: "session-1", ID: "run-1"})} {
		if _, err := DecodeCursor(raw); !errors.Is(err, auth.ErrInvalid) {
			t.Errorf("DecodeCursor(%q) error = %v, want auth.ErrInvalid", raw, err)
		}
	}
}
