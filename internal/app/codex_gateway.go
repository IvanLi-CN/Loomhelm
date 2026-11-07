package app

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

type gatewayCodexTitleWriter struct {
	server *gateway.Server
}

type gatewayCodexSyncRunner struct {
	server *gateway.Server
}

func (w gatewayCodexTitleWriter) SetTitle(ctx context.Context, hostID, threadID, title string) error {
	return w.setTitle(ctx, fmt.Sprintf("loomhelm-title-%d", time.Now().UTC().UnixNano()), hostID, threadID, title)
}

func (w gatewayCodexTitleWriter) SetTitleWithOperation(ctx context.Context, operationID, hostID, threadID, title string) error {
	return w.setTitle(ctx, operationID, hostID, threadID, title)
}

func (w gatewayCodexTitleWriter) setTitle(ctx context.Context, operationID, hostID, threadID, title string) error {
	if w.server == nil {
		return fmt.Errorf("Codex Host gateway is unavailable")
	}
	ack, err := w.server.SendSourceCommand(ctx, hostID, gateway.SourceCommand{
		OperationID: operationID,
		Method:      "thread/name/set",
		ThreadID:    threadID,
		Title:       title,
	})
	if err != nil {
		return err
	}
	if ack.State != "succeeded" {
		if ack.Error != nil {
			return fmt.Errorf("Codex source title operation %s: %s", ack.Error.Code, ack.Error.Message)
		}
		return fmt.Errorf("Codex source title operation returned state %q", ack.State)
	}
	return nil
}

func (r gatewayCodexSyncRunner) Sync(ctx context.Context, hostID, operationID string) (protocol.CodexSourceSnapshot, error) {
	if r.server == nil {
		return protocol.CodexSourceSnapshot{}, fmt.Errorf("Codex Host gateway is unavailable")
	}
	ack, err := r.server.SendSourceCommand(ctx, hostID, gateway.SourceCommand{
		OperationID: operationID,
		Method:      "source/sync",
	})
	if err != nil {
		return protocol.CodexSourceSnapshot{}, err
	}
	if ack.State != "succeeded" {
		if ack.Error != nil {
			return protocol.CodexSourceSnapshot{}, fmt.Errorf("Codex source sync %s: %s", ack.Error.Code, ack.Error.Message)
		}
		return protocol.CodexSourceSnapshot{}, fmt.Errorf("Codex source sync returned state %q", ack.State)
	}
	if len(ack.Payload) == 0 {
		return protocol.CodexSourceSnapshot{}, fmt.Errorf("Codex source sync returned no snapshot")
	}
	var snapshot protocol.CodexSourceSnapshot
	if err := json.Unmarshal(ack.Payload, &snapshot); err != nil {
		return protocol.CodexSourceSnapshot{}, fmt.Errorf("decode Codex source snapshot: %w", err)
	}
	return snapshot, nil
}
