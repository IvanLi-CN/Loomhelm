package approvals

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

const (
	DefaultPageSize = 50
	MaxPageSize     = 200
)

// Cursor is an exclusive, run-bound position in the durable approval list.
// The run identity prevents a cursor copied from one run from being reused for
// another run while retaining the same keyset ordering as the SQL query.
type Cursor struct {
	RunID     string
	CreatedAt time.Time
	ID        string
}

func EncodeCursor(cursor Cursor) string {
	payload := cursor.RunID + "\x00" + cursor.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x00" + cursor.ID
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func DecodeCursor(raw string) (Cursor, error) {
	if strings.TrimSpace(raw) == "" {
		return Cursor{}, fmt.Errorf("%w: approval cursor is required", auth.ErrInvalid)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: approval cursor is not base64url", auth.ErrInvalid)
	}
	parts := strings.Split(string(decoded), "\x00")
	if len(parts) != 3 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[2]) == "" {
		return Cursor{}, fmt.Errorf("%w: approval cursor is malformed", auth.ErrInvalid)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[1])
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: approval cursor timestamp is malformed", auth.ErrInvalid)
	}
	return Cursor{RunID: parts[0], CreatedAt: createdAt, ID: parts[2]}, nil
}
