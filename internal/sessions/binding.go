package sessions

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// BindingFacts are read only facts collected after the Session and Task rows
// have been locked by the binding transaction.
type BindingFacts struct {
	Session              Session
	Access               SessionAccess
	TaskProjectID        string
	CurrentTaskSessionID string
}

// BindingAuthorizer is invoked while the binding transaction owns both row
// locks. Implementations may use tx to lock authorization facts before the
// association is committed.
type BindingAuthorizer func(context.Context, pgx.Tx, BindingFacts) error
