package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestNormalizeGatewayApprovalUsesPlatformRunIdentity(t *testing.T) {
	runID := "run-platform-1"
	event := protocol.Event{
		EventID:    "event-approval-1",
		OccurredAt: "2026-10-25T06:00:00Z",
		Payload:    json.RawMessage(`{"approval_id":"approval-1","kind":"command","summary":"Approve fixture","revision":2,"requested_at":"2026-10-25T06:00:01Z","context":{"source":"fixture"},"future_field":"preserve"}`),
		RunID:      &runID,
		SessionID:  "session-1",
		Type:       protocol.EventTypeApprovalRequested,
	}

	request, err := normalizeGatewayApproval(event, "generation-1")
	if err != nil {
		t.Fatalf("normalizeGatewayApproval() error = %v", err)
	}
	if request.ID != "approval-1" || request.RunID != runID || request.SessionID != event.SessionID || request.Generation != "generation-1" {
		t.Fatalf("normalized approval identity = %+v", request.NewInput)
	}
	if request.RequestedEventID != event.EventID || request.Revision != 2 || string(request.Context) != `{"source":"fixture"}` {
		t.Fatalf("normalized approval metadata = %+v", request)
	}
}

func TestNormalizeGatewayApprovalRejectsExternalTurnIdentity(t *testing.T) {
	runID := "run-platform-1"
	_, err := normalizeGatewayApproval(protocol.Event{
		EventID:    "event-approval-1",
		OccurredAt: "2026-10-25T06:00:00Z",
		Payload:    json.RawMessage(`{"approval_id":"approval-1","kind":"command","revision":1,"turn_id":"turn-external-1"}`),
		RunID:      &runID,
		SessionID:  "session-1",
		Type:       protocol.EventTypeApprovalRequested,
	}, "generation-1")
	if !errors.Is(err, hosts.ErrInvalid) || !strings.Contains(err.Error(), "turn_id") {
		t.Fatalf("external turn identity error = %v", err)
	}
}

func TestGatewayExecutionReconcileIsExplicitlyUnknown(t *testing.T) {
	observedAt := time.Date(2026, 10, 25, 6, 0, 0, 0, time.UTC)
	transport := &gatewayExecutionTransport{now: func() time.Time { return observedAt }}
	reconciliation, err := transport.ReconcileCommand(context.Background(), protocol.Command{CommandID: "command-1"})
	if err != nil {
		t.Fatalf("ReconcileCommand() error = %v", err)
	}
	if reconciliation.CommandID != "command-1" || reconciliation.State != protocol.ReconciliationStateUnknown || reconciliation.Note == nil || *reconciliation.Note != "Connector WSS has no command reconciliation frame" {
		t.Fatalf("reconciliation = %+v", reconciliation)
	}
	if reconciliation.ObservedAt != observedAt.Format(time.RFC3339Nano) {
		t.Fatalf("reconciliation observed_at = %q", reconciliation.ObservedAt)
	}
}
