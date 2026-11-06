package runs

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

// Cursor is an exclusive, session-bound position in the durable Run history.
// Binding the session identity into the opaque value prevents a cursor from
// being reused across sessions while retaining the SQL keyset ordering.
type Cursor struct {
	Version   int
	SessionID string
	CreatedAt time.Time
	ID        string
}

func EncodeCursor(cursor Cursor) string {
	payload := cursor.SessionID + "\x00" + cursor.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x00" + cursor.ID
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func DecodeCursor(raw string) (Cursor, error) {
	if strings.TrimSpace(raw) == "" {
		return Cursor{}, fmt.Errorf("%w: run cursor is required", auth.ErrInvalid)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: run cursor is not base64url", auth.ErrInvalid)
	}
	parts := strings.Split(string(decoded), "\x00")
	if len(parts) != 3 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" || strings.TrimSpace(parts[2]) == "" {
		return Cursor{}, fmt.Errorf("%w: run cursor is malformed", auth.ErrInvalid)
	}
	if strings.ContainsRune(parts[0], '\x00') || strings.ContainsRune(parts[2], '\x00') {
		return Cursor{}, fmt.Errorf("%w: run cursor is malformed", auth.ErrInvalid)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[1])
	if err != nil || createdAt.IsZero() {
		return Cursor{}, fmt.Errorf("%w: run cursor timestamp is malformed", auth.ErrInvalid)
	}
	return Cursor{Version: 1, SessionID: parts[0], CreatedAt: createdAt, ID: parts[2]}, nil
}
