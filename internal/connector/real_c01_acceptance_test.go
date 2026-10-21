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
	Name                   string                       `json:"name"`
	CommandID              string                       `json:"command_id"`
	RunID                  string                       `json:"run_id,omitempty"`
	ApprovalRequestID      string                       `json:"approval_request_id,omitempty"`
	Decision               string                       `json:"decision,omitempty"`
	ApprovalCommandState   protocol.CommandState        `json:"approval_command_state,omitempty"`
	ItemStatus             string                       `json:"item_status,omitempty"`
	ItemCommand            string                       `json:"item_command,omitempty"`
	OutputMarker           string                       `json:"output_marker,omitempty"`
	OutputMarkerObserved   bool                         `json:"output_marker_observed,omitempty"`
	OutputEmpty            bool                         `json:"output_empty,omitempty"`
	CommandMatchesExpected bool                         `json:"command_matches_expected,omitempty"`
	TerminalEventType      protocol.EventType           `json:"terminal_event_type,omitempty"`
	TerminalStatus         string                       `json:"terminal_status,omitempty"`
	TerminalCursor         string                       `json:"terminal_cursor,omitempty"`
	UnknownAckState        protocol.CommandState        `json:"unknown_ack_state,omitempty"`
	ReconciliationState    protocol.ReconciliationState `json:"reconciliation_state,omitempty"`
	ReconciliationNote     string                       `json:"reconciliation_note,omitempty"`
	ReconciledRunID        string                       `json:"reconciled_run_id,omitempty"`
	RecoveryThreadID       string                       `json:"recovery_thread_id,omitempty"`
	RecoveryEventObserved  bool                         `json:"recovery_event_observed"`
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
		Scenarios:                make([]realC01ScenarioEvidence, 0, 3),
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
		if writeErr := os.WriteFile(evidencePath, append(data, '\n'), 0o600); writeErr != nil {
			return fmt.Errorf("write C01 evidence: %w", writeErr)
		}
		if chmodErr := os.Chmod(evidencePath, 0o600); chmodErr != nil {
			return fmt.Errorf("secure C01 evidence permissions: %w", chmodErr)
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

	var unknownCancel context.CancelFunc
	var latestTransport *ProcessTransport
	gateway, err := NewGateway(GatewayConfig{
		Process: ProcessTransportConfig{CommandPath: cli, WorkingDir: workspace},
		TransportFactory: func(factoryCtx context.Context) (RPCTransport, error) {
			processConfig := ProcessTransportConfig{CommandPath: cli, WorkingDir: workspace}
			processConfig.afterRequestWrite = func(method string) {
				if method != "turn/start" || unknownCancel == nil {
					return
				}
				cancel := unknownCancel
				unknownCancel = nil
				cancel()
			}
			transport, transportErr := NewProcessTransport(context.WithoutCancel(factoryCtx), processConfig)
			if transportErr == nil {
				latestTransport = transport
			}
			return transport, transportErr
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	adapterConfig := AdapterConfig{
		Model:           acceptance.Model,
		ReasoningEffort: acceptance.Effort,
		ApprovalPolicy:  "untrusted",
		Sandbox:         "workspace-write",
		WorkingDir:      workspace,
		ServiceName:     "loomhelm_c01_acceptance",
	}
	var adapter *Adapter
	adapter, err = NewAdapter(gateway, journal, adapterConfig)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	gatewaySession, err := gateway.StartNewSession(ctx, protocol.NewSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	activeSession, err := adapter.StartSession(ctx, gatewaySession, protocol.NewSessionRequest{})
	if err != nil {
		_ = gateway.CloseSession(context.Background(), gatewaySession)
		t.Fatal(err)
	}
	acceptance.ThreadID = activeSession.ExternalThreadRef
	acceptance.SessionID = activeSession.SessionID
	currentGatewaySession := gatewaySession
	t.Cleanup(func() {
		_ = adapter.CloseSession(context.Background(), activeSession)
		_ = gateway.CloseSession(context.Background(), currentGatewaySession)
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
	approval, err := waitForRealApproval(ctx, journal, activeSession.SessionID)
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
	itemEvent, err := waitForRealItemStatus(ctx, journal, activeSession.SessionID, valueOrEmpty(approvalAck.RunID), "completed")
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
	terminalEvent, err := waitForRealTerminalEvent(ctx, journal, activeSession.SessionID, valueOrEmpty(approvalAck.RunID), protocol.EventTypeRunCompleted, protocol.EventTypeRunFailed)
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
	denialApproval, err := waitForRealApproval(ctx, journal, activeSession.SessionID)
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
	denialItem, err := waitForRealItemStatus(ctx, journal, activeSession.SessionID, valueOrEmpty(denialAck.RunID), "declined")
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
	denialTerminal, err := waitForRealTerminalEvent(ctx, journal, activeSession.SessionID, valueOrEmpty(denialAck.RunID), protocol.EventTypeRunCompleted, protocol.EventTypeRunFailed)
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
	interruptApproval, err := waitForRealApproval(ctx, journal, activeSession.SessionID)
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
	interruptStarted, err := waitForRealItemStarted(ctx, journal, activeSession.SessionID, valueOrEmpty(interruptAck.RunID))
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
	interruptTerminal, err := waitForRealTerminalEvent(ctx, journal, activeSession.SessionID, valueOrEmpty(interruptAck.RunID), protocol.EventTypeRunInterrupted, protocol.EventTypeRunFailed)
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

	unknownCommand := realCommand("c01-reconcile", protocol.CommandKindRunSend, activeSession.SessionID, `{"prompt":"Reply exactly LOOMHELM_C01_RECONCILE_OK. Do not use tools."}`)
	beforeRecoveryCursor := latestRealEventCursor(journal, activeSession.SessionID)
	unknownCtx, cancelUnknown := context.WithCancel(ctx)
	unknownCancel = cancelUnknown
	unknownAck, unknownErr := adapter.SendCommand(unknownCtx, activeSession, unknownCommand)
	if unknownCancel != nil {
		unknownCancel()
		unknownCancel = nil
	}
	if !errors.Is(unknownErr, protocol.ErrUnknownCommandResult) || unknownAck.State != protocol.CommandStateUnknown {
		t.Fatalf("reconciliation seed ACK = %+v, error = %v", unknownAck, unknownErr)
	}
	recoveryEvidence := realC01ScenarioEvidence{
		Name:            "disconnect_restart_reconcile",
		CommandID:       unknownCommand.CommandID,
		UnknownAckState: unknownAck.State,
	}
	if err := waitForRealRunObservation(ctx, journal, activeSession.SessionID, beforeRecoveryCursor, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	var reconciledRunID string
	if err := waitForRealCondition(ctx, func() bool {
		var ok bool
		reconciledRunID, ok = journal.UniqueRunIDForCommand(activeSession.SessionID, unknownCommand.CommandID, unknownCommand.IssuedAt)
		return ok
	}); err != nil {
		t.Fatal(err)
	}
	recoveryEvidence.ReconciledRunID = reconciledRunID
	if latestTransport == nil || latestTransport.stdout == nil {
		t.Fatal("real C01 transport was not captured")
	}
	if err := latestTransport.stdout.Close(); err != nil {
		t.Fatal(err)
	}
	if err := waitForRealEvent(ctx, journal, activeSession.SessionID, protocol.EventTypeReconciliationRequired, ""); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	journal, err = OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	adapter, err = NewAdapter(gateway, journal, adapterConfig)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := NewController(journal, adapter)
	if err != nil {
		t.Fatal(err)
	}
	reconciliation, err := controller.ReconcileCommand(ctx, unknownCommand.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	recoveredGatewaySession, err := gateway.RecoveredSession(activeSession.ExternalThreadRef)
	if err != nil {
		t.Fatal(err)
	}
	currentGatewaySession = recoveredGatewaySession
	recoveredSession, ok := journal.Session(activeSession.SessionID)
	if !ok {
		t.Fatal("recovered adapter session was not present in the journal")
	}
	recoveryEvidence.RecoveryThreadID = recoveredSession.ExternalThreadRef
	if recoveredSession.ExternalThreadRef != activeSession.ExternalThreadRef {
		t.Fatalf("recovered thread = %q, want %q", recoveredSession.ExternalThreadRef, activeSession.ExternalThreadRef)
	}
	if err := waitForRealEvent(ctx, journal, activeSession.SessionID, protocol.EventTypeReconciliationCompleted, "thread/resume"); err != nil {
		t.Fatal(err)
	}
	recoveryEvidence.RecoveryEventObserved = true
	recoveryEvidence.ReconciliationState = reconciliation.State
	recoveryEvidence.ReconciliationNote = valueOrEmpty(reconciliation.Note)
	finalAck, err := journal.LookupCommand(unknownCommand.CommandID)
	if err != nil {
		t.Fatal(err)
	}
	recoveryEvidence.ReconciledRunID = valueOrEmpty(finalAck.RunID)
	if reconciliation.State != protocol.ReconciliationStateConfirmed || (finalAck.State != protocol.CommandStateSucceeded && finalAck.State != protocol.CommandStateFailed) {
		t.Fatalf("command reconciliation = %+v, final ACK = %+v", reconciliation, finalAck)
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
		scenario.ReconciledRunID = redactC01Ref(scenario.ReconciledRunID)
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

func waitForRealApproval(ctx context.Context, journal *Journal, sessionID string) (PendingApproval, error) {
	var approval PendingApproval
	err := waitForRealCondition(ctx, func() bool {
		values := journal.PendingApprovals(sessionID, "")
		if len(values) != 1 {
			return false
		}
		approval = values[0]
		return true
	})
	return approval, err
}

func waitForRealItemStarted(ctx context.Context, journal *Journal, sessionID, runID string) (protocol.Event, error) {
	return waitForRealEventValue(ctx, journal, sessionID, protocol.EventTypeItemStarted, runID, func(event protocol.Event) bool {
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

func waitForRealItemStatus(ctx context.Context, journal *Journal, sessionID, runID, want string) (protocol.Event, error) {
	return waitForRealEventValue(ctx, journal, sessionID, protocol.EventTypeItemCompleted, runID, func(event protocol.Event) bool {
		return itemType(event) == "commandExecution" && itemStatus(event) == want
	})
}

func waitForRealTerminalEvent(ctx context.Context, journal *Journal, sessionID, runID string, types ...protocol.EventType) (protocol.Event, error) {
	wanted := make(map[protocol.EventType]struct{}, len(types))
	for _, eventType := range types {
		wanted[eventType] = struct{}{}
	}
	return waitForRealEventValue(ctx, journal, sessionID, "", runID, func(event protocol.Event) bool {
		_, ok := wanted[event.Type]
		return ok
	})
}

func waitForRealEvent(ctx context.Context, journal *Journal, sessionID string, eventType protocol.EventType, method string) error {
	_, err := waitForRealEventValue(ctx, journal, sessionID, eventType, "", func(event protocol.Event) bool {
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

func waitForRealEventValue(ctx context.Context, journal *Journal, sessionID string, eventType protocol.EventType, runID string, predicate func(protocol.Event) bool) (protocol.Event, error) {
	var found protocol.Event
	err := waitForRealCondition(ctx, func() bool {
		page, err := journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, RunID: runID, Limit: 1000})
		if err != nil {
			return false
		}
		for _, event := range page.Events {
			if eventType != "" && event.Type != eventType {
				continue
			}
			if predicate(event) {
				found = event
				return true
			}
		}
		return false
	})
	return found, err
}

func latestRealEventCursor(journal *Journal, sessionID string) string {
	page, err := journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, Limit: 1000})
	if err != nil || len(page.Events) == 0 {
		return ""
	}
	return page.Events[len(page.Events)-1].Cursor
}

func waitForRealRunObservation(ctx context.Context, journal *Journal, sessionID, afterCursor string, duration time.Duration) error {
	deadlineCtx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	return waitForRealCondition(deadlineCtx, func() bool {
		page, err := journal.ReadEvents(protocol.EventQuery{SessionID: sessionID, AfterCursor: afterCursor, Limit: 1000})
		if err != nil {
			return false
		}
		for _, event := range page.Events {
			switch event.Type {
			case protocol.EventTypeRunStarted, protocol.EventTypeRunCompleted, protocol.EventTypeRunFailed:
				return true
			}
		}
		return false
	})
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
