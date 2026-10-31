package approvals

import (
	"encoding/base64"
	"fmt"
	"strconv"
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
	Version   int
	RunID     string
	CreatedAt time.Time
	ID        string
	Revision  int64
}

func EncodeCursor(cursor Cursor) string {
	payload := cursor.RunID + "\x00" + cursor.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x00" + cursor.ID
	if cursor.Revision > 0 {
		payload = "v2\x00" + payload + "\x00" + strconv.FormatInt(cursor.Revision, 10)
	}
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
	version := 1
	var runID, createdAtRaw, id string
	var revision int64
	switch {
	case len(parts) == 3:
		runID, createdAtRaw, id = parts[0], parts[1], parts[2]
	case len(parts) == 5 && parts[0] == "v2":
		version = 2
		runID, createdAtRaw, id = parts[1], parts[2], parts[3]
		revision, err = strconv.ParseInt(parts[4], 10, 64)
		if err != nil || revision <= 0 {
			return Cursor{}, fmt.Errorf("%w: approval cursor revision is malformed", auth.ErrInvalid)
		}
	default:
		return Cursor{}, fmt.Errorf("%w: approval cursor is malformed", auth.ErrInvalid)
	}
	if strings.TrimSpace(runID) == "" || strings.TrimSpace(id) == "" || strings.ContainsRune(runID, '\x00') || strings.ContainsRune(id, '\x00') {
		return Cursor{}, fmt.Errorf("%w: approval cursor is malformed", auth.ErrInvalid)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, createdAtRaw)
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: approval cursor timestamp is malformed", auth.ErrInvalid)
	}
	return Cursor{Version: version, RunID: runID, CreatedAt: createdAt, ID: id, Revision: revision}, nil
}
