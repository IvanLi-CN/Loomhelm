package projects

import (
	"errors"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

func TestCursorRoundTrip(t *testing.T) {
	want := Cursor{CreatedAt: time.Date(2026, 10, 21, 12, 34, 56, 789, time.FixedZone("CST", 8*60*60)), ID: "project_123"}
	got, err := DecodeCursor(EncodeCursor(want))
	if err != nil {
		t.Fatalf("DecodeCursor() error = %v", err)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) || got.ID != want.ID {
		t.Fatalf("cursor = %+v, want %+v", got, want)
	}
}

func TestDecodeCursorRejectsMalformedInput(t *testing.T) {
	for _, raw := range []string{"not-base64", "YQ", "MjAyNi0xMC0yMVQxMjozNDo1Nlo", "MjAyNi0xMC0yMVQxMjozNDo1NlowcHJvamVjdA"} {
		if _, err := DecodeCursor(raw); !errors.Is(err, auth.ErrInvalid) {
			t.Fatalf("DecodeCursor(%q) error = %v, want ErrInvalid", raw, err)
		}
	}
}
