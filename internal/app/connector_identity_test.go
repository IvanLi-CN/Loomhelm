package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestConnectorIdentityMapsPlatformCommandsToNativeIdentity(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()

	connector := &Connector{journal: journal}
	gatewaySession := protocol.GatewaySession{
		Handle:     "gateway-1",
		Generation: "generation-1",
	}
	adapterSession := protocol.AdapterSession{SessionID: "adapter-1", ExternalThreadRef: "thread-1"}
	if err := connector.BindSessionIdentity("platform-session-1", "create-1", gatewaySession, adapterSession); err != nil {
		t.Fatal(err)
	}

	platformRunID := "platform-run-1"
	command := protocol.Command{
		CommandID: "run-1",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"hello"}`),
		RunID:     &platformRunID,
		SessionID: "platform-session-1",
	}
	if binding, err := connector.BeginRunIdentity(command); err != nil || binding.State != connectorruntime.IdentityStateUnknown {
		t.Fatalf("begin run identity = %+v, error = %v", binding, err)
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.SessionID != adapterSession.SessionID || prepared.RunID != nil {
		t.Fatalf("prepared initial command = %+v, want adapter session and no native run id", prepared)
	}

	nativeOperationID := "generation-1\x00rpc-1"
	if err := connector.ObserveCommandIdentity(command, protocol.CommandAck{OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	pending, ok := journal.RunBinding(command.SessionID, platformRunID)
	if !ok || pending.State != connectorruntime.IdentityStatePending || pending.NativeOperationID != nativeOperationID {
		t.Fatalf("pending run identity = %+v, found = %v", pending, ok)
	}
	interrupt := command
	interrupt.CommandID = "interrupt-before-bound"
	interrupt.Kind = protocol.CommandKindRunInterrupt
	interrupt.Payload = json.RawMessage(`{"reason":"stop"}`)
	if _, err := connector.PreparePlatformCommand(interrupt); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("pending control preparation error = %v, want unknown result", err)
	}

	nativeTurnID := "native-turn-1"
	if err := connector.ObserveCommandIdentity(command, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	bound, ok := journal.RunBinding(command.SessionID, platformRunID)
	if !ok || bound.State != connectorruntime.IdentityStateBound || bound.NativeTurnID != nativeTurnID {
		t.Fatalf("bound run identity = %+v, found = %v", bound, ok)
	}

	interrupt = command
	interrupt.CommandID = "interrupt-1"
	interrupt.Kind = protocol.CommandKindRunInterrupt
	interrupt.Payload = json.RawMessage(`{"reason":"stop"}`)
	prepared, err = connector.PreparePlatformCommand(interrupt)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.SessionID != adapterSession.SessionID || prepared.RunID == nil || *prepared.RunID != nativeTurnID {
		t.Fatalf("prepared interrupt = %+v, want native turn identity", prepared)
	}
	controlOperationID := "generation-1\x00rpc-interrupt"
	if err := connector.ObserveCommandIdentity(interrupt, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &controlOperationID}); err != nil {
		t.Fatal(err)
	}

	conflicting := interrupt
	conflicting.Payload = json.RawMessage(`{"turn_id":"another-native-turn"}`)
	if _, err := connector.PreparePlatformCommand(conflicting); !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("conflicting native target error = %v, want identity conflict", err)
	}
}

func TestConnectorIdentityFencesHistoricalGenerationControls(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-generation", "create-generation", protocol.GatewaySession{Generation: "generation-old"}, protocol.AdapterSession{SessionID: "adapter-generation", ExternalThreadRef: "thread-generation"}); err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-old"
	command := protocol.Command{CommandID: "run-generation-old", Kind: protocol.CommandKindRunSend, Payload: json.RawMessage(`{"prompt":"old"}`), RunID: &runID, SessionID: "platform-session-generation"}
	if _, err := connector.BeginRunIdentity(command); err != nil {
		t.Fatal(err)
	}
	nativeTurnID := "native-turn-reused"
	nativeOperationID := "generation-old\x00rpc-old"
	if err := connector.ObserveCommandIdentity(command, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	if err := connector.RotateSessionIdentity("platform-session-generation", "create-generation", protocol.GatewaySession{Generation: "generation-new"}, protocol.AdapterSession{SessionID: "adapter-generation", ExternalThreadRef: "thread-generation"}); err != nil {
		t.Fatal(err)
	}
	interrupt := protocol.Command{CommandID: "interrupt-old-generation", Kind: protocol.CommandKindRunInterrupt, Payload: json.RawMessage(`{"reason":"stop"}`), RunID: &runID, SessionID: "platform-session-generation"}
	if _, err := connector.PreparePlatformCommand(interrupt); !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("historical generation control error = %v, want unknown result", err)
	}

	newRunID := "platform-run-new"
	newCommand := protocol.Command{CommandID: "run-generation-new", Kind: protocol.CommandKindRunSend, Payload: json.RawMessage(`{"prompt":"new"}`), RunID: &newRunID, SessionID: "platform-session-generation"}
	if _, err := connector.BeginRunIdentity(newCommand); err != nil {
		t.Fatal(err)
	}
	newOperationID := "generation-new\x00rpc-new"
	if err := connector.ObserveCommandIdentity(newCommand, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &newOperationID}); err != nil {
		t.Fatal(err)
	}
	currentInterrupt := interrupt
	currentInterrupt.CommandID = "interrupt-current-generation"
	currentInterrupt.RunID = &newRunID
	prepared, err := connector.PreparePlatformCommand(currentInterrupt)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.RunID == nil || *prepared.RunID != nativeTurnID {
		t.Fatalf("current generation control = %+v, want native turn identity", prepared)
	}
}

func TestConnectorIdentityRedeliversDurableBoundCommandWithoutRebinding(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-dedup", "create-dedup", protocol.GatewaySession{Generation: "generation-dedup"}, protocol.AdapterSession{SessionID: "adapter-dedup", ExternalThreadRef: "thread-dedup"}); err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-dedup"
	command := protocol.Command{CommandID: "run-dedup", Kind: protocol.CommandKindRunSend, Payload: json.RawMessage(`{"prompt":"same"}`), RunID: &runID, SessionID: "platform-session-dedup"}
	if _, err := connector.BeginRunIdentity(command); err != nil {
		t.Fatal(err)
	}
	nativeTurnID := "native-turn-dedup"
	nativeOperationID := "generation-dedup\x00rpc-dedup"
	if err := connector.ObserveCommandIdentity(command, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	ack := protocol.CommandAck{CommandID: prepared.CommandID, State: protocol.CommandStateSucceeded, RunID: &nativeTurnID, Result: json.RawMessage(`{"ok":true}`)}
	if _, _, err := journal.BeginCommand(prepared); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommand(prepared.CommandID, ack); err != nil {
		t.Fatal(err)
	}
	connector.controller = nil
	retry, err := connector.acceptPlatformCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded || string(retry.Result) != string(ack.Result) {
		t.Fatalf("durable bound retry = %+v, want the persisted ACK", retry)
	}
	conflict := command
	conflict.Payload = json.RawMessage(`{"prompt":"changed"}`)
	if _, err := connector.acceptPlatformCommand(context.Background(), conflict); !errors.Is(err, protocol.ErrIdempotencyConflict) {
		t.Fatalf("conflicting retry error = %v, want idempotency conflict", err)
	}
}

func TestConnectorIdentityBindsRecoveredAdapterAckAfterJournalRestart(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	connector := &Connector{journal: journal}
	adapterSession := protocol.AdapterSession{SessionID: "adapter-recovered", ExternalThreadRef: "thread-recovered"}
	if err := connector.BindSessionIdentity("platform-session-recovered", "create-recovered", protocol.GatewaySession{Generation: "generation-recovered"}, adapterSession); err != nil {
		t.Fatal(err)
	}
	platformRunID := "platform-run-recovered"
	command := protocol.Command{
		CommandID: "run-recovered",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"recover native identity"}`),
		RunID:     &platformRunID,
		SessionID: "platform-session-recovered",
	}
	if _, err := connector.BeginRunIdentity(command); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	recoveredJournal, err := connectorruntime.OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer recoveredJournal.Close()
	recoveredConnector := &Connector{journal: recoveredJournal}
	nativeTurnID := "native-turn-recovered"
	nativeOperationID := "generation-recovered\x00rpc-recovered"
	if err := recoveredConnector.ObserveCommandIdentity(command, protocol.CommandAck{RunID: &nativeTurnID, OperationID: &nativeOperationID}); err != nil {
		t.Fatal(err)
	}
	bound, ok := recoveredJournal.RunBinding(command.SessionID, platformRunID)
	if !ok || bound.State != connectorruntime.IdentityStateBound || bound.NativeTurnID != nativeTurnID || bound.NativeOperationID != nativeOperationID {
		t.Fatalf("recovered run binding = %+v, found = %v", bound, ok)
	}

	interrupt := command
	interrupt.CommandID = "interrupt-recovered"
	interrupt.Kind = protocol.CommandKindRunInterrupt
	interrupt.Payload = json.RawMessage(`{"reason":"stop"}`)
	prepared, err := recoveredConnector.PreparePlatformCommand(interrupt)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.SessionID != adapterSession.SessionID || prepared.RunID == nil || *prepared.RunID != nativeTurnID {
		t.Fatalf("recovered control command = %+v, want native turn identity", prepared)
	}
}

func TestConnectorIdentityRejectsMismatchedRecoveryAndGatewayThread(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()

	connector := &Connector{journal: journal}
	alias := connectorruntime.SessionAlias{
		PlatformSessionID: "platform-session-recovery",
		AdapterSessionID:  "adapter-recovery",
		ExternalThreadRef: "thread-recovery",
		Generation:        "generation-old",
		CommandID:         "create-recovery",
	}
	if err := journal.RecordSessionAlias(alias); err != nil {
		t.Fatal(err)
	}
	if err := connector.BindSessionIdentity(alias.PlatformSessionID, alias.CommandID, protocol.GatewaySession{
		Generation:        alias.Generation,
		ExternalThreadRef: "different-thread",
	}, protocol.AdapterSession{SessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef}); !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("gateway thread mismatch error = %v, want identity conflict", err)
	}
	if err := validateRecoveredSessionIdentity(alias, protocol.GatewaySession{
		Generation:        "generation-new",
		ExternalThreadRef: alias.ExternalThreadRef,
	}, protocol.AdapterSession{SessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef}); err != nil {
		t.Fatalf("cold recovery generation rotation was rejected: %v", err)
	}
	if err := connector.RotateSessionIdentity(alias.PlatformSessionID, alias.CommandID, protocol.GatewaySession{
		Generation:        "generation-new",
		ExternalThreadRef: alias.ExternalThreadRef,
	}, protocol.AdapterSession{SessionID: alias.AdapterSessionID, ExternalThreadRef: alias.ExternalThreadRef}); err != nil {
		t.Fatalf("cold recovery generation rotation error = %v", err)
	}
	rotated, ok := journal.SessionAlias(alias.PlatformSessionID)
	if !ok || rotated.Generation != "generation-new" || rotated.Revision != 2 {
		t.Fatalf("rotated alias = %+v, found = %v", rotated, ok)
	}
}

func TestConnectorSessionStartUsesExplicitIdentityAndDoesNotSynthesizeInitialRun(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	transport := &connectorSessionTransport{threadID: "thread-explicit"}
	appGateway, err := connectorruntime.NewGateway(connectorruntime.GatewayConfig{
		TransportFactory: func(context.Context) (connectorruntime.RPCTransport, error) { return transport, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := connectorruntime.NewAdapter(appGateway, journal, connectorruntime.AdapterConfig{})
	if err != nil {
		t.Fatal(err)
	}
	connector := &Connector{journal: journal, appGateway: appGateway, adapter: adapter}
	request := protocol.CreateSessionRequest{CommandID: "session-command-1", Path: protocol.SessionPathNew, Prompt: stringPointer("must become a real run")}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: request.CommandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-1"}

	ack, err := connector.acceptSessionCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if ack.State != protocol.CommandStateSucceeded || len(ack.Result) == 0 {
		t.Fatalf("session command ACK = %+v", ack)
	}
	alias, ok := journal.SessionAlias(command.SessionID)
	if !ok || alias.ExternalThreadRef != "thread-explicit" || alias.CommandID != request.CommandID {
		t.Fatalf("session alias = %+v, found = %v", alias, ok)
	}
	if calls := transport.methods(); calls["turn/start"] != 0 || calls["thread/start"] != 1 {
		t.Fatalf("session open calls = %+v, want no synthetic turn/start", calls)
	}

	retry, err := connector.acceptSessionCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.Result == nil || string(retry.Result) != string(ack.Result) {
		t.Fatalf("deduplicated session ACK = %+v", retry)
	}
	if calls := transport.methods(); calls["thread/start"] != 1 || calls["turn/start"] != 0 {
		t.Fatalf("duplicate session open crossed adapter boundary: %+v", calls)
	}
	_ = adapter.CloseSession(context.Background(), protocol.AdapterSession{SessionID: alias.AdapterSessionID})
	_ = appGateway.CloseSession(context.Background(), protocol.GatewaySession{Handle: alias.AdapterSessionID})
}

func TestConnectorRecoversCachedRunAckAfterRestartWithoutNativeReplay(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-run-recovery", "create-run-recovery", protocol.GatewaySession{Generation: "generation-run-recovery"}, protocol.AdapterSession{SessionID: "adapter-run-recovery", ExternalThreadRef: "thread-run-recovery"}); err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-recovery"
	command := protocol.Command{
		CommandID: "run-recovery-cached",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"recover the cached ACK"}`),
		RunID:     &runID,
		SessionID: "platform-session-run-recovery",
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if _, deduplicated, err := journal.BeginCommand(prepared); err != nil || deduplicated {
		t.Fatalf("seed cached run command = deduplicated %v, error %v", deduplicated, err)
	}
	nativeTurnID := "native-turn-recovery"
	nativeOperationID := "generation-run-recovery\x00rpc-recovery"
	seedAck := protocol.CommandAck{
		CommandID:   prepared.CommandID,
		State:       protocol.CommandStateSucceeded,
		OperationID: &nativeOperationID,
		Result:      json.RawMessage(`{"ok":true}`),
		RunID:       &nativeTurnID,
	}
	if err := journal.UpdateCommand(prepared.CommandID, seedAck); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	recoveredJournal, err := connectorruntime.OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer recoveredJournal.Close()
	recoveredConnector := &Connector{journal: recoveredJournal}
	retry, err := recoveredConnector.acceptPlatformCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded || string(retry.Result) != string(seedAck.Result) {
		t.Fatalf("recovered cached run ACK = %+v, want the persisted success", retry)
	}
	binding, ok := recoveredJournal.RunBindingForCommand(command.CommandID)
	if !ok || binding.State != connectorruntime.IdentityStateBound || binding.Generation != "generation-run-recovery" || binding.NativeTurnID != nativeTurnID || binding.NativeOperationID != nativeOperationID {
		t.Fatalf("recovered run binding = %+v, found = %v", binding, ok)
	}
	storedCommand, _, err := recoveredJournal.Command(command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if string(storedCommand.Payload) != string(prepared.Payload) {
		t.Fatalf("recovered command payload changed: %s", storedCommand.Payload)
	}
}

func TestConnectorWithholdsSuccessWhenRunBindingPersistenceFails(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-binding-failure", "create-binding-failure", protocol.GatewaySession{Generation: "generation-binding-failure"}, protocol.AdapterSession{SessionID: "adapter-binding-failure", ExternalThreadRef: "thread-binding-failure"}); err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-binding-failure"
	command := protocol.Command{
		CommandID: "run-binding-failure",
		Kind:      protocol.CommandKindRunSend,
		Payload:   json.RawMessage(`{"prompt":"preserve native proof"}`),
		RunID:     &runID,
		SessionID: "platform-session-binding-failure",
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if _, deduplicated, err := journal.BeginCommand(prepared); err != nil || deduplicated {
		t.Fatalf("seed command = deduplicated %v, error %v", deduplicated, err)
	}
	nativeTurnID := "native-turn-binding-failure"
	nativeOperationID := "generation-binding-failure\x00rpc-binding-failure"
	nativeAck := protocol.CommandAck{
		CommandID:   prepared.CommandID,
		State:       protocol.CommandStateSucceeded,
		RunID:       &nativeTurnID,
		OperationID: &nativeOperationID,
		Result:      json.RawMessage(`{"ok":true}`),
	}
	if err := journal.UpdateCommand(prepared.CommandID, nativeAck); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	unknown, err := connector.completePlatformCommand(command, nativeAck, nil)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("binding persistence error = %v, want unknown result", err)
	}
	if unknown.State != protocol.CommandStateUnknown || unknown.Deduplicated || unknown.RunID == nil || *unknown.RunID != nativeTurnID || unknown.OperationID == nil || *unknown.OperationID != nativeOperationID {
		t.Fatalf("safe unknown ACK = %+v", unknown)
	}

	recoveredJournal, err := connectorruntime.OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer recoveredJournal.Close()
	recoveredConnector := &Connector{journal: recoveredJournal}
	retry, err := recoveredConnector.acceptPlatformCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded || retry.RunID == nil || *retry.RunID != nativeTurnID {
		t.Fatalf("exact duplicate recovery ACK = %+v", retry)
	}
	binding, ok := recoveredJournal.RunBindingForCommand(command.CommandID)
	if !ok || binding.State != connectorruntime.IdentityStateBound || binding.NativeTurnID != nativeTurnID || binding.NativeOperationID != nativeOperationID {
		t.Fatalf("recovered binding = %+v, found = %v", binding, ok)
	}
}

func TestConnectorLeavesCachedRunAckUnknownWithoutExactNativeFacts(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-run-unknown", "create-run-unknown", protocol.GatewaySession{Generation: "generation-run-unknown"}, protocol.AdapterSession{SessionID: "adapter-run-unknown", ExternalThreadRef: "thread-run-unknown"}); err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-unknown"
	command := protocol.Command{CommandID: "run-unknown-cached", Kind: protocol.CommandKindRunSend, Payload: json.RawMessage(`{"prompt":"insufficient evidence"}`), RunID: &runID, SessionID: "platform-session-run-unknown"}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.BeginCommand(prepared); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommand(prepared.CommandID, protocol.CommandAck{CommandID: prepared.CommandID, State: protocol.CommandStateSucceeded, Result: json.RawMessage(`{"ok":true}`)}); err != nil {
		t.Fatal(err)
	}
	retry, err := connector.acceptPlatformCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("insufficient run evidence error = %v, want unknown result", err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateUnknown || retry.Error == nil || retry.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("insufficient run evidence ACK = %+v", retry)
	}
	binding, ok := journal.RunBindingForCommand(command.CommandID)
	if !ok || binding.State != connectorruntime.IdentityStateUnknown || binding.NativeTurnID != "" || binding.NativeOperationID != "" {
		t.Fatalf("insufficient run evidence binding = %+v, found = %v", binding, ok)
	}
}

func TestConnectorRecoversCachedSessionStartFromExactIntentAfterRestart(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	commandID := "session-recovery-cached"
	threadID := "thread-session-recovery"
	request := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew, ProjectID: stringPointer("project-session-recovery"), Prompt: stringPointer("initial prompt is outside native session creation")}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-session-recovery"}
	if _, deduplicated, err := journal.BeginCommand(command); err != nil || deduplicated {
		t.Fatalf("seed cached session command = deduplicated %v, error %v", deduplicated, err)
	}
	nativeRequest := protocol.NewSessionRequest{CommandID: commandID, ProjectID: "project-session-recovery"}
	gatewaySession := protocol.GatewaySession{Handle: "gateway-session-recovery", Generation: "generation-session-recovery"}
	intentID, err := journal.BeginSessionStart(gatewaySession, nativeRequest)
	if err != nil {
		t.Fatal(err)
	}
	nativeSessionID := sessionRecoveryStableID(threadID)
	if err := journal.ResolveSessionStart(intentID, nativeSessionID, threadID, gatewaySession.Generation); err != nil {
		t.Fatal(err)
	}
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity(command.SessionID, command.CommandID, gatewaySession, protocol.AdapterSession{SessionID: nativeSessionID, ExternalThreadRef: threadID}); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommand(command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateUnknown, Error: &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "simulated crash after alias persistence", RequestID: command.CommandID}}); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	recoveredJournal, err := connectorruntime.OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer recoveredJournal.Close()
	recoveredConnector := &Connector{journal: recoveredJournal}
	retry, err := recoveredConnector.acceptSessionCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded {
		t.Fatalf("recovered session ACK = %+v", retry)
	}
	var opened sessionOpenResult
	if err := json.Unmarshal(retry.Result, &opened); err != nil {
		t.Fatal(err)
	}
	if opened.ExternalThreadRef != threadID || opened.Generation != gatewaySession.Generation {
		t.Fatalf("recovered session result = %+v", opened)
	}
	aliases := recoveredJournal.SessionAliases()
	if len(aliases) != 1 || aliases[0].AdapterSessionID != nativeSessionID {
		t.Fatalf("recovered session aliases = %+v", aliases)
	}
}

func TestConnectorRejectsCachedSessionStartWithConflictingAlias(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	commandID := "session-conflicting-alias"
	request := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-conflicting-alias"}
	if _, _, err := journal.BeginCommand(command); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSessionAlias(connectorruntime.SessionAlias{PlatformSessionID: command.SessionID, AdapterSessionID: "adapter-conflicting-alias", ExternalThreadRef: "thread-conflicting-alias", Generation: "generation-conflicting-alias", CommandID: "another-creation-command"}); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommand(command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateSucceeded}); err != nil {
		t.Fatal(err)
	}
	retry, err := (&Connector{journal: journal}).acceptSessionCommand(context.Background(), command)
	if !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("conflicting session alias error = %v, want identity conflict", err)
	}
	if retry.State != protocol.CommandStateRejected {
		t.Fatalf("conflicting session alias ACK = %+v, want rejected", retry)
	}
}

func sessionRecoveryStableID(externalThreadRef string) string {
	sum := sha256.Sum256([]byte(externalThreadRef))
	return "session-" + hex.EncodeToString(sum[:])[:24]
}

func openConnectorIdentityJournal(t *testing.T) *connectorruntime.Journal {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "journal")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	journal, err := connectorruntime.OpenJournal(filepath.Join(directory, "connector.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

type connectorSessionTransport struct {
	mu       sync.Mutex
	threadID string
	calls    []string
	events   chan connectorruntime.RPCMessage
	closed   bool
}

func (t *connectorSessionTransport) Call(_ context.Context, method string, _ json.RawMessage) (connectorruntime.RPCMessage, error) {
	t.mu.Lock()
	t.calls = append(t.calls, method)
	t.mu.Unlock()
	if method == "thread/start" {
		return connectorruntime.RPCMessage{Result: json.RawMessage(`{"thread":{"id":"thread-explicit"}}`)}, nil
	}
	return connectorruntime.RPCMessage{Result: json.RawMessage(`{}`)}, nil
}

func (t *connectorSessionTransport) Notify(context.Context, string, json.RawMessage) error {
	return nil
}

func (t *connectorSessionTransport) Respond(context.Context, json.RawMessage, json.RawMessage) error {
	return nil
}

func (t *connectorSessionTransport) Events() <-chan connectorruntime.RPCMessage {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.events == nil {
		t.events = make(chan connectorruntime.RPCMessage)
	}
	return t.events
}

func (t *connectorSessionTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.closed {
		t.closed = true
		if t.events != nil {
			close(t.events)
		}
	}
	return nil
}

func (t *connectorSessionTransport) methods() map[string]int {
	t.mu.Lock()
	defer t.mu.Unlock()
	result := make(map[string]int)
	for _, method := range t.calls {
		result[method]++
	}
	return result
}
