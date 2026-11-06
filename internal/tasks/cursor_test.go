package tasks

import (
	"errors"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

func TestCursorRoundTrip(t *testing.T) {
	want := Cursor{CreatedAt: time.Date(2026, 10, 21, 12, 34, 56, 789, time.UTC), ID: "task_123"}
	got, err := DecodeCursor(EncodeCursor(want))
	if err != nil {
		t.Fatalf("DecodeCursor() error = %v", err)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) || got.ID != want.ID {
		t.Fatalf("cursor = %+v, want %+v", got, want)
	}
}

func TestValidStatus(t *testing.T) {
	for _, status := range []Status{StatusTodo, StatusInProgress, StatusBlocked, StatusDone, StatusCancelled} {
		if !validStatus(status) {
			t.Errorf("validStatus(%q) = false", status)
		}
	}
	if validStatus(Status("unknown")) {
		t.Error("validStatus(unknown) = true")
	}
}

func TestDecodeCursorRejectsMalformedInput(t *testing.T) {
	for _, raw := range []string{"not-base64", "YQ", "MjAyNi0xMC0yMVQxMjozNDo1Nlo", "MjAyNi0xMC0yMVQxMjozNDo1NlowdGFza1g"} {
		if _, err := DecodeCursor(raw); !errors.Is(err, auth.ErrInvalid) {
			t.Fatalf("DecodeCursor(%q) error = %v, want ErrInvalid", raw, err)
		}
	}
}
