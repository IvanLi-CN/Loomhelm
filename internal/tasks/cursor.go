package tasks

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
)

type Cursor struct {
	CreatedAt time.Time
	ID        string
}

func EncodeCursor(cursor Cursor) string {
	payload := cursor.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x00" + cursor.ID
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func DecodeCursor(raw string) (Cursor, error) {
	if strings.TrimSpace(raw) == "" {
		return Cursor{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: cursor is not base64url", auth.ErrInvalid)
	}
	parts := strings.SplitN(string(decoded), "\x00", 2)
	if len(parts) != 2 || parts[1] == "" {
		return Cursor{}, fmt.Errorf("%w: cursor is malformed", auth.ErrInvalid)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: cursor timestamp is malformed", auth.ErrInvalid)
	}
	return Cursor{CreatedAt: createdAt, ID: parts[1]}, nil
}
