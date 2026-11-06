package runs

import (
	"context"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestUnknownOutcomeContextRetainsValuesAfterCancellation(t *testing.T) {
	type contextKey string
	key := contextKey("request-id")
	parent, cancelParent := context.WithCancel(context.WithValue(context.Background(), key, "request-1"))
	cancelParent()

	derived, cancelDerived := UnknownOutcomeContext(parent)
	defer cancelDerived()
	if got := derived.Value(key); got != "request-1" {
		t.Fatalf("unknown outcome context value = %v, want request-1", got)
	}
	if err := derived.Err(); err != nil {
		t.Fatalf("unknown outcome context is already canceled: %v", err)
	}
	deadline, ok := derived.Deadline()
	if !ok || deadline.Before(time.Now()) || deadline.After(time.Now().Add(unknownOutcomePersistenceTimeout)) {
		t.Fatalf("unknown outcome context deadline = %v, want bounded deadline within %s", deadline, unknownOutcomePersistenceTimeout)
	}
}

func TestUnknownApprovalDeliveryPreservesRunControl(t *testing.T) {
	tests := []struct {
		kind      protocol.CommandKind
		preserves bool
	}{
		{kind: protocol.CommandKindRunApprove, preserves: true},
		{kind: protocol.CommandKindRunDeny, preserves: true},
		{kind: protocol.CommandKindRunSend, preserves: false},
		{kind: protocol.CommandKindRunInterrupt, preserves: false},
	}
	for _, test := range tests {
		t.Run(string(test.kind), func(t *testing.T) {
			if got := unknownCommandPreservesRun(test.kind); got != test.preserves {
				t.Fatalf("unknownCommandPreservesRun(%q) = %v, want %v", test.kind, got, test.preserves)
			}
		})
	}
}
