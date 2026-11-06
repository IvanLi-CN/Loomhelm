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

var (
	ErrObserverUnavailable = errors.New("run observation is unavailable")
	ErrInvalidObservation  = errors.New("run observation is invalid")
	ErrDeploymentLeaseLost = errors.New("deployment lease was fenced by a newer generation")
)

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

// RunObservation is the read-only result returned by an observer. The
// identity fields are part of the result so a stale or misrouted observation
// cannot be applied to a different persisted Run.
type RunObservation struct {
	SessionID      string
	RunID          string
	Generation     string
	Reconciliation protocol.ReconciliationState
	Status         protocol.RunStatus
	Cursor         string
	Reason         string
}

type Observer interface {
	Observe(context.Context, Run) (RunObservation, error)
}

type ObserverFunc func(context.Context, Run) (RunObservation, error)

func (f ObserverFunc) Observe(ctx context.Context, run Run) (RunObservation, error) {
	return f(ctx, run)
}

// RunWorker is a River adapter for a durable Run. It observes external state
// and reconciles the persisted Run; command dispatch remains Server-owned.
type RunWorker struct {
	river.WorkerDefaults[RunJobArgs]
	Store                  *Store
	Observer               Observer
	RequireLease           bool
	CheckDeploymentLease   func(context.Context) error
	CheckDeploymentLeaseTx func(context.Context, pgx.Tx) error
	ControlLeaseOwnerID    string
	CandidateSourceSHA     string
	ArtifactDigest         string
	ControlLeaseTTL        time.Duration
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
	if w.Observer == nil {
		return river.JobCancel(errors.New("run worker observer is not configured"))
	}
	if err := validateRunJobArgs(job.Args); err != nil {
		return river.JobCancel(err)
	}
	if w.CheckDeploymentLease != nil {
		if err := w.CheckDeploymentLease(ctx); err != nil {
			return river.JobCancel(err)
		}
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
	if terminalRunStatus(run.Status) {
		return nil
	}
	_, leasePtr, releaseLease, err := w.acquireControlLease(ctx, job.Args, run)
	if err != nil {
		if errors.Is(err, ErrLeaseHeld) {
			return err
		}
		return river.JobCancel(err)
	}
	if releaseLease != nil {
		defer releaseLease()
	}
	if err := ctx.Err(); err != nil {
		return river.JobCancel(err)
	}
	observation, observeErr := w.Observer.Observe(ctx, run)
	if observeErr != nil {
		if errors.Is(observeErr, context.Canceled) || errors.Is(observeErr, context.DeadlineExceeded) || errors.Is(observeErr, ErrLeaseLost) {
			return river.JobCancel(observeErr)
		}
		return fmt.Errorf("%w: %v", ErrObserverUnavailable, observeErr)
	}
	if err := validateRunObservation(run, observation); err != nil {
		return err
	}
	observationInput := Observation{
		Reconciliation: observation.Reconciliation,
		Status:         observation.Status,
		Cursor:         observation.Cursor,
		Reason:         observation.Reason,
	}
	if w.CheckDeploymentLeaseTx != nil {
		_, err = w.Store.applyObservedRunWithFence(ctx, run, job.Args.Generation, observationInput, w.CheckDeploymentLeaseTx, leasePtr)
	} else {
		if w.CheckDeploymentLease != nil {
			if err := w.CheckDeploymentLease(ctx); err != nil {
				return river.JobCancel(err)
			}
		}
		_, err = w.Store.applyObservedRun(ctx, run, job.Args.Generation, observationInput, leasePtr)
	}
	if err != nil {
		if errors.Is(err, ErrLeaseLost) || errors.Is(err, ErrDeploymentLeaseLost) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return river.JobCancel(err)
		}
		return err
	}
	return nil
}

func (w *RunWorker) acquireControlLease(ctx context.Context, args RunJobArgs, run Run) (DurableLeaseIdentity, *DurableLeaseIdentity, func(), error) {
	if strings.TrimSpace(w.ControlLeaseOwnerID) != "" {
		leaseKey := args.LeaseKey
		if strings.TrimSpace(leaseKey) == "" {
			leaseKey = RunLeaseKey(run.ID)
		}
		candidate := strings.TrimSpace(w.CandidateSourceSHA)
		if candidate == "" {
			candidate = "unknown-source"
		}
		digest := strings.TrimSpace(w.ArtifactDigest)
		if digest == "" {
			digest = "unknown-artifact"
		}
		identity := DurableLeaseIdentity{
			LeaseKey:           leaseKey,
			SessionID:          run.SessionID,
			RunID:              run.ID,
			Generation:         run.Generation,
			OwnerID:            w.ControlLeaseOwnerID,
			CandidateSourceSHA: candidate,
			ArtifactDigest:     digest,
		}
		ttl := w.ControlLeaseTTL
		if ttl <= 0 {
			ttl = defaultControlLeaseTTL
		}
		if _, err := w.Store.AcquireLease(ctx, identity, LeaseStoreConfig{TTL: ttl}); err != nil {
			return DurableLeaseIdentity{}, nil, nil, err
		}
		release := func() {
			_ = w.Store.ReleaseLease(context.Background(), identity)
		}
		return identity, &identity, release, nil
	}
	lease, err := args.LeaseIdentity(run.SessionID)
	if err != nil {
		return DurableLeaseIdentity{}, nil, nil, err
	}
	if w.RequireLease && lease.LeaseKey == "" {
		return DurableLeaseIdentity{}, nil, nil, fmt.Errorf("%w: run worker requires a control lease", ErrInvalidLease)
	}
	if lease.LeaseKey != "" {
		if _, err := w.Store.CheckLease(ctx, lease); err != nil {
			return DurableLeaseIdentity{}, nil, nil, err
		}
		return lease, &lease, nil, nil
	}
	return DurableLeaseIdentity{}, nil, nil, nil
}

func validateRunObservation(run Run, observation RunObservation) error {
	if observation.SessionID == "" && observation.RunID == "" && observation.Generation == "" && observation.Reconciliation == "" && observation.Status == "" && observation.Cursor == "" && observation.Reason == "" {
		return ErrObserverUnavailable
	}
	if observation.SessionID == "" || observation.SessionID != strings.TrimSpace(observation.SessionID) || observation.SessionID != run.SessionID {
		return fmt.Errorf("%w: observed session identity does not match run %q", ErrInvalidObservation, run.ID)
	}
	if observation.RunID == "" || observation.RunID != strings.TrimSpace(observation.RunID) || observation.RunID != run.ID {
		return fmt.Errorf("%w: observed run identity does not match run %q", ErrInvalidObservation, run.ID)
	}
	if observation.Generation == "" || observation.Generation != strings.TrimSpace(observation.Generation) || observation.Generation != run.Generation {
		return fmt.Errorf("%w: observed generation does not match run %q", ErrInvalidObservation, run.ID)
	}
	if observation.Cursor != strings.TrimSpace(observation.Cursor) {
		return fmt.Errorf("%w: observation cursor must not have surrounding whitespace", ErrInvalidObservation)
	}
	switch observation.Reconciliation {
	case protocol.ReconciliationStateConfirmed:
		switch observation.Status {
		case protocol.RunStatusRunning, protocol.RunStatusWaitingApproval, protocol.RunStatusCompleted, protocol.RunStatusFailed, protocol.RunStatusInterrupted:
			return nil
		default:
			return fmt.Errorf("%w: confirmed observation has invalid status %q", ErrInvalidObservation, observation.Status)
		}
	case protocol.ReconciliationStateNotFound, protocol.ReconciliationStateUnknown:
		if observation.Status != "" {
			return fmt.Errorf("%w: %s observation must not include status %q", ErrInvalidObservation, observation.Reconciliation, observation.Status)
		}
		return nil
	default:
		return fmt.Errorf("%w: unsupported reconciliation state %q", ErrInvalidObservation, observation.Reconciliation)
	}
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
