package runs

import (
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

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
