package app

import (
	"context"
	"errors"
	"time"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
)

const connectorArtifactUnavailableRetry = time.Second

// uploadPendingArtifacts keeps the current authenticated WSS connection as
// the only Connector-to-server artifact boundary. Identity-pending entries
// remain durable and are retried after the Session/Run mapping catches up;
// transport or server failures end this connection so the normal reconnect
// path retries the same outbox records.
func (c *Connector) uploadPendingArtifacts(ctx context.Context, connection *gateway.ClientConnection) error {
	if c == nil || c.adapter == nil || connection == nil {
		return errors.New("connector artifact upload is unavailable")
	}
	uploader, err := connectorruntime.NewGatewayArtifactUploader(connection)
	if err != nil {
		return err
	}
	for {
		if err := c.adapter.ReplayPendingArtifactCaptures(); err != nil {
			return err
		}
		if err := c.adapter.ReplayPendingArtifactEvents(); err != nil && !errors.Is(err, connectorruntime.ErrArtifactIdentityPending) {
			return err
		}
		err = c.adapter.UploadPendingArtifacts(ctx, uploader)
		if err != nil && !errors.Is(err, connectorruntime.ErrArtifactIdentityPending) {
			if code, ok := gateway.ArtifactUploadErrorCode(err); ok && (code == "artifact_handler_unavailable" || code == "artifact_unavailable") {
				if err := waitArtifactRetry(ctx, connectorArtifactUnavailableRetry); err != nil {
					return err
				}
				continue
			}
			if code, ok := gateway.ArtifactUploadErrorCode(err); ok {
				var publicationErr *connectorruntime.ArtifactPublicationUploadError
				if !errors.As(err, &publicationErr) || publicationErr == nil || publicationErr.ArtifactID == "" {
					return err
				}
				if err := c.adapter.MarkArtifactRejected(publicationErr.ArtifactID, code); err != nil {
					return err
				}
				continue
			}
			return err
		}
		timer := time.NewTimer(connectorEventPollInterval)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
	}
}

func waitArtifactRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
