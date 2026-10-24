package hosts

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestValidateCursorBounds(t *testing.T) {
	valid := Cursor{
		SessionID: strings.Repeat("s", MaxCursorIDBytes),
		RunID:     strings.Repeat("r", MaxCursorIDBytes),
		Value:     "cursor",
	}
	if err := validateCursor(valid); err != nil {
		t.Fatalf("validateCursor(valid) error = %v", err)
	}
	for name, cursor := range map[string]Cursor{
		"session id": {SessionID: strings.Repeat("s", MaxCursorIDBytes+1), Value: "cursor"},
		"run id":     {SessionID: "session", RunID: strings.Repeat("r", MaxCursorIDBytes+1), Value: "cursor"},
		"value":      {SessionID: "session", Value: strings.Repeat("v", MaxCursorValueBytes+1)},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateCursor(cursor); !errors.Is(err, ErrInvalid) {
				t.Fatalf("validateCursor() error = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestRecoveryPayloadCountsJSONEscaping(t *testing.T) {
	base := Cursor{
		SessionID:     "session",
		Value:         "cursor",
		ObservedAt:    time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC),
		RetainedUntil: time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC),
	}
	plain := base
	plain.Value = strings.Repeat("x", 128)
	escaped := base
	escaped.Value = strings.Repeat(`\`, 128)
	plainSize, err := recoveryPayloadSize([]Cursor{plain})
	if err != nil {
		t.Fatalf("recoveryPayloadSize(plain) error = %v", err)
	}
	escapedSize, err := recoveryPayloadSize([]Cursor{escaped})
	if err != nil {
		t.Fatalf("recoveryPayloadSize(escaped) error = %v", err)
	}
	if escapedSize <= plainSize {
		t.Fatalf("escaped recovery payload size = %d, plain size = %d; JSON escaping was not counted", escapedSize, plainSize)
	}
}
