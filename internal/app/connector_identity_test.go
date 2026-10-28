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
	if err := connector.BindSessionIdentity("platform-session-generation", "create-generation", protocol.GatewaySession{Handle: "gateway-generation", Generation: "generation-old"}, protocol.AdapterSession{SessionID: "adapter-generation", ExternalThreadRef: "thread-generation"}); err != nil {
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
	if err := connector.BindSessionIdentity("platform-session-dedup", "create-dedup", protocol.GatewaySession{Handle: "gateway-dedup", Generation: "generation-dedup"}, protocol.AdapterSession{SessionID: "adapter-dedup", ExternalThreadRef: "thread-dedup"}); err != nil {
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
	nativeNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	ack := protocol.CommandAck{CommandID: prepared.CommandID, State: protocol.CommandStateSucceeded, RunID: &nativeTurnID, Result: json.RawMessage(`{"ok":true}`)}
	if _, _, err := journal.BeginCommandInNamespace(nativeNamespace, prepared); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(nativeNamespace, prepared.CommandID, ack); err != nil {
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
	if err := connector.BindSessionIdentity("platform-session-recovered", "create-recovered", protocol.GatewaySession{Handle: "gateway-recovered", Generation: "generation-recovered"}, adapterSession); err != nil {
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
		Handle:            "gateway-recovery",
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
	link, linked, err := journal.GatewaySessionLinkForPlatform(command.SessionID)
	if err != nil || !linked || link.PlatformSessionID != command.SessionID || link.CommandID != command.CommandID {
		t.Fatalf("session gateway link = %+v, linked = %v, error = %v", link, linked, err)
	}
	_ = adapter.CloseSession(context.Background(), protocol.AdapterSession{SessionID: alias.AdapterSessionID})
	_ = appGateway.CloseSession(context.Background(), protocol.GatewaySession{Handle: alias.AdapterSessionID})
}

func TestConnectorNewSessionScopesSameCommandIDAndDoesNotReplayNativeStart(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	transport := &connectorSessionTransport{threadIDs: []string{"thread-platform-a", "thread-platform-b"}}
	connector := newConnectorIdentityAssembly(t, journal, transport)
	promptA := "prompt for platform A"
	promptB := "prompt for platform B"
	requestA := protocol.CreateSessionRequest{CommandID: "same-creation-command", ProjectID: stringPointer("project-a"), Path: protocol.SessionPathNew, Prompt: &promptA}
	requestB := protocol.CreateSessionRequest{CommandID: "same-creation-command", ProjectID: stringPointer("project-b"), Path: protocol.SessionPathNew, Prompt: &promptB}
	payloadA, err := json.Marshal(requestA)
	if err != nil {
		t.Fatal(err)
	}
	payloadB, err := json.Marshal(requestB)
	if err != nil {
		t.Fatal(err)
	}
	commandA := protocol.Command{CommandID: requestA.CommandID, Kind: protocol.CommandKindSessionStart, Payload: payloadA, SessionID: "platform-session-a"}
	commandB := protocol.Command{CommandID: requestB.CommandID, Kind: protocol.CommandKindSessionStart, Payload: payloadB, SessionID: "platform-session-b"}
	first, err := connector.acceptSessionCommand(context.Background(), commandA)
	if err != nil {
		t.Fatal(err)
	}
	second, err := connector.acceptSessionCommand(context.Background(), commandB)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := connector.acceptSessionCommand(context.Background(), commandA)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != protocol.CommandStateSucceeded || second.State != protocol.CommandStateSucceeded || retry.State != protocol.CommandStateSucceeded {
		t.Fatalf("platform-scoped creation ACKs = first=%+v second=%+v retry=%+v", first, second, retry)
	}
	aliasA, ok := journal.SessionAlias(commandA.SessionID)
	if !ok {
		t.Fatalf("platform A alias is missing")
	}
	aliasB, ok := journal.SessionAlias(commandB.SessionID)
	if !ok {
		t.Fatalf("platform B alias is missing")
	}
	if aliasA.ExternalThreadRef == aliasB.ExternalThreadRef || aliasA.AdapterSessionID == aliasB.AdapterSessionID {
		t.Fatalf("platform-scoped creations collided: alias A=%+v alias B=%+v", aliasA, aliasB)
	}
	calls := transport.methods()
	if calls["thread/start"] != 2 || calls["turn/start"] != 0 {
		t.Fatalf("native creation calls = %+v, want two thread/start and no initial turn", calls)
	}
	for _, sessionID := range []string{"platform-session-a", "platform-session-b"} {
		link, linked, linkErr := journal.GatewaySessionLinkForPlatform(sessionID)
		if linkErr != nil || !linked || link.PlatformSessionID != sessionID || link.CommandID != commandA.CommandID {
			t.Fatalf("gateway link for %s = %+v, linked = %v, error = %v", sessionID, link, linked, linkErr)
		}
	}
}

func TestConnectorAliasPersistenceFailureDoesNotReturnSuccess(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	if err := journal.RecordSessionAlias(connectorruntime.SessionAlias{
		PlatformSessionID: "platform-session-alias-conflict",
		AdapterSessionID:  "existing-adapter",
		ExternalThreadRef: "existing-thread",
		Generation:        "existing-generation",
		CommandID:         "existing-command",
	}); err != nil {
		t.Fatal(err)
	}
	connector := &Connector{journal: journal}
	err := connector.BindSessionIdentity("platform-session-alias-conflict", "new-command", protocol.GatewaySession{Handle: "gateway-alias-conflict", Generation: "generation-alias-conflict"}, protocol.AdapterSession{SessionID: "new-adapter", ExternalThreadRef: "new-thread"})
	if err == nil {
		t.Fatal("alias persistence unexpectedly succeeded")
	}
	err = unknownSessionIdentityError(err)
	if !errors.Is(err, connectorruntime.ErrUnknownOutcome) || !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("alias persistence error = %v, want unknown identity conflict", err)
	}
}

func TestConnectorGatewayLinkPersistenceFailureDoesNotReturnSuccess(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	targetAlias := connectorruntime.SessionAlias{PlatformSessionID: "platform-session-link-conflict", AdapterSessionID: "target-adapter", ExternalThreadRef: "target-thread", Generation: "target-generation", CommandID: "target-command"}
	otherAlias := connectorruntime.SessionAlias{PlatformSessionID: "other-platform-session", AdapterSessionID: "other-adapter", ExternalThreadRef: "other-thread", Generation: "other-generation", CommandID: "other-command"}
	if err := journal.RecordSessionAlias(targetAlias); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSessionAlias(otherAlias); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordGatewaySessionLink(connectorruntime.GatewaySessionLink{
		GatewayHandle:     "gateway-link-conflict",
		PlatformSessionID: otherAlias.PlatformSessionID,
		AdapterSessionID:  otherAlias.AdapterSessionID,
		ExternalThreadRef: otherAlias.ExternalThreadRef,
		Generation:        otherAlias.Generation,
		CommandID:         "other-command",
	}); err != nil {
		t.Fatal(err)
	}
	connector := &Connector{journal: journal}
	err := connector.BindSessionIdentity(targetAlias.PlatformSessionID, targetAlias.CommandID, protocol.GatewaySession{Handle: "gateway-link-conflict", Generation: targetAlias.Generation}, protocol.AdapterSession{SessionID: targetAlias.AdapterSessionID, ExternalThreadRef: targetAlias.ExternalThreadRef})
	if err == nil {
		t.Fatal("gateway link persistence unexpectedly succeeded")
	}
	err = unknownSessionIdentityError(err)
	if !errors.Is(err, connectorruntime.ErrUnknownOutcome) || !errors.Is(err, connectorruntime.ErrCommandScopeAmbiguous) {
		t.Fatalf("gateway link persistence error = %v, want unknown scope conflict", err)
	}
}

func TestConnectorRecoversCachedRunAckAfterRestartWithoutNativeReplay(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-run-recovery", "create-run-recovery", protocol.GatewaySession{Handle: "gateway-run-recovery", Generation: "generation-run-recovery"}, protocol.AdapterSession{SessionID: "adapter-run-recovery", ExternalThreadRef: "thread-run-recovery"}); err != nil {
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
	nativeNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(nativeNamespace, prepared); err != nil || deduplicated {
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
	if err := journal.UpdateCommandInNamespace(nativeNamespace, prepared.CommandID, seedAck); err != nil {
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
	binding, ok := recoveredJournal.RunBinding(command.SessionID, runID)
	if !ok || binding.State != connectorruntime.IdentityStateBound || binding.Generation != "generation-run-recovery" || binding.NativeTurnID != nativeTurnID || binding.NativeOperationID != nativeOperationID {
		t.Fatalf("recovered run binding = %+v, found = %v", binding, ok)
	}
	storedCommand, _, err := recoveredJournal.CommandInNamespace(nativeNamespace, prepared.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if string(storedCommand.Payload) != string(prepared.Payload) {
		t.Fatalf("recovered command payload changed: %s", storedCommand.Payload)
	}
}

func TestConnectorRecoversCachedApprovalAckFromExactJournalResult(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	connector := &Connector{journal: journal}
	platformSessionID := "platform-session-approval-recovery"
	adapterSessionID := "adapter-session-approval-recovery"
	generation := "generation-approval-recovery"
	nativeTurnID := "native-turn-approval-recovery"
	if err := connector.BindSessionIdentity(platformSessionID, "create-approval-recovery", protocol.GatewaySession{Handle: "gateway-approval-recovery", Generation: generation}, protocol.AdapterSession{SessionID: adapterSessionID, ExternalThreadRef: "thread-approval-recovery"}); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSession(adapterSessionID, "thread-approval-recovery", generation); err != nil {
		t.Fatal(err)
	}
	platformRunID := "platform-run-approval-recovery"
	command := protocol.Command{
		CommandID: "run-approval-recovery",
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(`{"approval_id":"approval-recovery","decision":"approve","revision":1}`),
		RunID:     &platformRunID,
		SessionID: platformSessionID,
	}
	if err := journal.RecordRunBinding(connectorruntime.RunBinding{PlatformSessionID: platformSessionID, PlatformRunID: platformRunID, CommandID: "run-send-approval-recovery", AdapterSessionID: adapterSessionID, ExternalThreadRef: "thread-approval-recovery", Generation: generation, NativeTurnID: nativeTurnID, State: connectorruntime.IdentityStateBound}); err != nil {
		t.Fatal(err)
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	nativeNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(nativeNamespace, prepared); err != nil || deduplicated {
		t.Fatalf("seed cached approval command = deduplicated %v, error %v", deduplicated, err)
	}
	if err := journal.UpdateCommandInNamespace(nativeNamespace, prepared.CommandID, protocol.CommandAck{CommandID: prepared.CommandID, State: protocol.CommandStateUnknown}); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: adapterSessionID,
		RunID:     &nativeTurnID,
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   json.RawMessage(`{"jsonrpc":"2.0","id":41,"method":"item/commandExecution/requestApproval","params":{"turnId":"native-turn-approval-recovery","revision":1,"itemId":"item-approval-recovery"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.ClaimApproval(adapterSessionID, json.RawMessage(`41`), 1, prepared.CommandID, "approve"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: adapterSessionID,
		RunID:     &nativeTurnID,
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   json.RawMessage(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":41,"turnId":"native-turn-approval-recovery","resolution":"accept"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if result, found, err := journal.ApprovalResultInNamespace(nativeNamespace, prepared.CommandID); err != nil || !found || result != "accept" {
		t.Fatalf("durable approval result = %q, found = %v, error = %v", result, found, err)
	}

	retry, err := connector.acceptPlatformCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded || string(retry.Result) != `{"decision":"accept"}` {
		t.Fatalf("recovered cached approval ACK = %+v", retry)
	}
	secondRetry, err := connector.acceptPlatformCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !secondRetry.Deduplicated || secondRetry.State != protocol.CommandStateSucceeded || string(secondRetry.Result) != string(retry.Result) {
		t.Fatalf("repeated cached approval ACK = %+v", secondRetry)
	}
}

func TestConnectorKeepsCachedApprovalUnknownForUnknownNativeResolution(t *testing.T) {
	journal, connector, command, nativeNamespace := seedCachedApprovalResolution(t, "unexpected")
	defer journal.Close()
	if result, found, err := journal.ApprovalResultInNamespace(nativeNamespace, command.CommandID); err != nil || !found || result != "unknown" {
		t.Fatalf("durable unknown approval result = %q, found = %v, error = %v", result, found, err)
	}

	retry, err := connector.acceptPlatformCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("cached unknown approval error = %v, want unknown result", err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateUnknown || retry.Error == nil || retry.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("cached unknown approval ACK = %+v", retry)
	}
	stored, err := journal.LookupCommandInNamespace(nativeNamespace, command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != protocol.CommandStateUnknown || stored.Error == nil || stored.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("durable cached unknown approval ACK = %+v", stored)
	}
}

func TestConnectorKeepsCachedApprovalUnknownWhenResolutionIsCleared(t *testing.T) {
	journal, connector, command, nativeNamespace := seedCachedApprovalResolution(t, "")
	defer journal.Close()
	if result, found, err := journal.ApprovalResultInNamespace(nativeNamespace, command.CommandID); err != nil || !found || result != "cleared" {
		t.Fatalf("durable cleared approval result = %q, found = %v, error = %v", result, found, err)
	}

	retry, err := connector.acceptPlatformCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("cached cleared approval error = %v, want unknown result", err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateUnknown || retry.Error == nil || retry.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("cached cleared approval ACK = %+v", retry)
	}
	stored, err := journal.LookupCommandInNamespace(nativeNamespace, command.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != protocol.CommandStateUnknown || stored.Error == nil || stored.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("durable cached cleared approval ACK = %+v", stored)
	}
}

func seedCachedApprovalResolution(t *testing.T, rawResolution string) (*connectorruntime.Journal, *Connector, protocol.Command, connectorruntime.CommandNamespace) {
	t.Helper()
	journal := openConnectorIdentityJournal(t)
	connector := &Connector{journal: journal}
	platformSessionID := "platform-session-approval-resolution"
	adapterSessionID := "adapter-session-approval-resolution"
	generation := "generation-approval-resolution"
	nativeTurnID := "native-turn-approval-resolution"
	threadID := "thread-approval-resolution"
	if err := connector.BindSessionIdentity(platformSessionID, "create-approval-resolution", protocol.GatewaySession{Handle: "gateway-approval-resolution", Generation: generation}, protocol.AdapterSession{SessionID: adapterSessionID, ExternalThreadRef: threadID}); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSession(adapterSessionID, threadID, generation); err != nil {
		t.Fatal(err)
	}
	platformRunID := "platform-run-approval-resolution"
	command := protocol.Command{
		CommandID: "run-approval-resolution",
		Kind:      protocol.CommandKindRunApprove,
		Payload:   json.RawMessage(`{"approval_id":"approval-resolution","decision":"approve","revision":1}`),
		RunID:     &platformRunID,
		SessionID: platformSessionID,
	}
	if err := journal.RecordRunBinding(connectorruntime.RunBinding{PlatformSessionID: platformSessionID, PlatformRunID: platformRunID, CommandID: "run-send-approval-resolution", AdapterSessionID: adapterSessionID, ExternalThreadRef: threadID, Generation: generation, NativeTurnID: nativeTurnID, State: connectorruntime.IdentityStateBound}); err != nil {
		t.Fatal(err)
	}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	nativeNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(nativeNamespace, prepared); err != nil || deduplicated {
		t.Fatalf("seed cached approval command = deduplicated %v, error %v", deduplicated, err)
	}
	if err := journal.UpdateCommandInNamespace(nativeNamespace, prepared.CommandID, protocol.CommandAck{CommandID: prepared.CommandID, State: protocol.CommandStateUnknown}); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: adapterSessionID,
		RunID:     &nativeTurnID,
		Type:      protocol.EventTypeApprovalRequested,
		Source:    protocol.EventSourceAppServer,
		Payload:   json.RawMessage(`{"jsonrpc":"2.0","id":42,"method":"item/commandExecution/requestApproval","params":{"turnId":"native-turn-approval-resolution","revision":1,"itemId":"item-approval-resolution"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.ClaimApproval(adapterSessionID, json.RawMessage(`42`), 1, prepared.CommandID, "approve"); err != nil {
		t.Fatal(err)
	}
	resolutionField := ""
	if rawResolution != "" {
		resolutionField = `,"resolution":"` + rawResolution + `"`
	}
	if _, err := journal.AppendEvent(protocol.Event{
		SessionID: adapterSessionID,
		RunID:     &nativeTurnID,
		Type:      protocol.EventTypeApprovalResolved,
		Source:    protocol.EventSourceAppServer,
		Payload:   json.RawMessage(`{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"requestId":42,"turnId":"native-turn-approval-resolution"` + resolutionField + `}}`),
	}); err != nil {
		t.Fatal(err)
	}
	return journal, connector, command, nativeNamespace
}

func TestConnectorWithholdsSuccessWhenRunBindingPersistenceFails(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-binding-failure", "create-binding-failure", protocol.GatewaySession{Handle: "gateway-binding-failure", Generation: "generation-binding-failure"}, protocol.AdapterSession{SessionID: "adapter-binding-failure", ExternalThreadRef: "thread-binding-failure"}); err != nil {
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
	nativeNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(nativeNamespace, prepared); err != nil || deduplicated {
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
	if err := journal.UpdateCommandInNamespace(nativeNamespace, prepared.CommandID, nativeAck); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	unknown, err := connector.completePlatformCommand(command, prepared, nativeAck, nil)
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
	binding, ok := recoveredJournal.RunBinding(command.SessionID, runID)
	if !ok || binding.State != connectorruntime.IdentityStateBound || binding.NativeTurnID != nativeTurnID || binding.NativeOperationID != nativeOperationID {
		t.Fatalf("recovered binding = %+v, found = %v", binding, ok)
	}
}

func TestConnectorLeavesCachedRunAckUnknownWithoutExactNativeFacts(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	connector := &Connector{journal: journal}
	if err := connector.BindSessionIdentity("platform-session-run-unknown", "create-run-unknown", protocol.GatewaySession{Handle: "gateway-run-unknown", Generation: "generation-run-unknown"}, protocol.AdapterSession{SessionID: "adapter-run-unknown", ExternalThreadRef: "thread-run-unknown"}); err != nil {
		t.Fatal(err)
	}
	runID := "platform-run-unknown"
	command := protocol.Command{CommandID: "run-unknown-cached", Kind: protocol.CommandKindRunSend, Payload: json.RawMessage(`{"prompt":"insufficient evidence"}`), RunID: &runID, SessionID: "platform-session-run-unknown"}
	prepared, err := connector.PreparePlatformCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	nativeNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	if _, _, err := journal.BeginCommandInNamespace(nativeNamespace, prepared); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(nativeNamespace, prepared.CommandID, protocol.CommandAck{CommandID: prepared.CommandID, State: protocol.CommandStateSucceeded, Result: json.RawMessage(`{"ok":true}`)}); err != nil {
		t.Fatal(err)
	}
	retry, err := connector.acceptPlatformCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("insufficient run evidence error = %v, want unknown result", err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateUnknown || retry.Error == nil || retry.Error.Code != protocol.ErrorCodeUnknownResult {
		t.Fatalf("insufficient run evidence ACK = %+v", retry)
	}
	binding, ok := journal.RunBinding(command.SessionID, runID)
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
	platformNamespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(platformNamespace, command); err != nil || deduplicated {
		t.Fatalf("seed cached session command = deduplicated %v, error %v", deduplicated, err)
	}
	nativeRequest := protocol.NewSessionRequest{CommandID: commandID, ProjectID: "project-session-recovery"}
	gatewaySession := protocol.GatewaySession{Handle: "gateway-session-recovery", Generation: "generation-session-recovery"}
	intentID, err := journal.BeginSessionStartForPlatform(command.SessionID, gatewaySession, nativeRequest)
	if err != nil {
		t.Fatal(err)
	}
	nativeSessionID := sessionRecoveryStableID(threadID)
	if err := journal.ResolveSessionStart(intentID, nativeSessionID, threadID, gatewaySession.Generation); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(platformNamespace, command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateUnknown, Error: &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "simulated crash before alias persistence", RequestID: command.CommandID}}); err != nil {
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
	link, linked, err := recoveredJournal.GatewaySessionLinkForPlatform(command.SessionID)
	if err != nil || !linked || link.GatewayHandle != gatewaySession.Handle || link.AdapterSessionID != nativeSessionID || link.CommandID != command.CommandID {
		t.Fatalf("recovered gateway link = %+v, linked = %v, error = %v", link, linked, err)
	}
	retryAgain, err := recoveredConnector.acceptSessionCommand(context.Background(), command)
	if err != nil || !retryAgain.Deduplicated || retryAgain.State != protocol.CommandStateSucceeded {
		t.Fatalf("recovered session retry = %+v, error = %v", retryAgain, err)
	}
}

func TestConnectorRecoversResolvedSessionStartWhenAliasAppendFails(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	transport := &connectorSessionTransport{threadID: "thread-alias-append-failure"}
	connector := newConnectorIdentityAssembly(t, journal, transport)
	commandID := "session-alias-append-failure"
	createRequest := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew, ProjectID: stringPointer("project-alias-append-failure")}
	payload, err := json.Marshal(createRequest)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-alias-append-failure"}
	namespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(namespace, command); err != nil || deduplicated {
		t.Fatalf("seed session command = deduplicated %v, error %v", deduplicated, err)
	}
	nativeRequest := newSessionStartRequest(createRequest)
	gatewaySession, err := connector.appGateway.StartNewSessionInNamespace(context.Background(), namespace, nativeRequest)
	if err != nil {
		t.Fatal(err)
	}
	adapterSession, err := connector.adapter.StartSessionInNamespace(context.Background(), namespace, gatewaySession, nativeRequest)
	if err != nil {
		t.Fatal(err)
	}
	if got := transport.methods()["thread/start"]; got != 1 {
		t.Fatalf("native thread/start calls = %d, want 1", got)
	}
	if err := connector.adapter.CloseSession(context.Background(), adapterSession); err != nil {
		t.Fatal(err)
	}
	if err := connector.appGateway.CloseSession(context.Background(), gatewaySession); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(namespace, command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateUnknown}); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	if err := connector.BindSessionIdentity(command.SessionID, command.CommandID, gatewaySession, adapterSession); err == nil {
		t.Fatal("closed journal accepted a session alias")
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
		t.Fatalf("recovered alias-append-failure ACK = %+v", retry)
	}
	if aliases := recoveredJournal.SessionAliases(); len(aliases) != 1 || aliases[0].PlatformSessionID != command.SessionID || aliases[0].ExternalThreadRef != adapterSession.ExternalThreadRef {
		t.Fatalf("recovered alias after append failure = %+v", aliases)
	}
	if got := transport.methods()["thread/start"]; got != 1 {
		t.Fatalf("recovery repeated native thread/start calls = %d, want 1", got)
	}
}

func TestConnectorRecoversCachedSessionStartWithCurrentColdGeneration(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	commandID := "session-cold-generation"
	threadID := "thread-cold-generation"
	request := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew, ProjectID: stringPointer("project-cold-generation")}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-cold-generation"}
	namespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(namespace, command); err != nil || deduplicated {
		t.Fatalf("seed cold session command = deduplicated %v, error %v", deduplicated, err)
	}

	initialTransport := &connectorSessionTransport{threadID: threadID}
	initialConnector := newConnectorIdentityAssembly(t, journal, initialTransport)
	initialGateway, err := initialConnector.appGateway.StartNewSessionInNamespace(context.Background(), namespace, newSessionStartRequest(request))
	if err != nil {
		t.Fatal(err)
	}
	initialAdapter, err := initialConnector.adapter.StartSessionInNamespace(context.Background(), namespace, initialGateway, newSessionStartRequest(request))
	if err != nil {
		t.Fatal(err)
	}
	if initialAdapter.ExternalThreadRef != threadID {
		t.Fatalf("initial adapter session = %+v", initialAdapter)
	}
	initialGeneration := initialGateway.Generation
	if err := journal.UpdateCommandInNamespace(namespace, command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateUnknown, Error: &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "simulated crash before alias persistence", RequestID: command.CommandID}}); err != nil {
		t.Fatal(err)
	}
	if err := initialConnector.adapter.CloseSession(context.Background(), initialAdapter); err != nil {
		t.Fatal(err)
	}
	if err := initialConnector.appGateway.CloseSession(context.Background(), initialGateway); err != nil {
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
	recoveryTransport := &connectorSessionTransport{threadID: threadID}
	recoveredConnector := newConnectorIdentityAssembly(t, recoveredJournal, recoveryTransport)
	if err := recoveredConnector.recoverJournalSessions(context.Background()); err != nil {
		t.Fatal(err)
	}
	recoveredGateway, err := recoveredConnector.appGateway.RecoveredSession(threadID)
	if err != nil {
		t.Fatal(err)
	}
	if recoveredGateway.Generation == initialGeneration {
		t.Fatalf("cold recovery reused the original generation %q", initialGeneration)
	}
	if calls := recoveryTransport.methods(); calls["thread/start"] != 0 || calls["thread/resume"] != 1 {
		t.Fatalf("cold recovery native calls = %+v, want one resume and no start", calls)
	}

	retry, err := recoveredConnector.acceptSessionCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded {
		t.Fatalf("cold recovered session ACK = %+v", retry)
	}
	var opened sessionOpenResult
	if err := json.Unmarshal(retry.Result, &opened); err != nil {
		t.Fatal(err)
	}
	if opened.ExternalThreadRef != threadID || opened.Generation != recoveredGateway.Generation {
		t.Fatalf("cold recovered session result = %+v, recovered gateway = %+v", opened, recoveredGateway)
	}
	alias, found := recoveredJournal.SessionAlias(command.SessionID)
	if !found || alias.Generation != recoveredGateway.Generation || alias.Generation == initialGeneration || alias.ExternalThreadRef != threadID {
		t.Fatalf("cold recovered session alias = %+v, found = %v", alias, found)
	}
	oldProof, found, err := recoveredJournal.ResolvedSessionStartProofForGateway(initialGateway.Handle, newSessionStartRequest(request))
	if err != nil || !found || oldProof.Generation != initialGeneration || oldProof.AdapterSession.ExternalThreadRef != threadID {
		t.Fatalf("historical session-start proof = %+v, found = %v, error = %v", oldProof, found, err)
	}
	link, linked, err := recoveredJournal.GatewaySessionLinkForPlatform(command.SessionID)
	if err != nil || !linked || link.GatewayHandle != recoveredGateway.Handle || link.Generation != recoveredGateway.Generation {
		t.Fatalf("current recovered gateway link = %+v, linked = %v, error = %v", link, linked, err)
	}
	secondRetry, err := recoveredConnector.acceptSessionCommand(context.Background(), command)
	if err != nil || !secondRetry.Deduplicated || secondRetry.State != protocol.CommandStateSucceeded {
		t.Fatalf("cold recovered session retry = %+v, error = %v", secondRetry, err)
	}
	if calls := recoveryTransport.methods(); calls["thread/start"] != 0 || calls["thread/resume"] != 1 {
		t.Fatalf("cached session recovery replayed native calls = %+v", calls)
	}
}

func TestConnectorRecoversCachedSessionStartAfterRecoveredAliasWrite(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	journalPath := journal.Path()
	commandID := "session-recovered-alias-write"
	platformSessionID := "platform-session-recovered-alias-write"
	threadID := "thread-recovered-alias-write"
	request := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew, ProjectID: stringPointer("project-recovered-alias-write")}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: platformSessionID}
	namespace := connectorruntime.PlatformSessionCommandNamespace(platformSessionID)
	if _, deduplicated, err := journal.BeginCommandInNamespace(namespace, command); err != nil || deduplicated {
		t.Fatalf("seed recovered-alias session command = deduplicated %v, error %v", deduplicated, err)
	}
	originalGateway := protocol.GatewaySession{Handle: "gateway-original-recovered-alias-write", Generation: "generation-original-recovered-alias-write"}
	originalAdapter := protocol.AdapterSession{SessionID: sessionRecoveryStableID(threadID), ExternalThreadRef: threadID}
	intentID, err := journal.BeginSessionStartForPlatform(platformSessionID, originalGateway, newSessionStartRequest(request))
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.ResolveSessionStart(intentID, originalAdapter.SessionID, threadID, originalGateway.Generation); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSession(originalAdapter.SessionID, threadID, originalGateway.Generation); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(namespace, commandID, protocol.CommandAck{CommandID: commandID, State: protocol.CommandStateUnknown, Error: &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "simulated crash before session success ACK", RequestID: commandID}}); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}

	firstJournal, err := connectorruntime.OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	firstTransport := &connectorSessionTransport{threadID: threadID}
	firstConnector := newConnectorIdentityAssembly(t, firstJournal, firstTransport)
	if err := firstConnector.recoverJournalSessions(context.Background()); err != nil {
		t.Fatal(err)
	}
	firstGateway, err := firstConnector.appGateway.RecoveredSession(threadID)
	if err != nil {
		t.Fatal(err)
	}
	if err := firstConnector.BindSessionIdentity(platformSessionID, commandID, firstGateway, originalAdapter); err != nil {
		t.Fatal(err)
	}
	firstAlias, found := firstJournal.SessionAlias(platformSessionID)
	if !found || firstAlias.Generation != firstGateway.Generation {
		t.Fatalf("recovered alias before crash = %+v, found = %v, gateway = %+v", firstAlias, found, firstGateway)
	}
	if calls := firstTransport.methods(); calls["thread/start"] != 0 || calls["thread/resume"] != 1 {
		t.Fatalf("first recovery native calls = %+v, want one resume and no start", calls)
	}
	if err := firstConnector.adapter.CloseSession(context.Background(), originalAdapter); err != nil {
		t.Fatal(err)
	}
	if err := firstConnector.appGateway.CloseSession(context.Background(), firstGateway); err != nil {
		t.Fatal(err)
	}
	if err := firstJournal.Close(); err != nil {
		t.Fatal(err)
	}

	secondJournal, err := connectorruntime.OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	secondTransport := &connectorSessionTransport{threadID: threadID}
	secondConnector := newConnectorIdentityAssembly(t, secondJournal, secondTransport)
	var secondGateway protocol.GatewaySession
	defer func() {
		_ = secondConnector.adapter.CloseSession(context.Background(), originalAdapter)
		if secondGateway.Handle != "" {
			_ = secondConnector.appGateway.CloseSession(context.Background(), secondGateway)
		}
		_ = secondJournal.Close()
	}()
	if err := secondConnector.recoverJournalSessions(context.Background()); err != nil {
		t.Fatal(err)
	}
	secondGateway, err = secondConnector.appGateway.RecoveredSession(threadID)
	if err != nil {
		t.Fatal(err)
	}
	if secondGateway.Generation == firstGateway.Generation || secondGateway.Generation == originalGateway.Generation {
		t.Fatalf("second recovery generation = %q, first = %q, original = %q", secondGateway.Generation, firstGateway.Generation, originalGateway.Generation)
	}
	secondAlias, found := secondJournal.SessionAlias(platformSessionID)
	if !found || secondAlias.Generation != secondGateway.Generation {
		t.Fatalf("rotated alias before retry = %+v, found = %v, gateway = %+v", secondAlias, found, secondGateway)
	}

	retry, err := secondConnector.acceptSessionCommand(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !retry.Deduplicated || retry.State != protocol.CommandStateSucceeded {
		t.Fatalf("recovered alias-write session ACK = %+v", retry)
	}
	var opened sessionOpenResult
	if err := json.Unmarshal(retry.Result, &opened); err != nil {
		t.Fatal(err)
	}
	if opened.ExternalThreadRef != threadID || opened.Generation != secondGateway.Generation {
		t.Fatalf("recovered alias-write session result = %+v, gateway = %+v", opened, secondGateway)
	}
	historicalAlias, historicalFound := secondJournal.SessionAliasForAdapter(originalAdapter.SessionID, threadID, firstGateway.Generation)
	if !historicalFound || historicalAlias.PlatformSessionID != platformSessionID || historicalAlias.Generation != firstGateway.Generation {
		t.Fatalf("historical recovered alias = %+v, found = %v", historicalAlias, historicalFound)
	}
	originalProof, proofFound, err := secondJournal.ResolvedSessionStartProofForGateway(originalGateway.Handle, newSessionStartRequest(request))
	if err != nil || !proofFound || originalProof.Generation != originalGateway.Generation || originalProof.AdapterSession.ExternalThreadRef != threadID {
		t.Fatalf("original creation proof = %+v, found = %v, error = %v", originalProof, proofFound, err)
	}
	link, linked, err := secondJournal.GatewaySessionLinkForPlatform(platformSessionID)
	if err != nil || !linked || link.GatewayHandle != secondGateway.Handle || link.Generation != secondGateway.Generation {
		t.Fatalf("current recovered gateway link = %+v, linked = %v, error = %v", link, linked, err)
	}
	if calls := secondTransport.methods(); calls["thread/start"] != 0 || calls["thread/resume"] != 1 {
		t.Fatalf("retry replayed native session creation = %+v", calls)
	}
}

func TestConnectorLeavesCachedSessionStartUnknownWithoutPlatformAttribution(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	commandID := "session-unattributed"
	request := protocol.CreateSessionRequest{CommandID: commandID, ProjectID: stringPointer("project-unattributed"), Path: protocol.SessionPathNew}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-unattributed"}
	platformNamespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	if _, _, err := journal.BeginCommandInNamespace(platformNamespace, command); err != nil {
		t.Fatal(err)
	}
	otherGateway := protocol.GatewaySession{Handle: "gateway-unattributed", Generation: "generation-unattributed"}
	intentID, err := journal.BeginSessionStart(otherGateway, newSessionStartRequest(request))
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.ResolveSessionStart(intentID, sessionRecoveryStableID("thread-unattributed"), "thread-unattributed", otherGateway.Generation); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(platformNamespace, command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateUnknown}); err != nil {
		t.Fatal(err)
	}
	retry, err := (&Connector{journal: journal}).acceptSessionCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) {
		t.Fatalf("unattributed session error = %v, want unknown result", err)
	}
	if retry.State != protocol.CommandStateUnknown || !retry.Deduplicated {
		t.Fatalf("unattributed session ACK = %+v, want persisted unknown", retry)
	}
	if _, found := journal.SessionAlias(command.SessionID); found {
		t.Fatal("unattributed session unexpectedly acquired an alias")
	}
	if _, linked, err := journal.GatewaySessionLinkForPlatform(command.SessionID); err != nil || linked {
		t.Fatalf("unattributed session gateway link = linked %v, error %v", linked, err)
	}
}

func TestConnectorLeavesCachedSessionStartUnknownWithConflictingAlias(t *testing.T) {
	journal := openConnectorIdentityJournal(t)
	defer journal.Close()
	commandID := "session-conflicting-alias"
	request := protocol.CreateSessionRequest{CommandID: commandID, Path: protocol.SessionPathNew}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{CommandID: commandID, Kind: protocol.CommandKindSessionStart, Payload: payload, SessionID: "platform-session-conflicting-alias"}
	platformNamespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	if _, _, err := journal.BeginCommandInNamespace(platformNamespace, command); err != nil {
		t.Fatal(err)
	}
	if err := journal.RecordSessionAlias(connectorruntime.SessionAlias{PlatformSessionID: command.SessionID, AdapterSessionID: "adapter-conflicting-alias", ExternalThreadRef: "thread-conflicting-alias", Generation: "generation-conflicting-alias", CommandID: "another-creation-command"}); err != nil {
		t.Fatal(err)
	}
	if err := journal.UpdateCommandInNamespace(platformNamespace, command.CommandID, protocol.CommandAck{CommandID: command.CommandID, State: protocol.CommandStateSucceeded}); err != nil {
		t.Fatal(err)
	}
	retry, err := (&Connector{journal: journal}).acceptSessionCommand(context.Background(), command)
	if !errors.Is(err, protocol.ErrUnknownCommandResult) || !errors.Is(err, connectorruntime.ErrIdentityConflict) {
		t.Fatalf("conflicting session alias error = %v, want unknown identity conflict", err)
	}
	if retry.State != protocol.CommandStateUnknown {
		t.Fatalf("conflicting session alias ACK = %+v, want unknown", retry)
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

func newConnectorIdentityAssembly(t *testing.T, journal *connectorruntime.Journal, transport *connectorSessionTransport) *Connector {
	t.Helper()
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
	return &Connector{journal: journal, appGateway: appGateway, adapter: adapter}
}

type connectorSessionTransport struct {
	mu          sync.Mutex
	threadID    string
	threadIDs   []string
	threadIndex int
	calls       []string
	events      chan connectorruntime.RPCMessage
	closed      bool
}

func (t *connectorSessionTransport) Call(_ context.Context, method string, _ json.RawMessage) (connectorruntime.RPCMessage, error) {
	t.mu.Lock()
	t.calls = append(t.calls, method)
	threadID := t.threadID
	if method == "thread/start" && t.threadIndex < len(t.threadIDs) {
		threadID = t.threadIDs[t.threadIndex]
		t.threadIndex++
	}
	t.mu.Unlock()
	if method == "thread/start" {
		if threadID == "" {
			threadID = "thread-explicit"
		}
		return connectorruntime.RPCMessage{Result: json.RawMessage(`{"thread":{"id":"` + threadID + `"}}`)}, nil
	}
	if method == "thread/resume" && threadID != "" {
		return connectorruntime.RPCMessage{Result: json.RawMessage(`{"thread":{"id":"` + threadID + `"}}`)}, nil
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
