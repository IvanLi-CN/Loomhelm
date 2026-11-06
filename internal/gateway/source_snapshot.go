package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
)

const (
	// Snapshot payloads are streamed in bounded frames. The aggregate limit is
	// deliberately much larger than the frame limit while still bounding memory
	// retained by one authenticated connection.
	maxGatewaySourceSnapshotBytes = int64(256 << 20)
	sourceSnapshotChunkBytes      = 256 << 10
	maxPendingSourceSnapshots     = 1
)

type pendingServerSourceSnapshot struct {
	operationID string
	totalBytes  int64
	sha256      string
	content     bytes.Buffer
	nextChunk   int64
}

func (b SourceSnapshotBegin) validate() error {
	if strings.TrimSpace(b.OperationID) == "" {
		return errors.New("gateway source snapshot operation id is required")
	}
	if b.TotalBytes <= 0 || b.TotalBytes > maxGatewaySourceSnapshotBytes {
		return fmt.Errorf("gateway source snapshot size must be between 1 and %d bytes", maxGatewaySourceSnapshotBytes)
	}
	if len(b.SHA256) != sha256.Size*2 {
		return errors.New("gateway source snapshot sha256 is invalid")
	}
	if _, err := hex.DecodeString(b.SHA256); err != nil {
		return errors.New("gateway source snapshot sha256 is invalid")
	}
	return nil
}

func validateSourceSnapshotBeginMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 || message.SourceSnapshotBegin == nil {
		return errors.New("gateway source snapshot begin requires request id, generation and metadata")
	}
	return message.SourceSnapshotBegin.validate()
}

func validateSourceSnapshotChunkMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 || message.ChunkIndex < 0 || message.ChunkData == "" {
		return errors.New("gateway source snapshot chunk requires request id, generation, index and data")
	}
	if len(message.ChunkData) > base64.StdEncoding.EncodedLen(sourceSnapshotChunkBytes) {
		return errors.New("gateway source snapshot chunk exceeds the configured size")
	}
	decoded, err := base64.StdEncoding.DecodeString(message.ChunkData)
	if err != nil || len(decoded) == 0 || len(decoded) > sourceSnapshotChunkBytes {
		return errors.New("gateway source snapshot chunk data is invalid")
	}
	return nil
}

func validateSourceSnapshotTerminalMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 {
		return errors.New("gateway source snapshot terminal frame requires request id and generation")
	}
	return nil
}

func (c *ClientConnection) writeSourceSnapshot(ctx context.Context, requestID string, ack SourceAck) error {
	if err := ack.validate(); err != nil {
		return err
	}
	message := Message{Type: MessageSourceAck, RequestID: requestID, Generation: c.generation, SourceAck: &ack}
	if _, err := encodeMessage(message, c.maxFrame); err == nil {
		return c.write(ctx, message)
	} else if ack.State != "succeeded" || len(ack.Payload) == 0 {
		return err
	}
	return c.sendSourceSnapshotChunks(ctx, requestID, ack)
}

func (c *ClientConnection) sendSourceSnapshotChunks(ctx context.Context, requestID string, ack SourceAck) error {
	if len(ack.Payload) == 0 || ack.State != "succeeded" {
		return errors.New("gateway source snapshot chunks require a successful non-empty payload")
	}
	digest := sha256.Sum256(ack.Payload)
	begin := Message{
		Type:       MessageSourceSnapshotBegin,
		RequestID:  requestID,
		Generation: c.generation,
		SourceSnapshotBegin: &SourceSnapshotBegin{
			OperationID: ack.OperationID,
			TotalBytes:  int64(len(ack.Payload)),
			SHA256:      hex.EncodeToString(digest[:]),
		},
	}
	abort := func() {
		abortCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = c.write(abortCtx, Message{Type: MessageSourceSnapshotAbort, RequestID: requestID, Generation: c.generation})
	}
	if err := c.write(ctx, begin); err != nil {
		return fmt.Errorf("send source snapshot begin: %w", err)
	}
	for index, offset := int64(0), 0; offset < len(ack.Payload); index, offset = index+1, offset+sourceSnapshotChunkBytes {
		end := offset + sourceSnapshotChunkBytes
		if end > len(ack.Payload) {
			end = len(ack.Payload)
		}
		chunk := Message{Type: MessageSourceSnapshotChunk, RequestID: requestID, Generation: c.generation, ChunkIndex: index, ChunkData: base64.StdEncoding.EncodeToString(ack.Payload[offset:end])}
		if err := c.write(ctx, chunk); err != nil {
			abort()
			return fmt.Errorf("send source snapshot chunk %d: %w", index, err)
		}
	}
	if err := c.write(ctx, Message{Type: MessageSourceSnapshotCommit, RequestID: requestID, Generation: c.generation}); err != nil {
		abort()
		return fmt.Errorf("send source snapshot commit: %w", err)
	}
	return nil
}

func (c *serverConnection) sourceRequestPending(requestID string) bool {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	_, pending := c.pendingSources[requestID]
	return pending
}

func (c *serverConnection) handleSourceSnapshotBegin(message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	if len(c.sourceSnapshots) >= maxPendingSourceSnapshots {
		return errors.New("too many pending source snapshots")
	}
	if _, exists := c.sourceSnapshots[message.RequestID]; exists {
		return errors.New("source snapshot request id is already active")
	}
	metadata := *message.SourceSnapshotBegin
	pending := &pendingServerSourceSnapshot{operationID: metadata.OperationID, totalBytes: metadata.TotalBytes, sha256: strings.ToLower(metadata.SHA256)}
	pending.content.Grow(int(metadata.TotalBytes))
	c.sourceSnapshots[message.RequestID] = pending
	return nil
}

func (c *serverConnection) handleSourceSnapshotChunk(message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	pending := c.sourceSnapshots[message.RequestID]
	if pending == nil {
		return errors.New("source snapshot request is not active")
	}
	if message.ChunkIndex != pending.nextChunk {
		return errors.New("source snapshot chunk order is invalid")
	}
	decoded, err := base64.StdEncoding.DecodeString(message.ChunkData)
	if err != nil || len(decoded) == 0 || len(decoded) > sourceSnapshotChunkBytes {
		return errors.New("source snapshot chunk data is invalid")
	}
	if int64(pending.content.Len()+len(decoded)) > pending.totalBytes {
		return errors.New("source snapshot content exceeds declared size")
	}
	if _, err := pending.content.Write(decoded); err != nil {
		return fmt.Errorf("buffer source snapshot chunk: %w", err)
	}
	pending.nextChunk++
	return nil
}

func (c *serverConnection) handleSourceSnapshotCommit(ctx context.Context, message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	pending := c.sourceSnapshots[message.RequestID]
	if pending == nil {
		return errors.New("source snapshot request is not active")
	}
	delete(c.sourceSnapshots, message.RequestID)
	payload := append([]byte(nil), pending.content.Bytes()...)
	ack := SourceAck{OperationID: pending.operationID, State: "succeeded", Payload: payload}
	digest := sha256.Sum256(payload)
	if int64(len(payload)) != pending.totalBytes || !strings.EqualFold(pending.sha256, hex.EncodeToString(digest[:])) {
		ack.State = "failed"
		ack.Payload = nil
		ack.Error = &WireError{Code: "source_snapshot_integrity", Message: "source snapshot integrity check failed"}
	}
	if ack.State == "failed" && !c.sourceRequestPending(message.RequestID) {
		return c.write(ctx, Message{Type: MessageSourceAck, RequestID: message.RequestID, Generation: message.Generation, SourceAck: &ack})
	}
	return c.resolveSource(ctx, Message{Type: MessageSourceAck, RequestID: message.RequestID, Generation: message.Generation, SourceAck: &ack})
}

func (c *serverConnection) handleSourceSnapshotAbort(message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	delete(c.sourceSnapshots, message.RequestID)
	return nil
}
