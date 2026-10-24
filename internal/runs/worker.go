package runs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

const RunJobKind = "execution_run"

type RunJobArgs struct {
	RunID              string `json:"run_id"`
	Generation         string `json:"generation"`
	LeaseKey           string `json:"lease_key,omitempty"`
	OwnerID            string `json:"owner_id,omitempty"`
	CandidateSourceSHA string `json:"candidate_source_sha,omitempty"`
	ArtifactDigest     string `json:"artifact_digest,omitempty"`
}

func (RunJobArgs) Kind() string { return RunJobKind }

func (args RunJobArgs) LeaseIdentity(sessionID string) (DurableLeaseIdentity, error) {
	values := []string{args.LeaseKey, args.OwnerID, args.CandidateSourceSHA, args.ArtifactDigest}
	provided := false
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			provided = true
			break
		}
	}
	if !provided {
		return DurableLeaseIdentity{}, nil
	}
	identity := DurableLeaseIdentity{
		LeaseKey:           args.LeaseKey,
		SessionID:          sessionID,
		RunID:              args.RunID,
		Generation:         args.Generation,
		OwnerID:            args.OwnerID,
		CandidateSourceSHA: args.CandidateSourceSHA,
		ArtifactDigest:     args.ArtifactDigest,
	}
	if err := validateLeaseIdentity(identity); err != nil {
		return DurableLeaseIdentity{}, err
	}
	return identity, nil
}

type ExecutionResult struct {
	Status protocol.RunStatus
	Cursor string
	Reason string
}

type Executor interface {
	Execute(context.Context, Run) (ExecutionResult, error)
}

type ExecutorFunc func(context.Context, Run) (ExecutionResult, error)

func (f ExecutorFunc) Execute(ctx context.Context, run Run) (ExecutionResult, error) {
	return f(ctx, run)
}

// RunWorker is a River adapter for a durable Run. The executor is intentionally
// injected: the parent composition owns the Gateway/Connector choice while
// this worker owns fencing, unknown-outcome handling and terminal persistence.
type RunWorker struct {
	river.WorkerDefaults[RunJobArgs]
	Store         *Store
	Executor      Executor
	RequireLease  bool
	UnknownCommit time.Duration
}

func (w *RunWorker) Work(ctx context.Context, job *river.Job[RunJobArgs]) error {
	if ctx == nil {
		return river.JobCancel(errors.New("run worker context must not be nil"))
	}
	if job == nil {
		return river.JobCancel(errors.New("run worker job must not be nil"))
	}
	if w == nil || w.Store == nil {
		return river.JobCancel(errors.New("run worker store is not configured"))
	}
	if w.Executor == nil {
		return river.JobCancel(errors.New("run worker executor is not configured"))
	}
	if err := validateRunJobArgs(job.Args); err != nil {
		return river.JobCancel(err)
	}
	run, err := w.Store.GetRun(ctx, job.Args.RunID)
	if err != nil {
		if errors.Is(err, ErrRunNotFound) {
			return river.JobCancel(err)
		}
		return err
	}
	if err := run.CheckGeneration(job.Args.Generation); err != nil {
		return river.JobCancel(err)
	}
	lease, err := job.Args.LeaseIdentity(run.SessionID)
	if err != nil {
		return river.JobCancel(err)
	}
	if w.RequireLease && lease.LeaseKey == "" {
		return river.JobCancel(fmt.Errorf("%w: run worker requires a control lease", ErrInvalidLease))
	}
	if lease.LeaseKey != "" {
		if _, err := w.Store.CheckLease(ctx, lease); err != nil {
			return river.JobCancel(err)
		}
	}

	switch run.Status {
	case protocol.RunStatusPending:
		if lease.LeaseKey != "" {
			run, err = w.Store.StartWithLease(ctx, run.ID, run.Generation, run.LastCursor, lease)
		} else {
			run, err = w.Store.Start(ctx, run.ID, run.Generation, run.LastCursor)
		}
		if err != nil {
			if errors.Is(err, ErrLeaseLost) || errors.Is(err, ErrRunUnknown) {
				return river.JobCancel(err)
			}
			return err
		}
	case protocol.RunStatusRunning:
	case protocol.RunStatusWaitingApproval:
		return river.JobCancel(fmt.Errorf("%w: run is waiting for approval", ErrRunTransition))
	case protocol.RunStatusUnknown:
		return river.JobCancel(protocol.ErrUnknownCommandResult)
	default:
		if terminalRunStatus(run.Status) {
			return nil
		}
		return river.JobCancel(fmt.Errorf("%w: unsupported persisted run status %q", ErrRunTransition, run.Status))
	}

	if err := ctx.Err(); err != nil {
		return w.unknownAfterInterruption(job.Args, run, lease, err)
	}
	if lease.LeaseKey != "" {
		if _, err := w.Store.CheckLease(ctx, lease); err != nil {
			return river.JobCancel(err)
		}
	}
	result, executeErr := w.Executor.Execute(ctx, run)
	if executeErr != nil {
		if errors.Is(executeErr, protocol.ErrUnknownCommandResult) || errors.Is(executeErr, context.Canceled) || errors.Is(executeErr, context.DeadlineExceeded) {
			return w.unknownAfterInterruption(job.Args, run, lease, executeErr)
		}
		if errors.Is(executeErr, ErrLeaseLost) {
			return river.JobCancel(executeErr)
		}
		result = ExecutionResult{Status: protocol.RunStatusFailed, Cursor: result.Cursor, Reason: executeErr.Error()}
	}
	if err := ctx.Err(); err != nil {
		return w.unknownAfterInterruption(job.Args, run, lease, err)
	}
	if lease.LeaseKey != "" {
		if _, err := w.Store.CheckLease(ctx, lease); err != nil {
			return river.JobCancel(err)
		}
	}
	return w.persistExecutionResult(ctx, run, lease, result)
}

func (w *RunWorker) persistExecutionResult(ctx context.Context, run Run, lease DurableLeaseIdentity, result ExecutionResult) error {
	status := result.Status
	if status == "" {
		status = protocol.RunStatusCompleted
	}
	switch status {
	case protocol.RunStatusWaitingApproval:
		var err error
		if lease.LeaseKey != "" {
			_, err = w.Store.WaitForApprovalWithLease(ctx, run.ID, run.Generation, result.Cursor, lease)
		} else {
			_, err = w.Store.WaitForApproval(ctx, run.ID, run.Generation, result.Cursor)
		}
		if err != nil {
			if errors.Is(err, ErrLeaseLost) {
				return river.JobCancel(err)
			}
			return err
		}
		return nil
	case protocol.RunStatusCompleted, protocol.RunStatusFailed, protocol.RunStatusInterrupted:
		var err error
		if lease.LeaseKey != "" {
			_, err = w.Store.ObserveTerminalWithLease(ctx, run.ID, run.Generation, status, result.Cursor, result.Reason, lease)
		} else {
			_, err = w.Store.ObserveTerminal(ctx, run.ID, run.Generation, status, result.Cursor, result.Reason)
		}
		if err != nil {
			if errors.Is(err, ErrLeaseLost) {
				return river.JobCancel(err)
			}
			return err
		}
		return nil
	default:
		return river.JobCancel(fmt.Errorf("%w: executor returned non-terminal status %q", ErrRunTransition, status))
	}
}

func (w *RunWorker) unknownAfterInterruption(args RunJobArgs, run Run, lease DurableLeaseIdentity, cause error) error {
	commitTimeout := w.UnknownCommit
	if commitTimeout <= 0 {
		commitTimeout = 2 * time.Second
	}
	commitCtx, cancel := context.WithTimeout(context.Background(), commitTimeout)
	defer cancel()
	reason := "execution outcome is unknown"
	if cause != nil {
		reason = cause.Error()
	}
	var err error
	if lease.LeaseKey != "" {
		_, err = w.Store.MarkRunUnknownWithLease(commitCtx, run.ID, args.Generation, run.LastCursor, reason, lease)
	} else {
		_, err = w.Store.MarkRunUnknown(commitCtx, run.ID, args.Generation, run.LastCursor, reason)
	}
	if err != nil {
		if errors.Is(err, ErrLeaseLost) {
			return river.JobCancel(err)
		}
		return errors.Join(cause, fmt.Errorf("persist unknown run outcome: %w", err))
	}
	return river.JobCancel(fmt.Errorf("%w: %s", protocol.ErrUnknownCommandResult, reason))
}

func validateRunJobArgs(args RunJobArgs) error {
	if strings.TrimSpace(args.RunID) == "" || args.RunID != strings.TrimSpace(args.RunID) {
		return errors.New("run job id is required and must not have surrounding whitespace")
	}
	if strings.TrimSpace(args.Generation) == "" || args.Generation != strings.TrimSpace(args.Generation) {
		return fmt.Errorf("%w: run job generation is required", ErrStaleGeneration)
	}
	return nil
}

func EnqueueRun(ctx context.Context, client *river.Client[pgx.Tx], args RunJobArgs, opts *river.InsertOpts) (int64, error) {
	if ctx == nil {
		return 0, errors.New("run enqueue context must not be nil")
	}
	if client == nil {
		return 0, errors.New("run enqueue client must not be nil")
	}
	if err := validateRunJobArgs(args); err != nil {
		return 0, err
	}
	if opts == nil {
		opts = &river.InsertOpts{}
	}
	result, err := client.Insert(ctx, args, opts)
	if err != nil {
		return 0, fmt.Errorf("enqueue execution run: %w", err)
	}
	return result.Job.ID, nil
}
