package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type realC01Acceptance struct {
	CandidateSHA             string                    `json:"candidate_sha"`
	AcceptanceContractDigest string                    `json:"acceptance_contract_digest"`
	ScenarioSetDigest        string                    `json:"scenario_set_digest"`
	EvidenceStatus           string                    `json:"evidence_status"`
	CLI                      realCLIIdentity           `json:"cli"`
	Transport                string                    `json:"transport"`
	Model                    string                    `json:"model"`
	Effort                   string                    `json:"effort"`
	Workspace                string                    `json:"workspace"`
	ThreadID                 string                    `json:"thread_id"`
	SessionID                string                    `json:"session_id"`
	Scenarios                []realC01ScenarioEvidence `json:"scenarios"`
	AttachError              string                    `json:"active_attach_result"`
}

type realCLIIdentity struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

type realC01ScenarioEvidence struct {
	Name                      string                       `json:"name"`
	CommandID                 string                       `json:"command_id"`
	RunID                     string                       `json:"run_id,omitempty"`
	ApprovalRequestID         string                       `json:"approval_request_id,omitempty"`
	Decision                  string                       `json:"decision,omitempty"`
	ApprovalCommandState      protocol.CommandState        `json:"approval_command_state,omitempty"`
	ItemStatus                string                       `json:"item_status,omitempty"`
	ItemCommand               string                       `json:"item_command,omitempty"`
	OutputMarker              string                       `json:"output_marker,omitempty"`
	OutputMarkerObserved      bool                         `json:"output_marker_observed,omitempty"`
	OutputEmpty               bool                         `json:"output_empty,omitempty"`
	CommandMatchesExpected    bool                         `json:"command_matches_expected,omitempty"`
	TerminalEventType         protocol.EventType           `json:"terminal_event_type,omitempty"`
	TerminalStatus            string                       `json:"terminal_status,omitempty"`
	TerminalCursor            string                       `json:"terminal_cursor,omitempty"`
	UnknownAckState           protocol.CommandState        `json:"unknown_ack_state,omitempty"`
	ReconciliationState       protocol.ReconciliationState `json:"reconciliation_state,omitempty"`
	ReconciliationNote        string                       `json:"reconciliation_note,omitempty"`
	NativeTurnID              string                       `json:"native_turn_id,omitempty"`
	NativeOperationID         string                       `json:"native_operation_id,omitempty"`
	RecoveryThreadID          string                       `json:"recovery_thread_id,omitempty"`
	RecoveryEventObserved     bool                         `json:"recovery_event_observed"`
	IndependentProcessRestart bool                         `json:"independent_process_restart,omitempty"`
	ConnectorProcessIDs       []int                        `json:"connector_process_ids,omitempty"`
}

type realC01ProcessResult struct {
	Mode                  string                       `json:"mode"`
	ProcessID             int                          `json:"process_id"`
	ProcessStartToken     string                       `json:"process_start_token"`
	SessionID             string                       `json:"session_id"`
	ThreadID              string                       `json:"thread_id"`
	UnknownAckState       protocol.CommandState        `json:"unknown_ack_state,omitempty"`
	NativeTurnID          string                       `json:"native_turn_id,omitempty"`
	NativeOperationID     string                       `json:"native_operation_id,omitempty"`
	ReconciliationState   protocol.ReconciliationState `json:"reconciliation_state,omitempty"`
	ReconciliationNote    string                       `json:"reconciliation_note,omitempty"`
	FinalAckState         protocol.CommandState        `json:"final_ack_state,omitempty"`
	RecoveryEventObserved bool                         `json:"recovery_event_observed,omitempty"`
}

type realC01PendingApprovalResult struct {
	Mode                        string                `json:"mode"`
	ProcessID                   int                   `json:"process_id"`
	ProcessStartToken           string                `json:"process_start_token"`
	SessionID                   string                `json:"session_id"`
	ThreadID                    string                `json:"thread_id"`
	TurnID                      string                `json:"turn_id"`
	RequestID                   string                `json:"request_id"`
	Revision                    int64                 `json:"revision"`
	InitialGeneration           string                `json:"initial_generation"`
	RecoveredGeneration         string                `json:"recovered_generation,omitempty"`
	FirstCommandID              string                `json:"first_command_id,omitempty"`
	FirstState                  protocol.CommandState `json:"first_state,omitempty"`
	FirstError                  string                `json:"first_error,omitempty"`
	SecondCommandID             string                `json:"second_command_id,omitempty"`
	SecondState                 protocol.CommandState `json:"second_state,omitempty"`
	SecondError                 string                `json:"second_error,omitempty"`
	RecoveryError               string                `json:"recovery_error,omitempty"`
	ResolutionEventCount        int                   `json:"resolution_event_count"`
	ApprovalClaimRecordCount    int                   `json:"approval_claim_record_count"`
	NativeApprovalEventObserved bool                  `json:"native_approval_event_observed"`
}

const realC01HelperEnv = "LOOMHELM_REAL_C01_HELPER"
const realC01PendingApprovalHelperEnv = "LOOMHELM_REAL_C01_PENDING_APPROVAL_HELPER"

func TestRealC01ProcessHelper(t *testing.T) {
	mode := os.Getenv(realC01HelperEnv)
	if mode == "" {
		return
	}
	cli := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_CLI")
	workspace := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_WORKSPACE")
	journalPath := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_JOURNAL")
	sessionID := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_SESSION")
	threadID := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_THREAD")
	commandID := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_COMMAND")
	resultPath := realC01HelperValue(t, "LOOMHELM_REAL_C01_HELPER_RESULT")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var result realC01ProcessResult
	var err error
	switch mode {
	case "seed":
		result, err = runRealC01SeedHelper(ctx, cli, workspace, journalPath, sessionID, threadID, commandID)
	case "recover":
		result, err = runRealC01RecoveryHelper(ctx, cli, workspace, journalPath, sessionID, threadID, commandID)
	default:
		t.Fatalf("unknown C01 helper mode %q", mode)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRealC01ProcessResult(resultPath, result); err != nil {
		t.Fatal(err)
	}
}

func TestRealC01PendingApprovalRecoveryProcessHelper(t *testing.T) {
	if os.Getenv(realC01PendingApprovalHelperEnv) == "" {
		return
	}
	cli := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_CLI")
	workspace := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_WORKSPACE")
	journalPath := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_JOURNAL")
	sessionID := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_SESSION")
	threadID := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_THREAD")
	requestID := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_REQUEST")
	resultPath := realC01HelperValue(t, "LOOMHELM_REAL_C01_PENDING_APPROVAL_RESULT")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	result, err := runRealC01PendingApprovalRecoveryHelper(ctx, cli, workspace, journalPath, sessionID, threadID, requestID)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRealC01PendingApprovalResult(resultPath, result); err != nil {
		t.Fatal(err)
	}
}

func realC01HelperValue(t *testing.T, name string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		t.Fatalf("%s is required for the C01 helper", name)
	}
	return value
}

func runRealC01SeedHelper(ctx context.Context, cli, workspace, journalPath, sessionID, threadID, commandID string) (realC01ProcessResult, error) {
	journal, err := OpenJournal(journalPath)
	if err != nil {
		return realC01ProcessResult{}, err
	}
	session, ok := journal.Session(sessionID)
	if !ok {
		_ = journal.Close()
		return realC01ProcessResult{}, fmt.Errorf("seed helper session %q is not present in the journal", sessionID)
	}
	if session.ExternalThreadRef != threadID {
		_ = journal.Close()
		return realC01ProcessResult{}, fmt.Errorf("seed helper thread = %q, want %q", session.ExternalThreadRef, threadID)
	}

	cancelSignal := make(chan struct{})
	var cancelSignalOnce sync.Once
	cancelAfterTurnStart := func() {
		cancelSignalOnce.Do(func() { close(cancelSignal) })
	}
	gateway, err := newRealC01HelperGateway(cli, workspace, func(method string) {
		if method != "turn/start" {
			return
		}
		cancelAfterTurnStart()
	})
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	adapter, err := NewAdapter(gateway, journal, realC01AdapterConfig(workspace))
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := controller.ensureAdapterSession(ctx, session); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	recoveredGatewaySession, err := gateway.RecoveredSession(threadID)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}

	command := realC01ReconcileCommand(sessionID, commandID)
	beforeCursor := latestRealEventCursor(journal, sessionID)
	unknownCtx, cancelUnknown := context.WithCancel(ctx)
	go func() {
		select {
		case <-cancelSignal:
			cancelUnknown()
		case <-unknownCtx.Done():
		}
	}()
	ack, sendErr := adapter.SendCommand(unknownCtx, session, command)
	cancelUnknown()
	if !errors.Is(sendErr, protocol.ErrUnknownCommandResult) || ack.State != protocol.CommandStateUnknown {
		_ = journal.Close()
		return realC01ProcessResult{}, fmt.Errorf("seed helper ACK = %+v, error = %v", ack, sendErr)
	}
	if ack.OperationID == nil || strings.TrimSpace(*ack.OperationID) == "" {
		_ = journal.Close()
		return realC01ProcessResult{}, errors.New("seed helper unknown ACK did not preserve the JSON-RPC operation ID")
	}
	result := realC01ProcessResult{
		Mode:              "seed",
		ProcessID:         os.Getpid(),
		ProcessStartToken: realC01ProcessToken(),
		SessionID:         sessionID,
		ThreadID:          threadID,
		UnknownAckState:   ack.State,
		NativeOperationID: valueOrEmpty(ack.OperationID),
	}
	observedRun, err := waitForRealObservedOperationAfter(ctx, journal, sessionID, threadID, recoveredGatewaySession.Generation, strings.TrimSpace(*ack.OperationID), beforeCursor, func(event protocol.Event) bool {
		return realEventOperationID(event) == strings.TrimSpace(*ack.OperationID)
	})
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	result.NativeTurnID = realC01ObservedNativeTurn(journal, observedRun)
	if err := gateway.CloseSession(context.Background(), recoveredGatewaySession); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := waitForRealObservedEvent(ctx, journal, sessionID, threadID, recoveredGatewaySession.Generation, protocol.EventTypeReconciliationRequired, ""); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := adapter.CloseSession(context.Background(), session); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := journal.Close(); err != nil {
		return realC01ProcessResult{}, err
	}
	return result, nil
}

func realEventRPCID(event protocol.Event) string {
	return rpcEnvelopeID(event.Payload)
}

func realEventOperationID(event protocol.Event) string {
	if operationID := rpcEnvelopeOperationID(event.Payload); operationID != "" {
		return operationID
	}
	return realEventRPCID(event)
}

func runRealC01RecoveryHelper(ctx context.Context, cli, workspace, journalPath, sessionID, threadID, commandID string) (realC01ProcessResult, error) {
	journal, err := OpenJournal(journalPath)
	if err != nil {
		return realC01ProcessResult{}, err
	}
	session, ok := journal.Session(sessionID)
	if !ok {
		_ = journal.Close()
		return realC01ProcessResult{}, fmt.Errorf("recovery helper session %q is not present in the journal", sessionID)
	}
	if session.ExternalThreadRef != threadID {
		_ = journal.Close()
		return realC01ProcessResult{}, fmt.Errorf("recovery helper thread = %q, want %q", session.ExternalThreadRef, threadID)
	}
	gateway, err := newRealC01HelperGateway(cli, workspace, nil)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	adapter, err := NewAdapter(gateway, journal, realC01AdapterConfig(workspace))
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	beforeCursor := latestRealEventCursor(journal, sessionID)
	if beforeCursor == "" {
		_ = journal.Close()
		return realC01ProcessResult{}, errors.New("recovery helper could not establish an event cursor boundary")
	}
	reconciliation, err := controller.ReconcileCommand(ctx, commandID)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	recoveredGatewaySession, err := gateway.RecoveredSession(threadID)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := waitForRealObservedEventAfter(ctx, journal, sessionID, threadID, recoveredGatewaySession.Generation, beforeCursor, protocol.EventTypeReconciliationCompleted, "thread/resume"); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	finalAck, err := journal.LookupCommand(commandID)
	if err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	result := realC01ProcessResult{
		Mode:                  "recover",
		ProcessID:             os.Getpid(),
		ProcessStartToken:     realC01ProcessToken(),
		SessionID:             sessionID,
		ThreadID:              threadID,
		NativeTurnID:          valueOrEmpty(finalAck.RunID),
		NativeOperationID:     valueOrEmpty(finalAck.OperationID),
		ReconciliationState:   reconciliation.State,
		ReconciliationNote:    valueOrEmpty(reconciliation.Note),
		FinalAckState:         finalAck.State,
		RecoveryEventObserved: true,
	}
	if err := gateway.CloseSession(context.Background(), recoveredGatewaySession); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := adapter.CloseSession(context.Background(), session); err != nil {
		_ = journal.Close()
		return realC01ProcessResult{}, err
	}
	if err := journal.Close(); err != nil {
		return realC01ProcessResult{}, err
	}
	return result, nil
}

func runRealC01PendingApprovalRecoveryHelper(ctx context.Context, cli, workspace, journalPath, sessionID, threadID, requestID string) (realC01PendingApprovalResult, error) {
	journal, err := OpenJournal(journalPath)
	if err != nil {
		return realC01PendingApprovalResult{}, err
	}
	session, ok := journal.Session(sessionID)
	if !ok {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, fmt.Errorf("pending-approval helper session %q is not present in the journal", sessionID)
	}
	if session.ExternalThreadRef != threadID {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, fmt.Errorf("pending-approval helper thread = %q, want %q", session.ExternalThreadRef, threadID)
	}
	pending, err := journal.FindPendingApproval(sessionID, "", json.RawMessage(requestID))
	if err != nil {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, fmt.Errorf("find pending approval %s: %w", requestID, err)
	}
	result := realC01PendingApprovalResult{
		Mode:                        "recover-pending-approval",
		ProcessID:                   os.Getpid(),
		ProcessStartToken:           realC01ProcessToken(),
		SessionID:                   sessionID,
		ThreadID:                    threadID,
		TurnID:                      pending.TurnID,
		RequestID:                   string(pending.RequestID),
		Revision:                    pending.Revision,
		InitialGeneration:           pending.Generation,
		NativeApprovalEventObserved: realC01ApprovalRequestEventObserved(journal, sessionID, pending.RequestID),
	}
	if !result.NativeApprovalEventObserved {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, errors.New("pending-approval helper could not verify the original app-server approval event")
	}

	gateway, err := newRealC01HelperGateway(cli, workspace, nil)
	if err != nil {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, err
	}
	adapter, err := NewAdapter(gateway, journal, realC01AdapterConfig(workspace))
	if err != nil {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, err
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, err
	}
	if err := controller.ensureAdapterSession(ctx, session); err != nil {
		result.RecoveryError = err.Error()
		result.ResolutionEventCount = realC01ApprovalResolutionEventCount(journal, sessionID, pending.RequestID)
		if closeErr := journal.Close(); closeErr != nil {
			return result, closeErr
		}
		result.ApprovalClaimRecordCount, err = realC01ApprovalClaimRecordCount(journalPath, sessionID, pending.RequestID)
		return result, err
	}
	recoveredGatewaySession, err := gateway.RecoveredSession(threadID)
	if err != nil {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, err
	}
	result.RecoveredGeneration = recoveredGatewaySession.Generation

	firstCommand := realApprovalCommand("c01-pending-restart-claim-one", protocol.CommandKindRunApprove, sessionID, pending)
	result.FirstCommandID = firstCommand.CommandID
	firstAck, firstErr := adapter.SendCommand(ctx, session, firstCommand)
	result.FirstState = firstAck.State
	if firstErr != nil {
		result.FirstError = firstErr.Error()
	}
	secondCommand := realApprovalCommand("c01-pending-restart-claim-two", protocol.CommandKindRunApprove, sessionID, pending)
	result.SecondCommandID = secondCommand.CommandID
	secondAck, secondErr := adapter.SendCommand(ctx, session, secondCommand)
	result.SecondState = secondAck.State
	if secondErr != nil {
		result.SecondError = secondErr.Error()
	}
	result.ResolutionEventCount = realC01ApprovalResolutionEventCount(journal, sessionID, pending.RequestID)
	if err := adapter.CloseSession(context.Background(), session); err != nil {
		_ = gateway.CloseSession(context.Background(), recoveredGatewaySession)
		_ = journal.Close()
		return realC01PendingApprovalResult{}, err
	}
	if err := gateway.CloseSession(context.Background(), recoveredGatewaySession); err != nil {
		_ = journal.Close()
		return realC01PendingApprovalResult{}, err
	}
	if err := journal.Close(); err != nil {
		return realC01PendingApprovalResult{}, err
	}
	result.ApprovalClaimRecordCount, err = realC01ApprovalClaimRecordCount(journalPath, sessionID, pending.RequestID)
	if err != nil {
		return realC01PendingApprovalResult{}, err
	}
	return result, nil
}

func realC01ApprovalRequestEventObserved(journal *Journal, sessionID string, requestID json.RawMessage) bool {
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, Limit: 1000})
	if err != nil {
		return false
	}
	for _, event := range page.Events {
		if event.Type != protocol.EventTypeApprovalRequested || event.Source != protocol.EventSourceAppServer {
			continue
		}
		if realC01ApprovalIDsMatch(realC01ApprovalRequestID(event.Payload), requestID) {
			return true
		}
	}
	return false
}

func realC01ApprovalResolutionEventCount(journal *Journal, sessionID string, requestID json.RawMessage) int {
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, Limit: 1000})
	if err != nil {
		return -1
	}
	count := 0
	for _, event := range page.Events {
		if event.Type == protocol.EventTypeApprovalResolved && event.Source == protocol.EventSourceAppServer && realC01ApprovalIDsMatch(realC01ApprovalRequestID(event.Payload), requestID) {
			count++
		}
	}
	return count
}

func realC01ApprovalClaimRecordCount(path, sessionID string, requestID json.RawMessage) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	count := 0
	for {
		var record journalRecord
		err := decoder.Decode(&record)
		if errors.Is(err, io.EOF) {
			return count, nil
		}
		if err != nil {
			return 0, err
		}
		if record.Type == "approval_claim" && record.ApprovalClaim != nil && record.ApprovalClaim.SessionID == sessionID && realC01ApprovalIDsMatch(record.ApprovalClaim.RequestID, requestID) {
			count++
		}
	}
}

func realC01ApprovalRequestID(payload json.RawMessage) json.RawMessage {
	var envelope struct {
		ID     json.RawMessage `json:"id"`
		Params struct {
			RequestID json.RawMessage `json:"requestId"`
		} `json:"params"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return nil
	}
	if len(bytes.TrimSpace(envelope.ID)) > 0 && !bytes.Equal(bytes.TrimSpace(envelope.ID), []byte("null")) {
		return envelope.ID
	}
	return envelope.Params.RequestID
}

func realC01ApprovalIDsMatch(left, right json.RawMessage) bool {
	if len(bytes.TrimSpace(left)) == 0 || len(bytes.TrimSpace(right)) == 0 {
		return false
	}
	return approvalIDIdentity(left) == approvalIDIdentity(right) || approvalIDText(left) == approvalIDText(right)
}

func newRealC01HelperGateway(cli, workspace string, afterRequestWrite func(string)) (*Gateway, error) {
	return NewGateway(GatewayConfig{
		Process: ProcessTransportConfig{CommandPath: cli, WorkingDir: workspace},
		TransportFactory: func(factoryCtx context.Context) (RPCTransport, error) {
			processConfig := ProcessTransportConfig{CommandPath: cli, WorkingDir: workspace, afterRequestWrite: afterRequestWrite}
			return NewProcessTransport(context.WithoutCancel(factoryCtx), processConfig)
		},
	})
}

func realC01AdapterConfig(workspace string) AdapterConfig {
	return AdapterConfig{
		Model:           "gpt-5.6-luna",
		ReasoningEffort: "max",
		ApprovalPolicy:  "untrusted",
		Sandbox:         "workspace-write",
		WorkingDir:      workspace,
		ServiceName:     "loomhelm_c01_acceptance",
	}
}

func realC01ReconcileCommand(sessionID, commandID string) protocol.Command {
	return realCommand(commandID, protocol.CommandKindRunSend, sessionID, `{"prompt":"Reply exactly LOOMHELM_C01_RECONCILE_OK. Do not use tools."}`)
}

func realC01ProcessToken() string {
	return fmt.Sprintf("%d:%d", os.Getpid(), time.Now().UnixNano())
}

func writeRealC01ProcessResult(path string, result realC01ProcessResult) error {
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := writeAll(file, append(data, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func writeRealC01PendingApprovalResult(path string, result realC01PendingApprovalResult) error {
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return writeExclusiveC01Evidence(path, append(data, '\n'))
}

func writeExclusiveC01Evidence(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := writeAll(file, data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func TestWriteRealC01ProcessResultRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.json")
	link := filepath.Join(directory, "result.json")
	if err := os.WriteFile(target, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if err := writeRealC01ProcessResult(link, realC01ProcessResult{Mode: "test"}); err == nil {
		t.Fatal("C01 result writer accepted a symlink")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "sentinel" {
		t.Fatalf("C01 result writer modified symlink target: %q", data)
	}
}

func TestWriteExclusiveC01EvidenceRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.json")
	link := filepath.Join(directory, "evidence.json")
	if err := os.WriteFile(target, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if err := writeExclusiveC01Evidence(link, []byte("replacement")); err == nil {
		t.Fatal("C01 evidence writer accepted a symlink")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "sentinel" {
		t.Fatalf("C01 evidence writer modified symlink target: %q", data)
	}
}

func runRealC01Helper(ctx context.Context, t *testing.T, mode, cli, workspace, journalPath, sessionID, threadID, commandID, resultPath string) realC01ProcessResult {
	t.Helper()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRealC01ProcessHelper$", "-test.v")
	command.Env = append(os.Environ(),
		realC01HelperEnv+"="+mode,
		"LOOMHELM_REAL_C01_HELPER_CLI="+cli,
		"LOOMHELM_REAL_C01_HELPER_WORKSPACE="+workspace,
		"LOOMHELM_REAL_C01_HELPER_JOURNAL="+journalPath,
		"LOOMHELM_REAL_C01_HELPER_SESSION="+sessionID,
		"LOOMHELM_REAL_C01_HELPER_THREAD="+threadID,
		"LOOMHELM_REAL_C01_HELPER_COMMAND="+commandID,
		"LOOMHELM_REAL_C01_HELPER_RESULT="+resultPath,
	)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("C01 %s helper failed: %v\n%s", mode, err, output.String())
	}
	data, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatalf("read C01 %s helper result: %v", mode, err)
	}
	var result realC01ProcessResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode C01 %s helper result: %v", mode, err)
	}
	if result.Mode != mode {
		t.Fatalf("C01 helper mode = %q, want %q", result.Mode, mode)
	}
	return result
}

func runRealC01PendingApprovalRecoveryProcess(ctx context.Context, t *testing.T, cli, workspace, journalPath, sessionID, threadID, requestID, resultPath string) realC01PendingApprovalResult {
	t.Helper()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRealC01PendingApprovalRecoveryProcessHelper$", "-test.v")
	command.Env = append(os.Environ(),
		realC01PendingApprovalHelperEnv+"=recover",
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_CLI="+cli,
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_WORKSPACE="+workspace,
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_JOURNAL="+journalPath,
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_SESSION="+sessionID,
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_THREAD="+threadID,
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_REQUEST="+requestID,
		"LOOMHELM_REAL_C01_PENDING_APPROVAL_RESULT="+resultPath,
	)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("C01 pending-approval recovery helper failed: %v\n%s", err, output.String())
	}
	data, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatalf("read C01 pending-approval recovery result: %v", err)
	}
	var result realC01PendingApprovalResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode C01 pending-approval recovery result: %v", err)
	}
	if result.Mode != "recover-pending-approval" {
		t.Fatalf("C01 pending-approval helper mode = %q", result.Mode)
	}
	return result
}

func TestRealC01PendingApprovalConnectorRestartSingleClaim(t *testing.T) {
	cli := strings.TrimSpace(os.Getenv("LOOMHELM_REAL_CODEX_CLI"))
	if cli == "" {
		t.Skip("set LOOMHELM_REAL_CODEX_CLI to run the disposable C01 pending-approval restart acceptance")
	}
	workspace := privateTestDir(t)
	journalPath := filepath.Join(workspace, "connector.jsonl")
	journ, err := OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	journalOpen := true
	t.Cleanup(func() {
		if journalOpen {
			_ = journ.Close()
		}
	})

	gateway, err := newRealC01HelperGateway(cli, workspace, nil)
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := NewAdapter(gateway, journ, realC01AdapterConfig(workspace))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	createRequest := protocol.NewSessionRequest{CommandID: "c01-pending-restart-session"}
	gatewaySession, err := gateway.StartNewSession(ctx, createRequest)
	if err != nil {
		t.Fatal(err)
	}
	activeSession, err := adapter.StartSession(ctx, gatewaySession, createRequest)
	if err != nil {
		_ = gateway.CloseSession(context.Background(), gatewaySession)
		t.Fatal(err)
	}
	parentSessionOpen := true
	t.Cleanup(func() {
		if parentSessionOpen {
			_ = adapter.CloseSession(context.Background(), activeSession)
			_ = gateway.CloseSession(context.Background(), gatewaySession)
		}
	})

	approvalCommand := realCommand("c01-pending-restart", protocol.CommandKindRunSend, activeSession.SessionID, `{"prompt":"Run exactly this harmless command in the test workspace: /usr/bin/printf LOOMHELM_C01_PENDING. Do not use any other tool. After it completes, reply exactly LOOMHELM_C01_PENDING_OK."}`)
	approvalAck, err := adapter.SendCommand(ctx, activeSession, approvalCommand)
	if err != nil {
		t.Fatal(err)
	}
	approval, err := waitForRealApproval(ctx, journ, activeSession.SessionID, gatewaySession.Generation, valueOrEmpty(approvalAck.RunID))
	if err != nil {
		t.Fatal(err)
	}
	if approval.TurnID == "" || approval.ItemID == "" || len(bytes.TrimSpace(approval.RequestID)) == 0 {
		t.Fatalf("pending approval identity is incomplete: %+v", approval)
	}
	if approval.TurnID != valueOrEmpty(approvalAck.RunID) {
		t.Fatalf("pending approval turn = %q, turn/start ACK = %q", approval.TurnID, valueOrEmpty(approvalAck.RunID))
	}
	if !realC01ApprovalRequestEventObserved(journ, activeSession.SessionID, approval.RequestID) {
		t.Fatal("parent Connector did not persist the native approval.requested event")
	}
	if approval.Generation != gatewaySession.Generation {
		t.Fatalf("pending approval generation = %q, initial gateway generation = %q", approval.Generation, gatewaySession.Generation)
	}
	requestID := string(approval.RequestID)
	resultPath := filepath.Join(workspace, "c01-pending-approval-recovery-result.json")
	if err := adapter.CloseSession(context.Background(), activeSession); err != nil {
		t.Fatal(err)
	}
	if err := gateway.CloseSession(context.Background(), gatewaySession); err != nil {
		t.Fatal(err)
	}
	if err := journ.Close(); err != nil {
		t.Fatal(err)
	}
	parentSessionOpen = false
	journalOpen = false

	child := runRealC01PendingApprovalRecoveryProcess(ctx, t, cli, workspace, journalPath, activeSession.SessionID, activeSession.ExternalThreadRef, requestID, resultPath)
	if child.ProcessID == 0 || child.ProcessID == os.Getpid() {
		t.Fatalf("recovery Connector PID = %d, parent PID = %d", child.ProcessID, os.Getpid())
	}
	if child.ProcessStartToken == "" {
		t.Fatal("recovery Connector did not report a process start token")
	}
	if child.SessionID != activeSession.SessionID || child.ThreadID != activeSession.ExternalThreadRef || child.TurnID != approval.TurnID || child.RequestID != requestID {
		t.Fatalf("pending approval identity changed across Connector restart: %+v", child)
	}
	if child.Revision != approval.Revision || child.InitialGeneration != gatewaySession.Generation {
		t.Fatalf("pending approval durable identity changed across restart: %+v", child)
	}
	if child.RecoveredGeneration == "" || child.RecoveredGeneration == child.InitialGeneration {
		t.Fatalf("recovery did not establish a new Connector generation: %+v", child)
	}
	if !child.NativeApprovalEventObserved {
		t.Fatal("recovery Connector did not observe the original native approval event")
	}
	if child.RecoveryError != "" {
		t.Fatalf("thread/resume recovery failed before approval handling: %s", child.RecoveryError)
	}
	if child.FirstState != protocol.CommandStateRejected || child.SecondState != protocol.CommandStateRejected {
		t.Fatalf("stale approval decisions were not explicitly rejected: first=%q (%s), second=%q (%s)", child.FirstState, child.FirstError, child.SecondState, child.SecondError)
	}
	if child.FirstError == "" || child.SecondError == "" {
		t.Fatalf("rejected approval decisions did not preserve errors: %+v", child)
	}
	if child.ResolutionEventCount != 0 {
		t.Fatalf("Connector restart emitted native approval resolution events: %d", child.ResolutionEventCount)
	}
	if child.ApprovalClaimRecordCount > 1 {
		t.Fatalf("Connector restart created duplicate approval claims: %d", child.ApprovalClaimRecordCount)
	}

	reopened, err := OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	remaining, err := reopened.FindPendingApproval(activeSession.SessionID, "", approval.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	if remaining.Generation != gatewaySession.Generation || remaining.TurnID != approval.TurnID {
		t.Fatalf("old approval ownership changed after rejected restart attempts: %+v", remaining)
	}
	if realC01ApprovalResolutionEventCount(reopened, activeSession.SessionID, approval.RequestID) != 0 {
		t.Fatal("old approval gained a resolution after the original Connector owner disappeared")
	}
	t.Logf("independent Connector restart: parent_pid=%d child_pid=%d thread=%s turn=%s request=%s initial_generation=%s recovered_generation=%s first=%s second=%s native_resolutions=%d journal_claim_records=%d", os.Getpid(), child.ProcessID, activeSession.ExternalThreadRef, approval.TurnID, requestID, gatewaySession.Generation, child.RecoveredGeneration, child.FirstState, child.SecondState, child.ResolutionEventCount, child.ApprovalClaimRecordCount)
}

func TestRealC01AdapterApprovalInterruptAndRecovery(t *testing.T) {
	cli := os.Getenv("LOOMHELM_REAL_CODEX_CLI")
	evidencePath := os.Getenv("LOOMHELM_REAL_C01_EVIDENCE")
	if cli == "" {
		if evidencePath != "" {
			t.Fatal("LOOMHELM_REAL_CODEX_CLI is required when writing C01 evidence")
		}
		t.Skip("set LOOMHELM_REAL_CODEX_CLI to run the disposable C01 host-owned acceptance")
	}
	candidateSHA := os.Getenv("LOOMHELM_CANDIDATE_SHA")
	expectedCLIVersion := os.Getenv("LOOMHELM_REAL_C01_CLI_VERSION")
	expectedCLISHA256 := os.Getenv("LOOMHELM_REAL_C01_CLI_SHA256")
	if evidencePath != "" {
		if candidateSHA == "" {
			t.Fatal("LOOMHELM_CANDIDATE_SHA is required when writing C01 evidence")
		}
		if expectedCLIVersion == "" || expectedCLISHA256 == "" {
			t.Fatal("LOOMHELM_REAL_C01_CLI_VERSION and LOOMHELM_REAL_C01_CLI_SHA256 are required when writing C01 evidence")
		}
		actualSHA, err := currentCandidateSHA()
		if err != nil {
			t.Fatal(err)
		}
		if actualSHA != candidateSHA {
			t.Fatalf("candidate SHA = %s, want current HEAD %s", candidateSHA, actualSHA)
		}
	}

	workspace := os.Getenv("LOOMHELM_REAL_C01_WORKSPACE")
	if workspace == "" {
		workspace = privateTestDir(t)
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(workspace); statErr == nil {
		if !info.IsDir() {
			t.Fatal("LOOMHELM_REAL_C01_WORKSPACE must be a directory")
		}
		entries, readErr := os.ReadDir(workspace)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if len(entries) != 0 {
			t.Fatal("LOOMHELM_REAL_C01_WORKSPACE must be empty")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal(statErr)
	} else if mkdirErr := os.MkdirAll(workspace, 0o700); mkdirErr != nil {
		t.Fatal(mkdirErr)
	}

	identity, err := realCLIIdentityFor(cli)
	if err != nil {
		t.Fatal(err)
	}
	if expectedCLIVersion != "" && identity.Version != expectedCLIVersion {
		t.Fatalf("Codex CLI version = %q, want pinned version %q", identity.Version, expectedCLIVersion)
	}
	if expectedCLISHA256 != "" && identity.SHA256 != expectedCLISHA256 {
		t.Fatalf("Codex CLI SHA-256 = %q, want pinned SHA-256 %q", identity.SHA256, expectedCLISHA256)
	}
	acceptance := realC01Acceptance{
		CandidateSHA:             candidateSHA,
		AcceptanceContractDigest: "66684bc0b0b72c626c6a7d5ac9c4d432b467981aaf24c9f9459f052d1fd6cf2e",
		ScenarioSetDigest:        "f7d31c1e74093b10e288193ee6ef53683731d6cade7a84e3612bc0bd4e544321",
		EvidenceStatus:           "running",
		CLI:                      identity,
		Transport:                "host-owned stdio JSONL app-server",
		Model:                    "gpt-5.6-luna",
		Effort:                   "max",
		Workspace:                workspace,
		Scenarios:                make([]realC01ScenarioEvidence, 0, 4),
	}
	writeEvidence := func() error {
		if evidencePath == "" {
			return nil
		}
		data, marshalErr := json.MarshalIndent(redactC01Acceptance(acceptance), "", "  ")
		if marshalErr != nil {
			return fmt.Errorf("marshal C01 evidence: %w", marshalErr)
		}
		if mkdirErr := os.MkdirAll(filepath.Dir(evidencePath), 0o700); mkdirErr != nil {
			return fmt.Errorf("create C01 evidence directory: %w", mkdirErr)
		}
		if writeErr := writeExclusiveC01Evidence(evidencePath, append(data, '\n')); writeErr != nil {
			return fmt.Errorf("write C01 evidence without replacement: %w", writeErr)
		}
		return nil
	}
	t.Cleanup(func() {
		if acceptance.EvidenceStatus == "running" {
			acceptance.EvidenceStatus = "failed"
		}
		if err := writeEvidence(); err != nil {
			t.Error(err)
		}
	})

	journalPath := filepath.Join(workspace, "connector.jsonl")
	var journal *Journal
	journal, err = OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })

	gateway, err := newRealC01HelperGateway(cli, workspace, nil)
	if err != nil {
		t.Fatal(err)
	}
	adapterConfig := realC01AdapterConfig(workspace)
	var adapter *Adapter
	adapter, err = NewAdapter(gateway, journal, adapterConfig)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	createRequest := protocol.NewSessionRequest{CommandID: "c01-session-create"}
	gatewaySession, err := gateway.StartNewSession(ctx, createRequest)
	if err != nil {
		t.Fatal(err)
	}
	activeSession, err := adapter.StartSession(ctx, gatewaySession, createRequest)
	if err != nil {
		_ = gateway.CloseSession(context.Background(), gatewaySession)
		t.Fatal(err)
	}
	acceptance.ThreadID = activeSession.ExternalThreadRef
	acceptance.SessionID = activeSession.SessionID
	currentGatewaySession := gatewaySession
	parentSessionOpen := true
	t.Cleanup(func() {
		if parentSessionOpen {
			_ = adapter.CloseSession(context.Background(), activeSession)
			_ = gateway.CloseSession(context.Background(), currentGatewaySession)
		}
	})

	attachCtx, attachCancel := context.WithTimeout(ctx, 5*time.Second)
	_, attachErr := gateway.AttachActiveSession(attachCtx, protocol.ExistingSessionRequest{ActiveThreadRef: activeSession.ExternalThreadRef})
	attachCancel()
	if !errors.Is(attachErr, protocol.ErrUnsupportedSessionPath) {
		t.Fatalf("active Desktop attach error = %v, want %v", attachErr, protocol.ErrUnsupportedSessionPath)
	}
	acceptance.AttachError = attachErr.Error()

	approvalCommand := realCommand("c01-approve", protocol.CommandKindRunSend, activeSession.SessionID, `{"prompt":"Run exactly this harmless command in the test workspace: /usr/bin/printf LOOMHELM_C01_APPROVED. Do not use any other tool. After it completes, reply exactly LOOMHELM_C01_APPROVE_OK."}`)
	approvalEvidence := realC01ScenarioEvidence{Name: "approval_accept", CommandID: approvalCommand.CommandID}
	approvalAck, err := adapter.SendCommand(ctx, activeSession, approvalCommand)
	if err != nil {
		t.Fatal(err)
	}
	approvalEvidence.RunID = valueOrEmpty(approvalAck.RunID)
	approval, err := waitForRealApproval(ctx, journal, activeSession.SessionID, gatewaySession.Generation, valueOrEmpty(approvalAck.RunID))
	if err != nil {
		t.Fatal(err)
	}
	approvalEvidence.ApprovalRequestID = string(approval.RequestID)
	approvalEvidence.Decision = "approve"
	if err := requireRealApprovalCommand(approval, "/bin/zsh -lc '/usr/bin/printf LOOMHELM_C01_APPROVED'"); err != nil {
		t.Fatal(err)
	}
	approvalDecision := realApprovalCommand("c01-approve-decision", protocol.CommandKindRunApprove, activeSession.SessionID, approval)
	decisionAck, err := adapter.SendCommand(ctx, activeSession, approvalDecision)
	if err != nil {
		t.Fatal(err)
	}
	approvalEvidence.ApprovalCommandState = decisionAck.State
	if decisionAck.State != protocol.CommandStateSucceeded {
		t.Fatalf("approval decision ACK = %+v", decisionAck)
	}
	itemEvent, err := waitForRealItemStatus(ctx, journal, activeSession.SessionID, activeSession.ExternalThreadRef, gatewaySession.Generation, valueOrEmpty(approvalAck.RunID), approval.ItemID, "completed")
	if err != nil {
		t.Fatal(err)
	}
	approvalEvidence.ItemStatus = itemStatus(itemEvent)
	approvalCommandObserved, approvalOutput := itemCommandAndOutput(itemEvent)
	approvalEvidence.ItemCommand = approvalCommandObserved
	approvalEvidence.CommandMatchesExpected = strings.TrimSpace(approvalCommandObserved) == "/bin/zsh -lc '/usr/bin/printf LOOMHELM_C01_APPROVED'"
	approvalEvidence.OutputMarker = "LOOMHELM_C01_APPROVED"
	approvalEvidence.OutputMarkerObserved = strings.Contains(approvalOutput, approvalEvidence.OutputMarker)
	if !approvalEvidence.CommandMatchesExpected || !approvalEvidence.OutputMarkerObserved {
		t.Fatal("accepted command did not match the fixed allowlist and output marker")
	}
	terminalEvent, err := waitForRealTerminalEvent(ctx, journal, activeSession.SessionID, activeSession.ExternalThreadRef, gatewaySession.Generation, valueOrEmpty(approvalAck.RunID), protocol.EventTypeRunCompleted, protocol.EventTypeRunFailed)
	if err != nil {
		t.Fatal(err)
	}
	approvalEvidence.TerminalEventType = terminalEvent.Type
	approvalEvidence.TerminalStatus = turnStatus(terminalEvent)
	approvalEvidence.TerminalCursor = terminalEvent.Cursor
	if terminalEvent.Type != protocol.EventTypeRunCompleted {
		t.Fatalf("approval terminal event = %+v", terminalEvent)
	}
	acceptance.Scenarios = append(acceptance.Scenarios, approvalEvidence)

	denialCommand := realCommand("c01-deny", protocol.CommandKindRunSend, activeSession.SessionID, `{"prompt":"Run exactly this harmless command in the test workspace: /usr/bin/printf LOOMHELM_C01_DENIED. Do not use any other tool. After it completes, reply exactly LOOMHELM_C01_DENY_OK."}`)
	denialEvidence := realC01ScenarioEvidence{Name: "approval_deny", CommandID: denialCommand.CommandID}
	denialAck, err := adapter.SendCommand(ctx, activeSession, denialCommand)
	if err != nil {
		t.Fatal(err)
	}
	denialEvidence.RunID = valueOrEmpty(denialAck.RunID)
	denialApproval, err := waitForRealApproval(ctx, journal, activeSession.SessionID, gatewaySession.Generation, valueOrEmpty(denialAck.RunID))
	if err != nil {
		t.Fatal(err)
	}
	denialEvidence.ApprovalRequestID = string(denialApproval.RequestID)
	denialEvidence.Decision = "deny"
	if err := requireRealApprovalCommand(denialApproval, "/bin/zsh -lc '/usr/bin/printf LOOMHELM_C01_DENIED'"); err != nil {
		t.Fatal(err)
	}
	denialDecision := realApprovalCommand("c01-deny-decision", protocol.CommandKindRunDeny, activeSession.SessionID, denialApproval)
	denialDecisionAck, err := adapter.SendCommand(ctx, activeSession, denialDecision)
	if err != nil {
		t.Fatal(err)
	}
	denialEvidence.ApprovalCommandState = denialDecisionAck.State
	if denialDecisionAck.State != protocol.CommandStateSucceeded {
		t.Fatalf("denial decision ACK = %+v", denialDecisionAck)
	}
	denialItem, err := waitForRealItemStatus(ctx, journal, activeSession.SessionID, activeSession.ExternalThreadRef, gatewaySession.Generation, valueOrEmpty(denialAck.RunID), denialApproval.ItemID, "declined")
	if err != nil {
		t.Fatal(err)
	}
	denialEvidence.ItemStatus = itemStatus(denialItem)
	denialCommandObserved, denialOutput := itemCommandAndOutput(denialItem)
	denialEvidence.ItemCommand = denialCommandObserved
	denialEvidence.CommandMatchesExpected = strings.TrimSpace(denialCommandObserved) == "/bin/zsh -lc '/usr/bin/printf LOOMHELM_C01_DENIED'"
	denialEvidence.OutputMarker = "LOOMHELM_C01_DENIED"
	denialEvidence.OutputEmpty = denialOutput == ""
	if !denialEvidence.CommandMatchesExpected || !denialEvidence.OutputEmpty {
		t.Fatal("denied command did not match the fixed allowlist or produced output")
	}
	denialTerminal, err := waitForRealTerminalEvent(ctx, journal, activeSession.SessionID, activeSession.ExternalThreadRef, gatewaySession.Generation, valueOrEmpty(denialAck.RunID), protocol.EventTypeRunCompleted, protocol.EventTypeRunFailed)
	if err != nil {
		t.Fatal(err)
	}
	denialEvidence.TerminalEventType = denialTerminal.Type
	denialEvidence.TerminalStatus = turnStatus(denialTerminal)
	denialEvidence.TerminalCursor = denialTerminal.Cursor
	if denialTerminal.Type != protocol.EventTypeRunCompleted {
		t.Fatalf("denial terminal event = %+v", denialTerminal)
	}
	acceptance.Scenarios = append(acceptance.Scenarios, denialEvidence)

	interruptCommand := realCommand("c01-interrupt", protocol.CommandKindRunSend, activeSession.SessionID, `{"prompt":"Run exactly this harmless command in the test workspace: /bin/sleep 30. Do not use any other tool. After it completes, reply exactly LOOMHELM_C01_INTERRUPT_OK."}`)
	interruptEvidence := realC01ScenarioEvidence{Name: "interrupt", CommandID: interruptCommand.CommandID}
	interruptAck, err := adapter.SendCommand(ctx, activeSession, interruptCommand)
	if err != nil {
		t.Fatal(err)
	}
	interruptEvidence.RunID = valueOrEmpty(interruptAck.RunID)
	interruptApproval, err := waitForRealApproval(ctx, journal, activeSession.SessionID, gatewaySession.Generation, valueOrEmpty(interruptAck.RunID))
	if err != nil {
		t.Fatal(err)
	}
	interruptEvidence.ApprovalRequestID = string(interruptApproval.RequestID)
	interruptEvidence.Decision = "approve"
	if err := requireRealApprovalCommand(interruptApproval, "/bin/zsh -lc '/bin/sleep 30'"); err != nil {
		t.Fatal(err)
	}
	interruptDecision := realApprovalCommand("c01-interrupt-approval", protocol.CommandKindRunApprove, activeSession.SessionID, interruptApproval)
	interruptDecisionAck, err := adapter.SendCommand(ctx, activeSession, interruptDecision)
	if err != nil {
		t.Fatal(err)
	}
	interruptEvidence.ApprovalCommandState = interruptDecisionAck.State
	if interruptDecisionAck.State != protocol.CommandStateSucceeded {
		t.Fatalf("interrupt approval ACK = %+v", interruptDecisionAck)
	}
	interruptStarted, err := waitForRealItemStarted(ctx, journal, activeSession.SessionID, activeSession.ExternalThreadRef, gatewaySession.Generation, valueOrEmpty(interruptAck.RunID), interruptApproval.ItemID)
	if err != nil {
		t.Fatal(err)
	}
	interruptEvidence.ItemCommand, _ = itemCommandAndOutput(interruptStarted)
	interruptEvidence.CommandMatchesExpected = strings.TrimSpace(interruptEvidence.ItemCommand) == "/bin/zsh -lc '/bin/sleep 30'"
	if !interruptEvidence.CommandMatchesExpected {
		t.Fatal("interrupt command did not match the fixed allowlist")
	}
	interruptControl := protocol.Command{
		CommandID: "c01-interrupt-control",
		IssuedAt:  now(),
		Kind:      protocol.CommandKindRunInterrupt,
		Payload:   json.RawMessage(`{"reason":"C01 acceptance interrupt"}`),
		RunID:     interruptAck.RunID,
		SessionID: activeSession.SessionID,
	}
	interruptControlAck, err := adapter.SendCommand(ctx, activeSession, interruptControl)
	if err != nil {
		t.Fatal(err)
	}
	if interruptControlAck.State != protocol.CommandStateSucceeded {
		t.Fatalf("interrupt control ACK = %+v", interruptControlAck)
	}
	interruptTerminal, err := waitForRealTerminalEvent(ctx, journal, activeSession.SessionID, activeSession.ExternalThreadRef, gatewaySession.Generation, valueOrEmpty(interruptAck.RunID), protocol.EventTypeRunInterrupted, protocol.EventTypeRunFailed)
	if err != nil {
		t.Fatal(err)
	}
	interruptEvidence.TerminalEventType = interruptTerminal.Type
	interruptEvidence.TerminalStatus = turnStatus(interruptTerminal)
	interruptEvidence.TerminalCursor = interruptTerminal.Cursor
	if interruptTerminal.Type != protocol.EventTypeRunInterrupted {
		t.Fatalf("interrupt terminal event = %+v", interruptTerminal)
	}
	acceptance.Scenarios = append(acceptance.Scenarios, interruptEvidence)

	unknownCommand := realC01ReconcileCommand(activeSession.SessionID, "c01-reconcile")
	recoveryEvidence := realC01ScenarioEvidence{
		Name:      "disconnect_restart_reconcile",
		CommandID: unknownCommand.CommandID,
	}
	if err := adapter.CloseSession(context.Background(), activeSession); err != nil {
		t.Fatal(err)
	}
	if err := gateway.CloseSession(context.Background(), currentGatewaySession); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	parentSessionOpen = false
	seedResult := runRealC01Helper(ctx, t, "seed", cli, workspace, journalPath, activeSession.SessionID, activeSession.ExternalThreadRef, unknownCommand.CommandID, filepath.Join(workspace, "c01-seed-result.json"))
	if seedResult.ProcessID == os.Getpid() || seedResult.ProcessID == 0 {
		t.Fatalf("seed helper PID = %d, parent PID = %d", seedResult.ProcessID, os.Getpid())
	}
	if seedResult.ProcessStartToken == "" {
		t.Fatal("seed helper did not report a process start token")
	}
	if seedResult.UnknownAckState != protocol.CommandStateUnknown {
		t.Fatalf("seed helper ACK state = %q", seedResult.UnknownAckState)
	}
	if seedResult.NativeTurnID == "" || seedResult.NativeOperationID == "" {
		t.Fatal("seed helper did not observe a run identity for the unknown command")
	}
	recoveryEvidence.UnknownAckState = seedResult.UnknownAckState
	recoveryEvidence.NativeTurnID = seedResult.NativeTurnID
	recoveryEvidence.NativeOperationID = seedResult.NativeOperationID
	recoveryEvidence.ConnectorProcessIDs = []int{seedResult.ProcessID}
	recoveryResult := runRealC01Helper(ctx, t, "recover", cli, workspace, journalPath, activeSession.SessionID, activeSession.ExternalThreadRef, unknownCommand.CommandID, filepath.Join(workspace, "c01-recovery-result.json"))
	if recoveryResult.ProcessID == os.Getpid() || recoveryResult.ProcessID == seedResult.ProcessID || recoveryResult.ProcessID == 0 {
		t.Fatalf("recovery helper PID = %d, seed helper PID = %d, parent PID = %d", recoveryResult.ProcessID, seedResult.ProcessID, os.Getpid())
	}
	if recoveryResult.ProcessStartToken == "" || recoveryResult.ProcessStartToken == seedResult.ProcessStartToken {
		t.Fatalf("recovery helper process token = %q, seed helper process token = %q", recoveryResult.ProcessStartToken, seedResult.ProcessStartToken)
	}
	recoveryEvidence.ConnectorProcessIDs = append(recoveryEvidence.ConnectorProcessIDs, recoveryResult.ProcessID)
	recoveryEvidence.IndependentProcessRestart = true
	if !recoveryResult.RecoveryEventObserved {
		t.Fatal("recovery helper did not observe the thread/resume completion event")
	}
	recoveryEvidence.ReconciliationState = recoveryResult.ReconciliationState
	recoveryEvidence.ReconciliationNote = recoveryResult.ReconciliationNote
	recoveryEvidence.RecoveryEventObserved = recoveryResult.RecoveryEventObserved
	journal, err = OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	recoveredSession, ok := journal.Session(activeSession.SessionID)
	if !ok {
		t.Fatal("recovered adapter session was not present in the journal")
	}
	recoveryEvidence.RecoveryThreadID = recoveredSession.ExternalThreadRef
	if recoveredSession.ExternalThreadRef != activeSession.ExternalThreadRef {
		t.Fatalf("recovered thread = %q, want %q", recoveredSession.ExternalThreadRef, activeSession.ExternalThreadRef)
	}
	finalAck, err := journal.LookupCommand(unknownCommand.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	if recoveryResult.NativeOperationID != seedResult.NativeOperationID || valueOrEmpty(finalAck.OperationID) != seedResult.NativeOperationID {
		t.Fatalf("native operation identity changed across restart: seed = %q, helper = %q, final ACK = %q", seedResult.NativeOperationID, recoveryResult.NativeOperationID, valueOrEmpty(finalAck.OperationID))
	}
	if recoveryResult.NativeTurnID != seedResult.NativeTurnID || valueOrEmpty(finalAck.RunID) != seedResult.NativeTurnID {
		t.Fatalf("native turn identity changed across restart: seed = %q, helper = %q, final ACK = %q", seedResult.NativeTurnID, recoveryResult.NativeTurnID, valueOrEmpty(finalAck.RunID))
	}
	recoveryEvidence.NativeTurnID = seedResult.NativeTurnID
	recoveryEvidence.NativeOperationID = seedResult.NativeOperationID
	if recoveryResult.ReconciliationState != protocol.ReconciliationStateConfirmed || (finalAck.State != protocol.CommandStateSucceeded && finalAck.State != protocol.CommandStateFailed) {
		t.Fatalf("command reconciliation = %+v, final ACK = %+v", recoveryResult, finalAck)
	}
	acceptance.Scenarios = append(acceptance.Scenarios, recoveryEvidence)
	acceptance.EvidenceStatus = "passed"
}

func realCLIIdentityFor(path string) (realCLIIdentity, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return realCLIIdentity{}, err
	}
	versionOutput, err := exec.Command(absPath, "--version").CombinedOutput()
	if err != nil {
		return realCLIIdentity{}, fmt.Errorf("read Codex CLI version: %w", err)
	}
	version := strings.TrimSpace(string(versionOutput))
	file, err := os.Open(absPath)
	if err != nil {
		return realCLIIdentity{}, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return realCLIIdentity{}, err
	}
	return realCLIIdentity{Path: absPath, Version: version, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func currentCandidateSHA() (string, error) {
	status, err := exec.Command("git", "status", "--porcelain", "--untracked-files=all").Output()
	if err != nil {
		return "", fmt.Errorf("read candidate worktree status: %w", err)
	}
	if len(bytes.TrimSpace(status)) != 0 {
		return "", errors.New("candidate worktree must be clean when writing C01 evidence")
	}
	output, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("read candidate SHA: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

func redactC01Acceptance(value realC01Acceptance) realC01Acceptance {
	value.CLI.Path = "<configured-codex-cli>"
	value.Workspace = "<disposable-test-workspace>"
	value.ThreadID = redactC01Ref(value.ThreadID)
	value.SessionID = redactC01Ref(value.SessionID)
	value.Scenarios = append([]realC01ScenarioEvidence(nil), value.Scenarios...)
	for index := range value.Scenarios {
		scenario := &value.Scenarios[index]
		scenario.RunID = redactC01Ref(scenario.RunID)
		scenario.ApprovalRequestID = redactC01Ref(scenario.ApprovalRequestID)
		scenario.NativeTurnID = redactC01Ref(scenario.NativeTurnID)
		scenario.NativeOperationID = redactC01Ref(scenario.NativeOperationID)
		scenario.RecoveryThreadID = redactC01Ref(scenario.RecoveryThreadID)
		scenario.TerminalCursor = redactC01Ref(scenario.TerminalCursor)
		if scenario.ItemCommand != "" {
			scenario.ItemCommand = "<redacted-command>"
		}
		if scenario.ReconciliationNote != "" {
			scenario.ReconciliationNote = "<redacted>"
		}
	}
	return value
}

func requireRealApprovalCommand(approval PendingApproval, expected string) error {
	command := strings.TrimSpace(approval.Command)
	if command == "" {
		return errors.New("approval request did not expose a command for pre-approval validation")
	}
	if command != expected {
		return errors.New("approval command did not match the fixed C01 allowlist")
	}
	return nil
}

func redactC01Ref(value string) string {
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(digest[:])[:16]
}

func realCommand(id string, kind protocol.CommandKind, sessionID, payload string) protocol.Command {
	return protocol.Command{CommandID: id, IssuedAt: now(), Kind: kind, Payload: json.RawMessage(payload), SessionID: sessionID}
}

func realApprovalCommand(id string, kind protocol.CommandKind, sessionID string, approval PendingApproval) protocol.Command {
	decision := "deny"
	if kind == protocol.CommandKindRunApprove {
		decision = "approve"
	}
	payload, err := json.Marshal(map[string]any{
		"approval_id": json.RawMessage(approval.RequestID),
		"command_id":  id,
		"decision":    decision,
		"revision":    approval.Revision,
	})
	if err != nil {
		panic(err)
	}
	return protocol.Command{CommandID: id, IssuedAt: now(), Kind: kind, Payload: payload, RunID: stringPointer(approval.TurnID), SessionID: sessionID}
}

func waitForRealApproval(ctx context.Context, journal *Journal, sessionID, generation, runID string) (PendingApproval, error) {
	var approval PendingApproval
	err := waitForRealCondition(ctx, func() bool {
		values := journal.PendingApprovalsForGeneration(sessionID, generation, runID)
		if len(values) != 1 {
			return false
		}
		approval = values[0]
		return true
	})
	return approval, err
}

func waitForRealItemStarted(ctx context.Context, journal *Journal, sessionID, threadID, generation, runID, itemID string) (protocol.Event, error) {
	return waitForRealObservedEventValue(ctx, journal, realC01ObservedQuery{
		AdapterSessionID:  sessionID,
		ExternalThreadRef: threadID,
		Generation:        generation,
		NativeTurnID:      runID,
		EventType:         protocol.EventTypeItemStarted,
		ItemID:            itemID,
	}, func(event protocol.Event) bool {
		var payload struct {
			Params struct {
				Item struct {
					Type string `json:"type"`
				} `json:"item"`
			} `json:"params"`
		}
		return json.Unmarshal(event.Payload, &payload) == nil && payload.Params.Item.Type == "commandExecution"
	})
}

func waitForRealItemStatus(ctx context.Context, journal *Journal, sessionID, threadID, generation, runID, itemID, want string) (protocol.Event, error) {
	return waitForRealObservedEventValue(ctx, journal, realC01ObservedQuery{
		AdapterSessionID:  sessionID,
		ExternalThreadRef: threadID,
		Generation:        generation,
		NativeTurnID:      runID,
		EventType:         protocol.EventTypeItemCompleted,
		ItemID:            itemID,
	}, func(event protocol.Event) bool {
		return itemType(event) == "commandExecution" && itemStatus(event) == want
	})
}

func waitForRealTerminalEvent(ctx context.Context, journal *Journal, sessionID, threadID, generation, runID string, types ...protocol.EventType) (protocol.Event, error) {
	wanted := make(map[protocol.EventType]struct{}, len(types))
	for _, eventType := range types {
		wanted[eventType] = struct{}{}
	}
	return waitForRealObservedEventValue(ctx, journal, realC01ObservedQuery{
		AdapterSessionID:  sessionID,
		ExternalThreadRef: threadID,
		Generation:        generation,
		NativeTurnID:      runID,
	}, func(event protocol.Event) bool {
		_, ok := wanted[event.Type]
		return ok
	})
}

func waitForRealObservedEvent(ctx context.Context, journal *Journal, sessionID, threadID, generation string, eventType protocol.EventType, method string) error {
	_, err := waitForRealObservedEventValue(ctx, journal, realC01ObservedQuery{
		AdapterSessionID:  sessionID,
		ExternalThreadRef: threadID,
		Generation:        generation,
		EventType:         eventType,
	}, func(event protocol.Event) bool {
		if method == "" {
			return true
		}
		var payload struct {
			Method string `json:"method"`
		}
		return json.Unmarshal(event.Payload, &payload) == nil && payload.Method == method
	})
	return err
}

func waitForRealObservedEventAfter(ctx context.Context, journal *Journal, sessionID, threadID, generation, afterCursor string, eventType protocol.EventType, method string) error {
	_, err := waitForRealObservedEventValueAfter(ctx, journal, realC01ObservedQuery{
		AdapterSessionID:  sessionID,
		ExternalThreadRef: threadID,
		Generation:        generation,
		AfterCursor:       afterCursor,
		EventType:         eventType,
	}, func(event protocol.Event) bool {
		if method == "" {
			return true
		}
		var payload struct {
			Method string `json:"method"`
		}
		return json.Unmarshal(event.Payload, &payload) == nil && payload.Method == method
	})
	return err
}

func waitForRealObservedOperationAfter(ctx context.Context, journal *Journal, sessionID, threadID, generation, operationID, afterCursor string, predicate func(protocol.Event) bool) (protocol.Event, error) {
	return waitForRealObservedEventValueAfter(ctx, journal, realC01ObservedQuery{
		AdapterSessionID:  sessionID,
		ExternalThreadRef: threadID,
		Generation:        generation,
		NativeOperationID: operationID,
		AfterCursor:       afterCursor,
		EventType:         protocol.EventTypeUnknown,
	}, predicate)
}

type realC01ObservedQuery struct {
	AdapterSessionID  string
	ExternalThreadRef string
	Generation        string
	NativeTurnID      string
	NativeOperationID string
	AfterCursor       string
	EventType         protocol.EventType
	ItemID            string
	Limit             int
}

func waitForRealObservedEventValue(ctx context.Context, journal *Journal, query realC01ObservedQuery, predicate func(protocol.Event) bool) (protocol.Event, error) {
	return waitForRealObservedEventValueAfter(ctx, journal, query, predicate)
}

func waitForRealObservedEventValueAfter(ctx context.Context, journal *Journal, query realC01ObservedQuery, predicate func(protocol.Event) bool) (protocol.Event, error) {
	var found protocol.Event
	var queryErr error
	err := waitForRealCondition(ctx, func() bool {
		page, err := readRealC01ObservedEvents(journal, query)
		if err != nil {
			queryErr = err
			return true
		}
		for _, event := range page.Events {
			if query.EventType != "" && event.Type != query.EventType {
				continue
			}
			if predicate(event) {
				found = event
				return true
			}
		}
		return false
	})
	if err != nil {
		return found, err
	}
	return found, queryErr
}

func readRealC01ObservedEvents(journal *Journal, query realC01ObservedQuery) (protocol.EventPage, error) {
	if journal == nil {
		return protocol.EventPage{}, errors.New("real C01 observed-event journal is required")
	}
	if query.AdapterSessionID == "" || query.ExternalThreadRef == "" || query.Generation == "" {
		return protocol.EventPage{}, errors.New("real C01 observed-event identity is incomplete")
	}
	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}

	journal.mu.Lock()
	defer journal.mu.Unlock()
	start := 0
	if query.AfterCursor != "" {
		index, found := journal.eventIndexByCursor[query.AfterCursor]
		if !found || index < 0 || index >= len(journal.events) {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		boundary := journal.events[index]
		observed, found := journal.observedEvents[boundary.EventID]
		if !found || observed.Observation.AdapterSessionID != query.AdapterSessionID || observed.Observation.ExternalThreadRef != query.ExternalThreadRef {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		start = index + 1
	}

	page := protocol.EventPage{Events: make([]protocol.Event, 0, limit)}
	for index := start; index < len(journal.events); index++ {
		event := journal.events[index]
		observed, found := journal.observedEvents[event.EventID]
		if !found {
			continue
		}
		identity := observed.Observation
		if identity.AdapterSessionID != query.AdapterSessionID || identity.ExternalThreadRef != query.ExternalThreadRef || identity.Generation != query.Generation {
			continue
		}
		if query.NativeTurnID != "" && identity.NativeTurnID != query.NativeTurnID {
			continue
		}
		if query.NativeOperationID != "" && identity.NativeOperationID != query.NativeOperationID {
			continue
		}
		if query.EventType != "" && event.Type != query.EventType {
			continue
		}
		if query.ItemID != "" && realC01ObservedItemID(event) != query.ItemID {
			continue
		}
		if int64(len(page.Events)) >= int64(limit) {
			page.HasMore = true
			page.NextCursor = stringPointer(page.Events[len(page.Events)-1].Cursor)
			break
		}
		page.Events = append(page.Events, cloneEvent(event))
	}
	return page, nil
}

func realC01ObservedItemID(event protocol.Event) string {
	var payload struct {
		Params struct {
			ItemID string `json:"itemId"`
			Item   struct {
				ID string `json:"id"`
			} `json:"item"`
		} `json:"params"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return ""
	}
	if payload.Params.Item.ID != "" {
		return payload.Params.Item.ID
	}
	return payload.Params.ItemID
}

func realC01ObservedNativeTurn(journal *Journal, event protocol.Event) string {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	observed, ok := journal.observedEvents[event.EventID]
	if !ok {
		return ""
	}
	return observed.Observation.NativeTurnID
}

func TestRealC01ObservedEventQueryRequiresExactIdentity(t *testing.T) {
	journal, err := OpenJournal(filepath.Join(privateTestDir(t), "connector.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()

	appendObserved := func(eventID, cursor, sessionID, threadID, generation, turnID, operationID, itemID string, eventType protocol.EventType, sequence int64) {
		t.Helper()
		payload := fmt.Sprintf(`{"method":"item/completed","params":{"threadId":%q,"turnId":%q,"item":{"id":%q,"type":"commandExecution","status":"completed"}}}`, threadID, turnID, itemID)
		if eventType == protocol.EventTypeUnknown {
			payload = `{"jsonrpc":"2.0","id":7,"result":{"ok":true}}`
		}
		_, _, err := journal.AppendObservedEventWithRecord(protocol.Event{
			EventID:   eventID,
			Cursor:    cursor,
			Sequence:  sequence,
			SessionID: sessionID,
			Source:    protocol.EventSourceAppServer,
			Type:      eventType,
			Payload:   json.RawMessage(payload),
		}, EventObservation{
			AdapterSessionID:  sessionID,
			ExternalThreadRef: threadID,
			Generation:        generation,
			NativeTurnID:      turnID,
			NativeOperationID: operationID,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	appendObserved("event-1", "cursor-1", "adapter-1", "thread-1", "generation-1", "turn-1", "", "item-1", protocol.EventTypeItemCompleted, 1)
	appendObserved("event-2", "cursor-2", "adapter-1", "thread-1", "generation-1", "turn-1", "", "item-2", protocol.EventTypeItemCompleted, 2)
	appendObserved("event-3", "cursor-3", "adapter-1", "thread-1", "generation-2", "turn-2", "", "item-3", protocol.EventTypeItemCompleted, 3)
	appendObserved("event-operation", "cursor-operation", "adapter-1", "thread-1", "generation-2", "", "operation-1", "", protocol.EventTypeUnknown, 4)
	appendObserved("event-foreign", "cursor-foreign", "adapter-foreign", "thread-foreign", "generation-foreign", "turn-foreign", "", "item-foreign", protocol.EventTypeItemCompleted, 1)

	base := realC01ObservedQuery{
		AdapterSessionID:  "adapter-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
		EventType:         protocol.EventTypeItemCompleted,
		ItemID:            "item-1",
	}
	page, err := readRealC01ObservedEvents(journal, base)
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != "event-1" {
		t.Fatalf("exact observed event query = %+v, err=%v", page, err)
	}
	if got := realC01ObservedNativeTurn(journal, page.Events[0]); got != "turn-1" {
		t.Fatalf("native turn = %q, want turn-1", got)
	}

	for name, query := range map[string]realC01ObservedQuery{
		"wrong adapter session": func() realC01ObservedQuery { value := base; value.AdapterSessionID = "adapter-other"; return value }(),
		"wrong thread":          func() realC01ObservedQuery { value := base; value.ExternalThreadRef = "thread-other"; return value }(),
		"wrong generation":      func() realC01ObservedQuery { value := base; value.Generation = "generation-2"; return value }(),
		"wrong native turn":     func() realC01ObservedQuery { value := base; value.NativeTurnID = "turn-other"; return value }(),
		"wrong item identity":   func() realC01ObservedQuery { value := base; value.ItemID = "item-other"; return value }(),
	} {
		t.Run(name, func(t *testing.T) {
			page, err := readRealC01ObservedEvents(journal, query)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Events) != 0 {
				t.Fatalf("wrong identity matched %d events", len(page.Events))
			}
		})
	}

	page, err = readRealC01ObservedEvents(journal, realC01ObservedQuery{
		AdapterSessionID:  "adapter-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
		EventType:         protocol.EventTypeItemCompleted,
		Limit:             1,
	})
	if err != nil || len(page.Events) != 1 || !page.HasMore || page.NextCursor == nil || page.Events[0].EventID != "event-1" {
		t.Fatalf("paginated generation-1 page = %+v, err=%v", page, err)
	}
	page, err = readRealC01ObservedEvents(journal, realC01ObservedQuery{
		AdapterSessionID:  "adapter-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-1",
		NativeTurnID:      "turn-1",
		AfterCursor:       *page.NextCursor,
		EventType:         protocol.EventTypeItemCompleted,
	})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != "event-2" {
		t.Fatalf("paginated generation-1 continuation = %+v, err=%v", page, err)
	}

	page, err = readRealC01ObservedEvents(journal, realC01ObservedQuery{
		AdapterSessionID:  "adapter-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-2",
		NativeTurnID:      "turn-2",
		AfterCursor:       "cursor-2",
		EventType:         protocol.EventTypeItemCompleted,
	})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != "event-3" {
		t.Fatalf("reconnected after-cursor page = %+v, err=%v", page, err)
	}

	page, err = readRealC01ObservedEvents(journal, realC01ObservedQuery{
		AdapterSessionID:  "adapter-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-2",
		NativeOperationID: "operation-1",
		EventType:         protocol.EventTypeUnknown,
	})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != "event-operation" {
		t.Fatalf("operation identity query = %+v, err=%v", page, err)
	}

	_, err = readRealC01ObservedEvents(journal, realC01ObservedQuery{
		AdapterSessionID:  "adapter-1",
		ExternalThreadRef: "thread-1",
		Generation:        "generation-2",
		AfterCursor:       "cursor-foreign",
	})
	if !errors.Is(err, protocol.ErrCursorExpired) {
		t.Fatalf("foreign after-cursor error = %v, want %v", err, protocol.ErrCursorExpired)
	}
}

func latestRealEventCursor(journal *Journal, sessionID string) string {
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, Limit: 1000})
	if err != nil || len(page.Events) == 0 {
		return ""
	}
	return page.Events[len(page.Events)-1].Cursor
}

func waitForRealCondition(ctx context.Context, condition func() bool) error {
	if condition() {
		return nil
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if condition() {
				return nil
			}
		}
	}
}

func itemStatus(event protocol.Event) string {
	var payload struct {
		Params struct {
			Item struct {
				Status string `json:"status"`
			} `json:"item"`
		} `json:"params"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return ""
	}
	return payload.Params.Item.Status
}

func itemType(event protocol.Event) string {
	var payload struct {
		Params struct {
			Item struct {
				Type string `json:"type"`
			} `json:"item"`
		} `json:"params"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return ""
	}
	return payload.Params.Item.Type
}

func itemCommandAndOutput(event protocol.Event) (string, string) {
	var payload struct {
		Params struct {
			Item struct {
				Command          string `json:"command"`
				AggregatedOutput string `json:"aggregatedOutput"`
			} `json:"item"`
		} `json:"params"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return "", ""
	}
	return payload.Params.Item.Command, payload.Params.Item.AggregatedOutput
}

func turnStatus(event protocol.Event) string {
	var payload struct {
		Params struct {
			Turn struct {
				Status string `json:"status"`
			} `json:"turn"`
		} `json:"params"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return ""
	}
	return payload.Params.Turn.Status
}
