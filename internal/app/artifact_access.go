package app

import (
	"context"
	"errors"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

type artifactOwnershipResolver struct {
	sessions interface {
		GetAccess(context.Context, string) (sessions.SessionAccess, error)
	}
	runs artifactRunRecords
}

type artifactPrincipalContextKey struct{}

func (r artifactOwnershipResolver) ResolveArtifactOwnership(ctx context.Context, artifact protocol.Artifact) (artifacts.Ownership, error) {
	if r.sessions == nil || artifact.SessionID == "" {
		return artifacts.Ownership{}, artifacts.ErrUnauthorized
	}
	access, err := r.sessions.GetAccess(ctx, artifact.SessionID)
	if err != nil {
		return artifacts.Ownership{}, err
	}
	if access.SessionID != artifact.SessionID || access.CreatorUserID == "" || access.HostID == "" || !access.Confirmed {
		return artifacts.Ownership{}, artifacts.ErrUnauthorized
	}
	ownership := artifacts.Ownership{SessionID: access.SessionID}
	if access.ProjectID != "" {
		projectID := access.ProjectID
		ownership.ProjectID = &projectID
	}
	if artifact.RunID == nil {
		return ownership, nil
	}
	if r.runs == nil {
		return artifacts.Ownership{}, artifacts.ErrUnauthorized
	}
	run, err := r.runs.GetRun(ctx, *artifact.RunID)
	if err != nil {
		return artifacts.Ownership{}, err
	}
	if run.ID != *artifact.RunID || run.SessionID != artifact.SessionID {
		return artifacts.Ownership{}, errors.New("artifact run is not owned by its session")
	}
	runID := run.ID
	ownership.RunID = &runID
	return ownership, nil
}

type artifactScopeAuthorizer struct {
	principal auth.PrincipalResolver
	sessions  *sessionService
}

func (a artifactScopeAuthorizer) AuthorizeArtifact(ctx context.Context, operation artifacts.Operation, artifact protocol.Artifact, ownership artifacts.Ownership) error {
	if a.principal == nil || a.sessions == nil || ownership.SessionID != artifact.SessionID {
		return artifacts.ErrUnauthorized
	}
	principal, ok := ctx.Value(artifactPrincipalContextKey{}).(auth.Principal)
	if !ok {
		var err error
		principal, err = a.principal.ResolvePrincipal(ctx, nil)
		if err != nil {
			return err
		}
	}
	if principal.UserID == "" {
		return auth.ErrUnauthenticated
	}
	write := operation == artifacts.OperationPut
	access, err := a.sessions.authorize(ctx, principal, artifact.SessionID, write)
	if err != nil {
		return err
	}
	if !sameOptionalString(access.ProjectID, ownership.ProjectID) {
		return artifacts.ErrUnauthorized
	}
	return nil
}

func sameOptionalString(value string, pointer *string) bool {
	if value == "" {
		return pointer == nil
	}
	return pointer != nil && *pointer == value
}
