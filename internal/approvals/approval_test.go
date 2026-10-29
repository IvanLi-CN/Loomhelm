package approvals

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestApprovalRevisionAndGenerationValidation(t *testing.T) {
	approval, err := New(NewInput{ID: "approval-1", RunID: "run-1", SessionID: "session-1", Generation: "generation-1", Revision: 1, Kind: "command", Summary: "run command"})
	if err != nil {
		t.Fatal(err)
	}
	approval, err = approval.AdvanceRevision(2, "run changed command", "requested-2")
	if err != nil {
		t.Fatal(err)
	}
	stale := ResolveRequest{ApprovalID: approval.ID, RunID: approval.RunID, SessionID: approval.SessionID, Generation: "generation-1", Request: protocol.ResolveApprovalRequest{CommandID: "approve-stale", Decision: protocol.ApprovalDecisionApprove, Revision: 1}}
	if _, err := approval.Resolve(stale); !errors.Is(err, ErrRevisionStale) {
		t.Fatalf("stale revision error = %v, want %v", err, ErrRevisionStale)
	}
	oldGeneration := stale
	oldGeneration.Request.Revision = 2
	oldGeneration.Generation = "generation-old"
	if _, err := approval.Resolve(oldGeneration); !errors.Is(err, ErrApprovalGeneration) {
		t.Fatalf("old-generation approval error = %v, want %v", err, ErrApprovalGeneration)
	}
	resolved, err := approval.Resolve(ResolveRequest{ApprovalID: approval.ID, RunID: approval.RunID, SessionID: approval.SessionID, Generation: "generation-1", Request: protocol.ResolveApprovalRequest{CommandID: "approve-1", Decision: protocol.ApprovalDecisionApprove, Revision: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Approval.Status != protocol.ApprovalStatusApproved || resolved.Deduplicated {
		t.Fatalf("approval resolution = %+v", resolved)
	}
	duplicate, err := resolved.Approval.Resolve(ResolveRequest{ApprovalID: approval.ID, RunID: approval.RunID, SessionID: approval.SessionID, Generation: "generation-old", Request: protocol.ResolveApprovalRequest{CommandID: "approve-1", Decision: protocol.ApprovalDecisionApprove, Revision: 2}})
	if err != nil || !duplicate.Deduplicated {
		t.Fatalf("same command duplicate = %+v, error %v", duplicate, err)
	}
	if _, err := resolved.Approval.Resolve(ResolveRequest{ApprovalID: approval.ID, RunID: approval.RunID, SessionID: approval.SessionID, Generation: "generation-1", Request: protocol.ResolveApprovalRequest{CommandID: "deny-1", Decision: protocol.ApprovalDecisionDeny, Revision: 2}}); !errors.Is(err, ErrApprovalResolved) {
		t.Fatalf("competing decision error = %v, want %v", err, ErrApprovalResolved)
	}
}

func TestExpiredApprovalCannotBeResolved(t *testing.T) {
	approval, err := New(NewInput{ID: "approval-expired", RunID: "run-1", SessionID: "session-1", Generation: "generation-1", Revision: 1, Kind: "command"})
	if err != nil {
		t.Fatal(err)
	}
	approval, err = approval.Expire()
	if err != nil {
		t.Fatal(err)
	}
	request := ResolveRequest{ApprovalID: approval.ID, RunID: approval.RunID, SessionID: approval.SessionID, Generation: approval.Generation, Request: protocol.ResolveApprovalRequest{CommandID: "approve-expired", Decision: protocol.ApprovalDecisionApprove, Revision: approval.Revision}}
	if _, err := approval.Resolve(request); !errors.Is(err, ErrApprovalExpired) {
		t.Fatalf("expired resolution error = %v, want %v", err, ErrApprovalExpired)
	}
	if repeated, err := approval.Expire(); err != nil || repeated.Status != protocol.ApprovalStatusExpired {
		t.Fatalf("repeated expiration = %+v, error %v", repeated, err)
	}
}

func TestResolverAllowsExactlyOneCompetingDecision(t *testing.T) {
	approval, err := New(NewInput{ID: "approval-race", RunID: "run-1", SessionID: "session-1", Generation: "generation-1", Revision: 1, Kind: "command"})
	if err != nil {
		t.Fatal(err)
	}
	resolver := NewResolver(approval)
	const callers = 64
	var group sync.WaitGroup
	results := make(chan Resolution, callers)
	errorsSeen := make(chan error, callers)
	for i := 0; i < callers; i++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			decision := protocol.ApprovalDecisionApprove
			if index%2 == 1 {
				decision = protocol.ApprovalDecisionDeny
			}
			result, resolveErr := resolver.Resolve(ResolveRequest{
				ApprovalID: approval.ID,
				RunID:      approval.RunID,
				SessionID:  approval.SessionID,
				Generation: approval.Generation,
				Request: protocol.ResolveApprovalRequest{
					CommandID: fmt.Sprintf("decision-%d", index),
					Decision:  decision,
					Revision:  approval.Revision,
				},
			})
			if resolveErr != nil {
				errorsSeen <- resolveErr
				return
			}
			results <- result
		}(i)
	}
	group.Wait()
	close(results)
	close(errorsSeen)
	successes := 0
	for range results {
		successes++
	}
	for err := range errorsSeen {
		if !errors.Is(err, ErrApprovalResolved) {
			t.Fatalf("competing resolution error = %v, want already resolved", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful competing resolutions = %d, want 1", successes)
	}
	final := resolver.Snapshot()
	if final.Status != protocol.ApprovalStatusApproved && final.Status != protocol.ApprovalStatusDenied {
		t.Fatalf("final approval status = %q", final.Status)
	}
}
