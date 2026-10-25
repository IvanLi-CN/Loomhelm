package runs

import (
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestValidateRunObservationRequiresBoundIdentity(t *testing.T) {
	run := Run{ID: "run-1", SessionID: "session-1", Generation: "generation-opaque"}
	valid := RunObservation{
		SessionID:      run.SessionID,
		RunID:          run.ID,
		Generation:     run.Generation,
		Reconciliation: protocol.ReconciliationStateConfirmed,
		Status:         protocol.RunStatusRunning,
		Cursor:         "cursor-1",
	}
	cases := []struct {
		name   string
		mutate func(*RunObservation)
		want   error
	}{
		{name: "empty observation", mutate: func(observation *RunObservation) { *observation = RunObservation{} }, want: ErrObserverUnavailable},
		{name: "session mismatch", mutate: func(observation *RunObservation) { observation.SessionID = "other-session" }, want: ErrInvalidObservation},
		{name: "run mismatch", mutate: func(observation *RunObservation) { observation.RunID = "other-run" }, want: ErrInvalidObservation},
		{name: "generation mismatch", mutate: func(observation *RunObservation) { observation.Generation = "generation-old" }, want: ErrInvalidObservation},
		{name: "confirmed pending status", mutate: func(observation *RunObservation) { observation.Status = protocol.RunStatusPending }, want: ErrInvalidObservation},
		{name: "not found status", mutate: func(observation *RunObservation) {
			observation.Reconciliation = protocol.ReconciliationStateNotFound
			observation.Status = protocol.RunStatusFailed
		}, want: ErrInvalidObservation},
		{name: "unknown status", mutate: func(observation *RunObservation) {
			observation.Reconciliation = protocol.ReconciliationStateUnknown
			observation.Status = protocol.RunStatusRunning
		}, want: ErrInvalidObservation},
		{name: "cursor whitespace", mutate: func(observation *RunObservation) { observation.Cursor = " cursor-1" }, want: ErrInvalidObservation},
		{name: "unsupported reconciliation", mutate: func(observation *RunObservation) { observation.Reconciliation = "future" }, want: ErrInvalidObservation},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			observation := valid
			testCase.mutate(&observation)
			if err := validateRunObservation(run, observation); !errors.Is(err, testCase.want) {
				t.Fatalf("validation error = %v, want %v", err, testCase.want)
			}
		})
	}
	if err := validateRunObservation(run, valid); err != nil {
		t.Fatalf("valid observation rejected: %v", err)
	}
}

func TestApplyRunObservationUsesExplicitStateTransitions(t *testing.T) {
	newRun := func(t *testing.T) Run {
		t.Helper()
		run, err := New(NewRunInput{ID: "run-1", SessionID: "session-1", CommandID: "command-1", Generation: "generation-opaque"})
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	observation := func(status protocol.RunStatus, cursor string) Observation {
		return Observation{Reconciliation: protocol.ReconciliationStateConfirmed, Status: status, Cursor: cursor}
	}

	run, err := applyRunObservation(newRun(t), "generation-opaque", observation(protocol.RunStatusRunning, "cursor-running"))
	if err != nil || run.Status != protocol.RunStatusRunning || run.LastCursor != "cursor-running" {
		t.Fatalf("pending running observation = %+v, error = %v", run, err)
	}
	run, err = applyRunObservation(run, "generation-opaque", observation(protocol.RunStatusWaitingApproval, "cursor-waiting"))
	if err != nil || run.Status != protocol.RunStatusWaitingApproval || run.LastCursor != "cursor-waiting" {
		t.Fatalf("running waiting observation = %+v, error = %v", run, err)
	}
	if _, err := applyRunObservation(run, "generation-opaque", observation(protocol.RunStatusRunning, "cursor-backslide")); !errors.Is(err, ErrInvalidObservation) {
		t.Fatalf("waiting backslide error = %v, want %v", err, ErrInvalidObservation)
	}
	run, err = applyRunObservation(run, "generation-opaque", observation(protocol.RunStatusCompleted, "cursor-completed"))
	if err != nil || run.Status != protocol.RunStatusCompleted || run.LastCursor != "cursor-completed" {
		t.Fatalf("waiting terminal observation = %+v, error = %v", run, err)
	}
	unchanged, err := applyRunObservation(run, "generation-opaque", observation(protocol.RunStatusFailed, "cursor-overwrite"))
	if err != nil || unchanged != run {
		t.Fatalf("terminal observation changed run = before=%+v after=%+v error=%v", run, unchanged, err)
	}

	unknown, err := newRun(t).Start("generation-opaque", "cursor-start")
	if err != nil {
		t.Fatal(err)
	}
	unknown, err = unknown.MarkUnknown("generation-opaque", "cursor-unknown", "observer unavailable")
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := applyRunObservation(unknown, "generation-opaque", observation(protocol.RunStatusCompleted, "cursor-recovered"))
	if err != nil || recovered.Status != protocol.RunStatusCompleted || recovered.LastCursor != "cursor-recovered" {
		t.Fatalf("unknown recovery = %+v, error = %v", recovered, err)
	}
}

func TestValidateRunJobArgsAcceptsOpaqueGeneration(t *testing.T) {
	if err := validateRunJobArgs(RunJobArgs{RunID: "run-1", Generation: "generation-opaque-2026-10-25"}); err != nil {
		t.Fatalf("opaque generation rejected: %v", err)
	}
}
