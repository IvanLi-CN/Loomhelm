package artifacts

import (
	"context"
	"errors"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// Ownership is resolved from the actual Session/Run domain state. It is an
// internal authorization input, not a public artifact wire model.
type Ownership struct {
	SessionID string
	RunID     *string
	ProjectID *string
}

// OwnershipResolver is the explicit seam for the E01 Session/Run domain. A
// missing or not-found ownership result must never be treated as authorized.
type OwnershipResolver interface {
	ResolveArtifactOwnership(context.Context, protocol.Artifact) (Ownership, error)
}

// ScopeAuthorizer is the P01 principal/project authorization seam. The
// principal remains in context, owned by the auth package; this package only
// supplies the resolved ownership and requested operation.
type ScopeAuthorizer interface {
	AuthorizeArtifact(context.Context, Operation, protocol.Artifact, Ownership) error
}

// OwnershipResolverFunc adapts a function to OwnershipResolver.
type OwnershipResolverFunc func(context.Context, protocol.Artifact) (Ownership, error)

func (f OwnershipResolverFunc) ResolveArtifactOwnership(ctx context.Context, artifact protocol.Artifact) (Ownership, error) {
	if f == nil {
		return Ownership{}, ErrUnauthorized
	}
	return f(ctx, artifact)
}

// ScopeAuthorizerFunc adapts a function to ScopeAuthorizer.
type ScopeAuthorizerFunc func(context.Context, Operation, protocol.Artifact, Ownership) error

func (f ScopeAuthorizerFunc) AuthorizeArtifact(ctx context.Context, operation Operation, artifact protocol.Artifact, ownership Ownership) error {
	if f == nil {
		return ErrUnauthorized
	}
	return f(ctx, operation, artifact, ownership)
}

// ResolvedAuthorizer composes E01 ownership resolution with P01 caller and
// project authorization. It fails closed when either side is absent or when
// the resolver returns an association different from the persisted metadata.
type ResolvedAuthorizer struct {
	Resolver OwnershipResolver
	Scope    ScopeAuthorizer
}

func NewResolvedAuthorizer(resolver OwnershipResolver, scope ScopeAuthorizer) Authorizer {
	return ResolvedAuthorizer{Resolver: resolver, Scope: scope}
}

func (a ResolvedAuthorizer) Authorize(ctx context.Context, operation Operation, artifact protocol.Artifact) error {
	if a.Resolver == nil || a.Scope == nil {
		return ErrUnauthorized
	}
	ownership, err := a.Resolver.ResolveArtifactOwnership(ctx, artifact)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if errors.Is(err, ErrStoreUnavailable) {
			return ErrStoreUnavailable
		}
		return ErrUnauthorized
	}
	if ownership.SessionID == "" || ownership.SessionID != artifact.SessionID || !sameOptionalID(ownership.RunID, artifact.RunID) {
		return ErrUnauthorized
	}
	if err := a.Scope.AuthorizeArtifact(ctx, operation, artifact, ownership); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if errors.Is(err, ErrStoreUnavailable) {
			return ErrStoreUnavailable
		}
		return ErrUnauthorized
	}
	return nil
}

func sameOptionalID(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
