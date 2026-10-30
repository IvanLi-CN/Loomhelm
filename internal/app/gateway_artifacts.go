package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

// GatewayArtifactSessionReader is the narrow session boundary needed to map
// a Connector artifact to its confirmed platform session and host owner.
type GatewayArtifactSessionReader interface {
	GetAccess(context.Context, string) (sessions.SessionAccess, error)
	Get(context.Context, string) (sessions.Session, error)
}

// GatewayArtifactRunReader is the narrow run boundary needed to verify that a
// run-scoped artifact belongs to the same platform session generation.
type GatewayArtifactRunReader interface {
	GetRun(context.Context, string) (runs.Run, error)
}

// GatewayArtifactPutStore is the server-side durable byte publication seam.
// The application owns the concrete artifacts.Store and its configured
// authorizer; this handler adds the authenticated host/session/run mapping
// before passing the finite gateway reader to Store.Put.
type GatewayArtifactPutStore interface {
	Put(context.Context, protocol.Artifact, io.Reader) (protocol.Artifact, error)
}

// GatewayArtifactUploadHandler maps an authenticated Connector connection to
// the platform Session/Run identity before admitting immutable bytes. It is a
// standalone composition unit so runtime wiring can attach it without making
// the gateway transport choose a session or bypass the application stores.
type GatewayArtifactUploadHandler struct {
	store    GatewayArtifactPutStore
	sessions GatewayArtifactSessionReader
	runs     GatewayArtifactRunReader
}

func NewGatewayArtifactUploadHandler(store GatewayArtifactPutStore, sessionReader GatewayArtifactSessionReader, runReader GatewayArtifactRunReader) (*GatewayArtifactUploadHandler, error) {
	if store == nil || sessionReader == nil || runReader == nil {
		return nil, errors.New("gateway artifact handler requires store, session reader and run reader")
	}
	return &GatewayArtifactUploadHandler{store: store, sessions: sessionReader, runs: runReader}, nil
}

// Handle is suitable for gateway.ServerOptions.ArtifactHandler. The gateway
// has already authenticated and generation-fenced the connection; this
// handler additionally proves that the supplied platform identity belongs to
// that host before calling the durable ArtifactStore.
func (h *GatewayArtifactUploadHandler) Handle(ctx context.Context, connection hosts.Connection, request gateway.ArtifactUploadRequest) (protocol.Artifact, error) {
	if h == nil || h.store == nil || h.sessions == nil || h.runs == nil {
		return protocol.Artifact{}, artifactHandlerFailure("artifact_unavailable", errors.New("gateway artifact handler is unavailable"))
	}
	if ctx == nil {
		return protocol.Artifact{}, artifactHandlerFailure("artifact_invalid", errors.New("gateway artifact context must not be nil"))
	}
	if request.Content == nil {
		return protocol.Artifact{}, artifactHandlerFailure("artifact_invalid", errors.New("gateway artifact content is required"))
	}
	if err := h.authorize(ctx, connection, request.Artifact); err != nil {
		return protocol.Artifact{}, err
	}
	// The gateway has already bounded and fully reassembled this finite reader.
	// NopCloser is therefore the permitted adapter for ArtifactStore's
	// cancellation-aware input contract; Store.Put owns and closes it.
	stored, err := h.store.Put(ctx, request.Artifact, io.NopCloser(request.Content))
	if err != nil {
		return protocol.Artifact{}, mapGatewayArtifactStoreError(err)
	}
	return stored, nil
}

func (h *GatewayArtifactUploadHandler) authorize(ctx context.Context, connection hosts.Connection, artifact protocol.Artifact) error {
	if strings.TrimSpace(connection.HostID) == "" || strings.TrimSpace(artifact.SessionID) == "" || artifact.SessionID != strings.TrimSpace(artifact.SessionID) {
		return artifactHandlerFailure("artifact_unauthorized", errGatewaySessionOwnership)
	}
	access, err := h.sessions.GetAccess(ctx, artifact.SessionID)
	if err != nil || access.SessionID != artifact.SessionID || !access.Confirmed || strings.TrimSpace(access.HostID) == "" || access.HostID != connection.HostID {
		return artifactHandlerFailure("artifact_unauthorized", errGatewaySessionOwnership)
	}
	session, err := h.sessions.Get(ctx, artifact.SessionID)
	if err != nil || session.ID != artifact.SessionID || strings.TrimSpace(session.Generation) == "" {
		return artifactHandlerFailure("artifact_unauthorized", errGatewaySessionOwnership)
	}
	if artifact.RunID == nil {
		return nil
	}
	runID := strings.TrimSpace(*artifact.RunID)
	if runID == "" || runID != *artifact.RunID {
		return artifactHandlerFailure("artifact_unauthorized", errGatewayRunIdentity)
	}
	run, err := h.runs.GetRun(ctx, runID)
	if err != nil || run.ID != runID || run.SessionID != session.ID || run.Generation != session.Generation {
		return artifactHandlerFailure("artifact_unauthorized", errGatewayRunIdentity)
	}
	return nil
}

func artifactHandlerFailure(code string, err error) error {
	if err == nil {
		err = errors.New("artifact upload rejected")
	}
	return &gateway.ArtifactHandlerError{Code: code, Err: err}
}

func mapGatewayArtifactStoreError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, artifacts.ErrUnauthorized):
		return artifactHandlerFailure("artifact_unauthorized", err)
	case errors.Is(err, artifacts.ErrConflict):
		return artifactHandlerFailure("artifact_conflict", err)
	case errors.Is(err, artifacts.ErrTooLarge):
		return artifactHandlerFailure("artifact_too_large", err)
	case errors.Is(err, artifacts.ErrIntegrity), errors.Is(err, artifacts.ErrSizeMismatch), errors.Is(err, artifacts.ErrHashMismatch):
		return artifactHandlerFailure("artifact_integrity", err)
	case errors.Is(err, artifacts.ErrInvalid), errors.Is(err, artifacts.ErrInputNotCancellable):
		return artifactHandlerFailure("artifact_invalid", err)
	default:
		return artifactHandlerFailure("artifact_unavailable", fmt.Errorf("artifact store publication failed: %w", err))
	}
}

var _ gateway.ArtifactUploadHandler = (*GatewayArtifactUploadHandler)(nil).Handle
