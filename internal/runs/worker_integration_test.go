package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
	"github.com/riverqueue/river"
)

func TestPersistentRunWorkerReconcilesExplicitObservations(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "worker-generation-opaque"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create worker session: %v", err)
	}
	store := NewStore(db.Pool())
	if _, err := store.CreateRun(ctx, NewRunInput{
		ID:         ids.run,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: generation,
	}); err != nil {
		t.Fatalf("create worker run: %v", err)
	}

	observations := []RunObservation{
		{},
		workerObservation(ids.session, ids.run, generation, protocol.ReconciliationStateConfirmed, protocol.RunStatusPending, "cursor-invalid", "malformed"),
		workerObservation(ids.session, ids.run, generation, protocol.ReconciliationStateConfirmed, protocol.RunStatusRunning, "cursor-running", ""),
		workerObservation(ids.session, ids.run, generation, protocol.ReconciliationStateConfirmed, protocol.RunStatusWaitingApproval, "cursor-waiting", "approval required"),
		workerObservation(ids.session, ids.run, generation, protocol.ReconciliationStateConfirmed, protocol.RunStatusCompleted, "cursor-completed", "done"),
	}
	calls := 0
	worker := &RunWorker{
		Store: store,
		Observer: ObserverFunc(func(_ context.Context, _ Run) (RunObservation, error) {
			if calls >= len(observations) {
				return RunObservation{}, fmt.Errorf("unexpected duplicate observation call %d", calls+1)
			}
			observation := observations[calls]
			calls++
			return observation, nil
		}),
	}
	job := &river.Job[RunJobArgs]{Args: RunJobArgs{RunID: ids.run, Generation: generation}}

	if err := worker.Work(ctx, job); !errors.Is(err, ErrObserverUnavailable) {
		t.Fatalf("empty observation error = %v, want %v", err, ErrObserverUnavailable)
	}
	pending, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read pending run: %v", err)
	}
	if pending.Status != protocol.RunStatusPending || pending.LastCursor != "" {
		t.Fatalf("empty observation changed pending run = %+v", pending)
	}
	if err := worker.Work(ctx, job); !errors.Is(err, ErrInvalidObservation) {
		t.Fatalf("malformed observation error = %v, want %v", err, ErrInvalidObservation)
	}
	stillPending, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read pending run after malformed observation: %v", err)
	}
	if stillPending.Status != protocol.RunStatusPending || stillPending.LastCursor != "" {
		t.Fatalf("malformed observation changed pending run = %+v", stillPending)
	}

	for _, want := range []protocol.RunStatus{protocol.RunStatusRunning, protocol.RunStatusWaitingApproval, protocol.RunStatusCompleted} {
		if err := worker.Work(ctx, job); err != nil {
			t.Fatalf("observation for %s: %v", want, err)
		}
		current, err := store.GetRun(ctx, ids.run)
		if err != nil {
			t.Fatalf("read run after %s observation: %v", want, err)
		}
		if current.Status != want {
			t.Fatalf("run after %s observation = %+v", want, current)
		}
	}
	if calls != 5 {
		t.Fatalf("observer calls before duplicate terminal job = %d, want 5", calls)
	}

	terminal, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read terminal run: %v", err)
	}
	if err := worker.Work(ctx, job); err != nil {
		t.Fatalf("duplicate terminal job: %v", err)
	}
	if calls != 5 {
		t.Fatalf("duplicate terminal job invoked observer, calls = %d", calls)
	}
	afterDuplicate, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read run after duplicate terminal job: %v", err)
	}
	if afterDuplicate != terminal {
		t.Fatalf("duplicate terminal job changed run: before=%+v after=%+v", terminal, afterDuplicate)
	}
}

func TestPersistentRunWorkerDoesNotInferNativeStartFromCommandAck(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for _, commandState := range []protocol.CommandState{
		protocol.CommandStateExecuting,
		protocol.CommandStateSucceeded,
	} {
		ids := executionTestIDs()
		cleanupExecutionRows(t, &db, ids)
		generation := "worker-native-start-" + string(commandState)
		if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
			ID:                ids.session,
			Path:              protocol.SessionPathNew,
			ExternalThreadRef: ids.thread,
			Generation:        generation,
		}); err != nil {
			t.Fatalf("create %s session: %v", commandState, err)
		}

		runID := ids.run
		command := protocol.Command{
			CommandID: ids.command,
			Kind:      protocol.CommandKindRunSend,
			Payload:   json.RawMessage(`{"prompt":"ack without native start"}`),
			RunID:     &runID,
			SessionID: ids.session,
		}
		store := NewStore(db.Pool())
		if _, _, err := store.AcceptRun(ctx, CommandIntent{Command: command, Generation: generation}, NewRunInput{
			ID:         ids.run,
			SessionID:  ids.session,
			CommandID:  ids.command,
			Generation: generation,
		}); err != nil {
			t.Fatalf("accept %s run: %v", commandState, err)
		}
		if _, err := store.RecordExactCommandAck(ctx, protocol.CommandAck{
			CommandID: ids.command,
			RunID:     &runID,
			State:     commandState,
		}); err != nil {
			t.Fatalf("record %s command ACK: %v", commandState, err)
		}

		worker := &RunWorker{Store: store, Observer: NewDurableObserver(store)}
		err := worker.Work(ctx, &river.Job[RunJobArgs]{Args: RunJobArgs{RunID: ids.run, Generation: generation}})
		if !errors.Is(err, ErrObserverUnavailable) {
			t.Fatalf("%s worker error = %v, want retryable observer unavailability", commandState, err)
		}
		current, err := store.GetRun(ctx, ids.run)
		if err != nil {
			t.Fatalf("read %s run after ACK-only observation: %v", commandState, err)
		}
		if current.Status != protocol.RunStatusPending || current.LastCursor != "" {
			t.Fatalf("%s ACK-only observation changed run = %+v", commandState, current)
		}
		page, err := store.ReadEvents(ctx, protocol.EventQuery{SessionID: ids.session, RunID: ids.run, Limit: 10})
		if err != nil {
			t.Fatalf("read %s native events: %v", commandState, err)
		}
		if len(page.Events) != 0 {
			t.Fatalf("%s ACK-only observation persisted native events = %+v", commandState, page.Events)
		}
	}
}

func TestPersistentRunWorkerRecoversUnknownAndLeavesCancellationUnchanged(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "worker-generation-recovery"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create recovery session: %v", err)
	}
	store := NewStore(db.Pool())
	unknownRunID := ids.unknownRun
	if _, err := store.CreateRun(ctx, NewRunInput{
		ID:         unknownRunID,
		SessionID:  ids.session,
		CommandID:  ids.unknownCommand,
		Generation: generation,
	}); err != nil {
		t.Fatalf("create unknown run: %v", err)
	}
	if _, err := store.Start(ctx, unknownRunID, generation, "cursor-start"); err != nil {
		t.Fatalf("start unknown run: %v", err)
	}
	if _, err := store.MarkRunUnknown(ctx, unknownRunID, generation, "cursor-disconnect", "observer disconnected"); err != nil {
		t.Fatalf("mark unknown run: %v", err)
	}

	observations := []RunObservation{}
	worker := &RunWorker{
		Store: store,
		Observer: ObserverFunc(func(_ context.Context, run Run) (RunObservation, error) {
			if len(observations) == 0 {
				observations = append(observations, RunObservation{})
				return RunObservation{}, nil
			}
			return workerObservation(run.SessionID, run.ID, run.Generation, protocol.ReconciliationStateConfirmed, protocol.RunStatusCompleted, "cursor-recovered", "reconciled"), nil
		}),
	}
	if err := worker.Work(ctx, &river.Job[RunJobArgs]{Args: RunJobArgs{RunID: unknownRunID, Generation: generation}}); !errors.Is(err, ErrObserverUnavailable) {
		t.Fatalf("unknown run without observation error = %v, want %v", err, ErrObserverUnavailable)
	}
	stillUnknown, err := store.GetRun(ctx, unknownRunID)
	if err != nil {
		t.Fatalf("read unknown run before recovery: %v", err)
	}
	if stillUnknown.Status != protocol.RunStatusUnknown || stillUnknown.LastCursor != "cursor-disconnect" {
		t.Fatalf("unknown run changed before trusted observation = %+v", stillUnknown)
	}
	if err := worker.Work(ctx, &river.Job[RunJobArgs]{Args: RunJobArgs{RunID: unknownRunID, Generation: generation}}); err != nil {
		t.Fatalf("recover unknown run: %v", err)
	}
	recovered, err := store.GetRun(ctx, unknownRunID)
	if err != nil {
		t.Fatalf("read recovered run: %v", err)
	}
	if recovered.Status != protocol.RunStatusCompleted || recovered.LastCursor != "cursor-recovered" {
		t.Fatalf("recovered run = %+v", recovered)
	}

	canceledRunID := ids.run
	if _, err := store.CreateRun(ctx, NewRunInput{
		ID:         canceledRunID,
		SessionID:  ids.session,
		CommandID:  ids.command,
		Generation: generation,
	}); err != nil {
		t.Fatalf("create canceled run: %v", err)
	}
	cancellationWorker := &RunWorker{
		Store: store,
		Observer: ObserverFunc(func(context.Context, Run) (RunObservation, error) {
			return RunObservation{}, context.Canceled
		}),
	}
	cancelErr := cancellationWorker.Work(ctx, &river.Job[RunJobArgs]{Args: RunJobArgs{RunID: canceledRunID, Generation: generation}})
	var jobCancel *river.JobCancelError
	if !errors.As(cancelErr, &jobCancel) || !errors.Is(cancelErr, context.Canceled) {
		t.Fatalf("observer cancellation error = %v, want JobCancel(context.Canceled)", cancelErr)
	}
	canceledRun, err := store.GetRun(ctx, canceledRunID)
	if err != nil {
		t.Fatalf("read canceled run: %v", err)
	}
	if canceledRun.Status != protocol.RunStatusPending || canceledRun.LastCursor != "" {
		t.Fatalf("observer cancellation changed run = %+v", canceledRun)
	}

	leaseRunID := ids.run + "-lease-loss"
	if _, err := store.CreateRun(ctx, NewRunInput{
		ID:         leaseRunID,
		SessionID:  ids.session,
		CommandID:  ids.command + "-lease-loss",
		Generation: generation,
	}); err != nil {
		t.Fatalf("create lease-loss run: %v", err)
	}
	lease := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              leaseRunID,
		Generation:         generation,
		OwnerID:            "worker-owner",
		CandidateSourceSHA: "worker-source",
		ArtifactDigest:     "worker-artifact",
	}
	if _, err := store.AcquireLease(ctx, lease, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire worker lease: %v", err)
	}
	leaseLossWorker := &RunWorker{
		Store:        store,
		RequireLease: true,
		Observer: ObserverFunc(func(context.Context, Run) (RunObservation, error) {
			return RunObservation{}, ErrLeaseLost
		}),
	}
	leaseLossErr := leaseLossWorker.Work(ctx, &river.Job[RunJobArgs]{Args: RunJobArgs{
		RunID:              leaseRunID,
		Generation:         generation,
		LeaseKey:           lease.LeaseKey,
		OwnerID:            lease.OwnerID,
		CandidateSourceSHA: lease.CandidateSourceSHA,
		ArtifactDigest:     lease.ArtifactDigest,
	}})
	if !errors.As(leaseLossErr, &jobCancel) || !errors.Is(leaseLossErr, ErrLeaseLost) {
		t.Fatalf("observer lease-loss error = %v, want JobCancel(ErrLeaseLost)", leaseLossErr)
	}
	leaseLossRun, err := store.GetRun(ctx, leaseRunID)
	if err != nil {
		t.Fatalf("read lease-loss run: %v", err)
	}
	if leaseLossRun.Status != protocol.RunStatusPending || leaseLossRun.LastCursor != "" {
		t.Fatalf("observer lease loss changed run = %+v", leaseLossRun)
	}
}

func TestPersistentRunWorkerRejectsStaleObservationSnapshot(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	const generation = "worker-generation-cas"

	if _, err := sessions.NewStore(db.Pool()).Create(ctx, sessions.NewInput{
		ID:                ids.session,
		Path:              protocol.SessionPathNew,
		ExternalThreadRef: ids.thread,
		Generation:        generation,
	}); err != nil {
		t.Fatalf("create CAS session: %v", err)
	}
	store := NewStore(db.Pool())
	if _, err := store.CreateRun(ctx, NewRunInput{ID: ids.run, SessionID: ids.session, CommandID: ids.command, Generation: generation}); err != nil {
		t.Fatalf("create CAS run: %v", err)
	}
	worker := &RunWorker{
		Store: store,
		Observer: ObserverFunc(func(ctx context.Context, run Run) (RunObservation, error) {
			if _, err := store.Start(ctx, run.ID, generation, "cursor-concurrent"); err != nil {
				return RunObservation{}, err
			}
			return workerObservation(run.SessionID, run.ID, run.Generation, protocol.ReconciliationStateConfirmed, protocol.RunStatusCompleted, "cursor-stale", "old observation"), nil
		}),
	}
	err := worker.Work(ctx, &river.Job[RunJobArgs]{Args: RunJobArgs{RunID: ids.run, Generation: generation}})
	if !errors.Is(err, ErrStaleRunObservation) {
		t.Fatalf("stale observation error = %v, want %v", err, ErrStaleRunObservation)
	}
	current, err := store.GetRun(ctx, ids.run)
	if err != nil {
		t.Fatalf("read CAS run: %v", err)
	}
	if current.Status != protocol.RunStatusRunning || current.LastCursor != "cursor-concurrent" {
		t.Fatalf("stale observation overwrote concurrent run = %+v", current)
	}
}

func TestPersistentWithLeaseTransitionsRejectMismatchedRunIdentity(t *testing.T) {
	db := openExecutionDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ids := executionTestIDs()
	cleanupExecutionRows(t, &db, ids)
	secondSessionID := ids.session + "-lease-second"
	sameSessionRunID := ids.run + "-lease-other"
	secondRunID := ids.run + "-lease-second"
	mismatchRunID := ids.run + "-lease-generation"
	t.Cleanup(func() {
		if db == nil {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, queryArgs := range []struct {
			query string
			arg   string
		}{
			{query: `DELETE FROM execution_runs WHERE id = $1`, arg: secondRunID},
			{query: `DELETE FROM execution_sessions WHERE id = $1`, arg: secondSessionID},
		} {
			if _, err := db.Pool().Exec(cleanupCtx, queryArgs.query, queryArgs.arg); err != nil {
				t.Errorf("cleanup mismatched lease row %q: %v", queryArgs.arg, err)
			}
		}
	})
	const firstGeneration = "worker-lease-generation-1"
	const secondGeneration = "worker-lease-generation-2"
	sessionStore := sessions.NewStore(db.Pool())
	if _, err := sessionStore.Create(ctx, sessions.NewInput{ID: ids.session, Path: protocol.SessionPathNew, ExternalThreadRef: ids.thread, Generation: firstGeneration}); err != nil {
		t.Fatalf("create first lease session: %v", err)
	}
	if _, err := sessionStore.Create(ctx, sessions.NewInput{ID: secondSessionID, Path: protocol.SessionPathNew, ExternalThreadRef: ids.thread + "-lease-second", Generation: secondGeneration}); err != nil {
		t.Fatalf("create second lease session: %v", err)
	}
	store := NewStore(db.Pool())
	for _, input := range []NewRunInput{
		{ID: ids.run, SessionID: ids.session, CommandID: ids.command, Generation: firstGeneration},
		{ID: sameSessionRunID, SessionID: ids.session, CommandID: ids.command + "-lease-other", Generation: firstGeneration},
		{ID: mismatchRunID, SessionID: ids.session, CommandID: ids.command + "-lease-generation", Generation: secondGeneration},
		{ID: secondRunID, SessionID: secondSessionID, CommandID: ids.command + "-lease-second", Generation: secondGeneration},
	} {
		if _, err := store.CreateRun(ctx, input); err != nil {
			t.Fatalf("create lease-boundary run %q: %v", input.ID, err)
		}
	}
	lease := DurableLeaseIdentity{
		LeaseKey:           ids.lease,
		SessionID:          ids.session,
		RunID:              ids.run,
		Generation:         firstGeneration,
		OwnerID:            "lease-boundary-owner",
		CandidateSourceSHA: "lease-boundary-source",
		ArtifactDigest:     "lease-boundary-artifact",
	}
	if _, err := store.AcquireLease(ctx, lease, LeaseStoreConfig{TTL: time.Minute}); err != nil {
		t.Fatalf("acquire lease-boundary lease: %v", err)
	}
	cases := []struct {
		name       string
		runID      string
		generation string
	}{
		{name: "cross-run", runID: sameSessionRunID, generation: firstGeneration},
		{name: "cross-session", runID: secondRunID, generation: secondGeneration},
		{name: "cross-generation", runID: mismatchRunID, generation: secondGeneration},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			before, err := store.GetRun(ctx, testCase.runID)
			if err != nil {
				t.Fatalf("read run before transition: %v", err)
			}
			if _, err := store.StartWithLease(ctx, testCase.runID, testCase.generation, "cursor-invalid", lease); !errors.Is(err, ErrLeaseLost) {
				t.Fatalf("mismatched lease error = %v, want %v", err, ErrLeaseLost)
			}
			after, err := store.GetRun(ctx, testCase.runID)
			if err != nil {
				t.Fatalf("read run after transition: %v", err)
			}
			if after != before {
				t.Fatalf("mismatched lease changed run: before=%+v after=%+v", before, after)
			}
		})
	}
	if _, err := store.CheckLease(ctx, lease); err != nil {
		t.Fatalf("original lease after rejected transition: %v", err)
	}
}

func workerObservation(sessionID, runID, generation string, reconciliation protocol.ReconciliationState, status protocol.RunStatus, cursor, reason string) RunObservation {
	return RunObservation{
		SessionID:      sessionID,
		RunID:          runID,
		Generation:     generation,
		Reconciliation: reconciliation,
		Status:         status,
		Cursor:         cursor,
		Reason:         reason,
	}
}
