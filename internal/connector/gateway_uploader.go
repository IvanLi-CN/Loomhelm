package connector

import (
	"context"
	"errors"

	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
)

// ArtifactLink is the already authenticated platform connection. Connector
// publication never creates a second gateway or selects another transport.
type ArtifactLink interface {
	SendArtifact(context.Context, gateway.ArtifactUploadRequest) error
}

// GatewayArtifactUploader adapts the authenticated platform connection to the
// Connector's durable ArtifactUploader seam. Content ownership remains with
// the caller, which is the Adapter's publication/retry path.
type GatewayArtifactUploader struct {
	link ArtifactLink
}

func NewGatewayArtifactUploader(link ArtifactLink) (*GatewayArtifactUploader, error) {
	if link == nil {
		return nil, errors.New("artifact link is required")
	}
	return &GatewayArtifactUploader{link: link}, nil
}

func (u *GatewayArtifactUploader) UploadArtifact(ctx context.Context, request ArtifactUploadRequest) error {
	if u == nil || u.link == nil {
		return ErrArtifactUploaderRequired
	}
	if request.Content == nil {
		return errors.New("artifact upload content is required")
	}
	return u.link.SendArtifact(ctx, gateway.ArtifactUploadRequest{
		Artifact:       request.Artifact,
		EventID:        request.EventID,
		SourceEventID:  request.SourceEventID,
		IdempotencyKey: request.IdempotencyKey,
		Content:        request.Content,
	})
}

var _ ArtifactUploader = (*GatewayArtifactUploader)(nil)
