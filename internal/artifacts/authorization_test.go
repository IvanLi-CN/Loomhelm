package artifacts

import (
	"context"
	"errors"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestResolvedAuthorizerRequiresOwnershipAndScope(t *testing.T) {
	runID := "run-auth-test"
	artifact := protocol.Artifact{ID: "artifact-auth-test", SessionID: "session-auth-test", RunID: &runID}
	var gotOperation Operation
	var gotOwnership Ownership
	authorizer := NewResolvedAuthorizer(
		OwnershipResolverFunc(func(context.Context, protocol.Artifact) (Ownership, error) {
			return Ownership{SessionID: artifact.SessionID, RunID: &runID}, nil
		}),
		ScopeAuthorizerFunc(func(_ context.Context, operation Operation, _ protocol.Artifact, ownership Ownership) error {
			gotOperation = operation
			gotOwnership = ownership
			return nil
		}),
	)
	if err := authorizer.Authorize(context.Background(), OperationOpen, artifact); err != nil {
		t.Fatalf("permitted authorization error = %v", err)
	}
	if gotOperation != OperationOpen || gotOwnership.SessionID != artifact.SessionID || gotOwnership.RunID == nil || *gotOwnership.RunID != runID {
		t.Fatalf("authorization inputs = operation %q ownership %#v", gotOperation, gotOwnership)
	}

	tests := []struct {
		name     string
		resolver OwnershipResolver
		scope    ScopeAuthorizer
	}{
		{
			name:  "missing resolver",
			scope: ScopeAuthorizerFunc(func(context.Context, Operation, protocol.Artifact, Ownership) error { return nil }),
		},
		{
			name: "resolver not found",
			resolver: OwnershipResolverFunc(func(context.Context, protocol.Artifact) (Ownership, error) {
				return Ownership{}, errors.New("session not found")
			}),
			scope: ScopeAuthorizerFunc(func(context.Context, Operation, protocol.Artifact, Ownership) error { return nil }),
		},
		{
			name: "ownership mismatch",
			resolver: OwnershipResolverFunc(func(context.Context, protocol.Artifact) (Ownership, error) {
				return Ownership{SessionID: "other-session", RunID: &runID}, nil
			}),
			scope: ScopeAuthorizerFunc(func(context.Context, Operation, protocol.Artifact, Ownership) error { return nil }),
		},
		{
			name: "scope rejection",
			resolver: OwnershipResolverFunc(func(context.Context, protocol.Artifact) (Ownership, error) {
				return Ownership{SessionID: artifact.SessionID, RunID: &runID}, nil
			}),
			scope: ScopeAuthorizerFunc(func(context.Context, Operation, protocol.Artifact, Ownership) error {
				return errors.New("project scope denied")
			}),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := NewResolvedAuthorizer(test.resolver, test.scope)
			if err := candidate.Authorize(context.Background(), OperationMetadata, artifact); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("authorization error = %v, want %v", err, ErrUnauthorized)
			}
		})
	}
}

func TestResolvedAuthorizerPreservesAuthorizationDependencyFailure(t *testing.T) {
	artifact := protocol.Artifact{ID: "artifact-auth-unavailable", SessionID: "session-auth-unavailable"}
	for _, test := range []struct {
		name     string
		resolver OwnershipResolver
		scope    ScopeAuthorizer
	}{
		{
			name: "ownership resolver",
			resolver: OwnershipResolverFunc(func(context.Context, protocol.Artifact) (Ownership, error) {
				return Ownership{}, ErrStoreUnavailable
			}),
			scope: ScopeAuthorizerFunc(func(context.Context, Operation, protocol.Artifact, Ownership) error {
				return nil
			}),
		},
		{
			name: "scope authorizer",
			resolver: OwnershipResolverFunc(func(context.Context, protocol.Artifact) (Ownership, error) {
				return Ownership{SessionID: artifact.SessionID}, nil
			}),
			scope: ScopeAuthorizerFunc(func(context.Context, Operation, protocol.Artifact, Ownership) error {
				return ErrStoreUnavailable
			}),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := NewResolvedAuthorizer(test.resolver, test.scope).Authorize(context.Background(), OperationOpen, artifact)
			if !errors.Is(err, ErrStoreUnavailable) {
				t.Fatalf("authorization error = %v, want %v", err, ErrStoreUnavailable)
			}
			if errors.Is(err, ErrUnauthorized) {
				t.Fatalf("authorization dependency error was folded into %v", ErrUnauthorized)
			}
		})
	}
}

func TestDenyAllAuthorizerRejectsEveryOperation(t *testing.T) {
	artifact := protocol.Artifact{ID: "artifact-deny-test", SessionID: "session-deny-test"}
	for _, operation := range []Operation{OperationPut, OperationMetadata, OperationOpen} {
		if err := (DenyAllAuthorizer{}).Authorize(context.Background(), operation, artifact); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("operation %q error = %v, want %v", operation, err, ErrUnauthorized)
		}
	}
}
