package runs

import (
	"context"
	"time"
)

const unknownOutcomePersistenceTimeout = 5 * time.Second

// UnknownOutcomeContext creates the bounded context used to persist a command
// outcome after delivery became uncertain. It retains values from parent for
// tracing and authorization, but deliberately ignores parent cancellation and
// deadline so an aborted request cannot lose the durable unknown transition.
func UnknownOutcomeContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(context.WithoutCancel(parent), unknownOutcomePersistenceTimeout)
}
