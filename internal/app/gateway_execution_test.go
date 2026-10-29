package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/events"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
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

func TestNormalizeGatewayApprovalAcceptsNativeApprovalPayload(t *testing.T) {
	runID := "run-platform-native"
	event := protocol.Event{
		EventID:    "event-approval-native",
		OccurredAt: "2026-10-25T06:00:00Z",
		Payload:    json.RawMessage(`{"jsonrpc":"2.0","id":41,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-native","turnId":"turn-native","item":{"id":"item-native","type":"commandExecution","command":"/bin/zsh -lc 'printf ok'"}}}`),
		RunID:      &runID,
		SessionID:  "session-native",
		Type:       protocol.EventTypeApprovalRequested,
	}

	request, err := normalizeGatewayApproval(event, "generation-native")
	if err != nil {
		t.Fatalf("normalizeGatewayApproval() error = %v", err)
	}
	if request.ID == "41" || request.RunID != runID || request.SessionID != event.SessionID || request.Generation != "generation-native" {
		t.Fatalf("normalized native approval identity = %+v", request.NewInput)
	}
	nativeRequestID, ok := connectorruntime.DecodeScopedNativeApprovalID(request.ID, event.SessionID, "generation-native")
	if !ok || string(nativeRequestID) != "41" {
		t.Fatalf("normalized native approval scope = %q, decoded = %s, found = %v", request.ID, nativeRequestID, ok)
	}
	if request.Kind != "command" || request.Revision != 1 || request.Summary != "/bin/zsh -lc 'printf ok'" {
		t.Fatalf("normalized native approval metadata = %+v", request.NewInput)
	}
	var contextPayload map[string]json.RawMessage
	if err := json.Unmarshal(request.Context, &contextPayload); err != nil || contextPayload["turnId"] == nil {
		t.Fatalf("native approval context = %s, error = %v", request.Context, err)
	}
}

func TestNormalizeNativeApprovalScopesSessionGenerationAndJSONType(t *testing.T) {
	runID := "run-platform-native-scope"
	base := protocol.Event{
		EventID:    "event-approval-native-scope",
		OccurredAt: "2026-10-25T06:00:00Z",
		SessionID:  "session-native-scope",
		RunID:      &runID,
		Type:       protocol.EventTypeApprovalRequested,
	}
	makeEvent := func(eventID, session, rawID string) protocol.Event {
		event := base
		event.EventID = eventID
		event.SessionID = session
		event.Payload = json.RawMessage(`{"jsonrpc":"2.0","id":` + rawID + `,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-native-scope","item":{"type":"commandExecution"}}}`)
		return event
	}
	numeric, err := normalizeGatewayApproval(makeEvent("numeric", "session-native-scope", "41"), "generation-native-scope")
	if err != nil {
		t.Fatal(err)
	}
	stringID, err := normalizeGatewayApproval(makeEvent("string", "session-native-scope", `"41"`), "generation-native-scope")
	if err != nil {
		t.Fatal(err)
	}
	otherSession, err := normalizeGatewayApproval(makeEvent("other-session", "session-other", "41"), "generation-native-scope")
	if err != nil {
		t.Fatal(err)
	}
	if numeric.ID == stringID.ID || numeric.ID == otherSession.ID || stringID.ID == otherSession.ID {
		t.Fatalf("scoped approval IDs collided: numeric=%q string=%q other_session=%q", numeric.ID, stringID.ID, otherSession.ID)
	}
	if decoded, ok := connectorruntime.DecodeScopedNativeApprovalID(numeric.ID, "session-native-scope", "generation-native-scope"); !ok || string(decoded) != "41" {
		t.Fatalf("numeric native request reverse mapping = %s, found = %v", decoded, ok)
	}
}

func TestNativeApprovalIDRejectsNonScalarValues(t *testing.T) {
	for _, raw := range []string{`true`, `[]`, `{}`, `null`, `""`} {
		if _, err := nativeApprovalID(json.RawMessage(raw)); err == nil {
			t.Fatalf("nativeApprovalID(%s) unexpectedly succeeded", raw)
		}
	}
	for _, raw := range []string{`41`, `"41"`} {
		got, err := nativeApprovalID(json.RawMessage(raw))
		if err != nil || got != "41" {
			t.Fatalf("nativeApprovalID(%s) = %q, error = %v", raw, got, err)
		}
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

func TestAcknowledgePendingSessionCreatedRequiresMatchingPendingHost(t *testing.T) {
	event := protocol.Event{Type: protocol.EventTypeSessionCreated}
	connection := hosts.Connection{HostID: "host-1"}
	tests := []struct {
		name   string
		access sessions.SessionAccess
		want   bool
	}{
		{
			name: "matching pending host",
			access: sessions.SessionAccess{
				HostID:      "host-1",
				IntentState: sessions.IntentStatePending,
			},
			want: true,
		},
		{
			name: "different host",
			access: sessions.SessionAccess{
				HostID:      "host-2",
				IntentState: sessions.IntentStatePending,
			},
		},
		{
			name: "confirmed session",
			access: sessions.SessionAccess{
				HostID:      "host-1",
				IntentState: sessions.IntentStateConfirmed,
				Confirmed:   true,
			},
		},
		{
			name: "unknown intent",
			access: sessions.SessionAccess{
				HostID:      "host-1",
				IntentState: sessions.IntentStateUnknown,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := acknowledgePendingSessionCreated(test.access, connection, event); got != test.want {
				t.Fatalf("acknowledgePendingSessionCreated() = %t, want %t", got, test.want)
			}
		})
	}
}

type recordingGatewayEventAppender struct {
	event events.AppendResult
	calls int
	err   error
}

func (a *recordingGatewayEventAppender) Append(_ context.Context, event protocol.Event) (events.AppendResult, error) {
	a.calls++
	a.event.Event = event
	return a.event, a.err
}

func TestPersistPendingSessionCreatedBeforeHostCursorAck(t *testing.T) {
	appender := &recordingGatewayEventAppender{}
	event := protocol.Event{
		EventID:   "session-created-before-ack",
		SessionID: "pending-session",
		Sequence:  41,
		Cursor:    "adapter-cursor-41",
		Type:      protocol.EventTypeSessionCreated,
		Payload:   json.RawMessage(`{"thread":"native-thread"}`),
	}
	if err := persistPendingSessionCreated(context.Background(), appender, event); err != nil {
		t.Fatal(err)
	}
	if appender.calls != 1 || appender.event.Event.Sequence != 0 || appender.event.Event.EventID != event.EventID || string(appender.event.Event.Payload) != string(event.Payload) {
		t.Fatalf("pending session-created persistence = %+v, calls = %d", appender.event.Event, appender.calls)
	}
}

func TestGatewayEventRunRequirementAllowsSessionLifecycleEvents(t *testing.T) {
	for _, eventType := range []protocol.EventType{
		protocol.EventTypeSessionCreated,
		protocol.EventTypeSessionAttached,
		protocol.EventTypeReconciliationRequired,
		protocol.EventTypeReconciliationCompleted,
	} {
		if gatewayEventRequiresRun(eventType) {
			t.Fatalf("gateway event %q unexpectedly requires a platform run", eventType)
		}
	}
	if !gatewayEventRequiresRun(protocol.EventTypeRunStarted) {
		t.Fatal("run.started did not require a platform run")
	}
}
