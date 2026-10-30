package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const (
	maxGatewayArtifactBytes   = int64(4 << 20)
	artifactUploadChunkBytes  = 256 << 10
	maxPendingArtifactUploads = 2
)

var (
	ErrArtifactUploadRejected         = errors.New("artifact upload was rejected")
	ErrArtifactUploadUnknown          = errors.New("artifact upload outcome is unknown")
	ErrArtifactUploadIdentityMismatch = errors.New("artifact upload acknowledgement identity mismatch")
)

// ArtifactUploadRequest is the gateway-local wire publication request. The
// authenticated gateway connection is the only transport boundary; callers
// retain ownership of Content and must close it when their own contract
// requires that ownership.
type ArtifactUploadRequest struct {
	Artifact       protocol.Artifact
	EventID        string
	SourceEventID  string
	IdempotencyKey string
	Content        io.Reader
}

// ArtifactUploadHandler receives verified, reassembled bytes after the
// connection generation fence. The application adapter may pass Content to
// protocol.ArtifactStore.Put after wrapping it in an io.ReadCloser.
type ArtifactUploadHandler func(context.Context, hosts.Connection, ArtifactUploadRequest) (protocol.Artifact, error)

// ArtifactHandlerError lets the server preserve a stable, non-sensitive
// rejection code without exposing storage or authorization details over WSS.
type ArtifactHandlerError struct {
	Code string
	Err  error
}

func (e *ArtifactHandlerError) Error() string {
	if e == nil {
		return "artifact handler rejected upload"
	}
	if e.Err == nil {
		return e.Code
	}
	return e.Code + ": " + e.Err.Error()
}

func (e *ArtifactHandlerError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type artifactUploadResponse struct {
	message Message
	err     error
}

type pendingServerArtifactUpload struct {
	request   ArtifactUploadRequest
	content   bytes.Buffer
	nextChunk int64
}

func (c *ClientConnection) SendArtifact(ctx context.Context, request ArtifactUploadRequest) error {
	if c == nil || c.ws == nil {
		return ErrConnectionClosed
	}
	if ctx == nil {
		return errors.New("artifact upload context must not be nil")
	}
	if request.Content == nil {
		return errors.New("artifact upload content must not be nil")
	}
	if err := validateArtifactUploadMetadata(request.Artifact, request.EventID, request.SourceEventID, request.IdempotencyKey); err != nil {
		return err
	}
	requestID, err := newRequestID()
	if err != nil {
		return err
	}
	pending := make(chan artifactUploadResponse, 1)
	c.artifactMu.Lock()
	if c.artifactPending == nil {
		c.artifactPending = make(map[string]chan artifactUploadResponse)
	}
	c.artifactPending[requestID] = pending
	c.artifactMu.Unlock()
	removePending := func() {
		c.artifactMu.Lock()
		delete(c.artifactPending, requestID)
		c.artifactMu.Unlock()
	}
	abort := func() {
		abortCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = c.write(abortCtx, Message{Type: MessageArtifactAbort, RequestID: requestID, Generation: c.generation})
	}
	beginSent := false
	defer func() {
		if !beginSent {
			removePending()
		}
	}()
	if err := c.write(ctx, Message{
		Type:           MessageArtifactBegin,
		RequestID:      requestID,
		Generation:     c.generation,
		Artifact:       &request.Artifact,
		EventID:        request.EventID,
		SourceEventID:  request.SourceEventID,
		IdempotencyKey: request.IdempotencyKey,
	}); err != nil {
		return fmt.Errorf("send artifact upload begin: %w", err)
	}
	beginSent = true
	chunk := make([]byte, artifactUploadChunkBytes)
	remaining := request.Artifact.Size
	var chunkIndex int64
	for remaining > 0 {
		want := int64(len(chunk))
		if remaining < want {
			want = remaining
		}
		read, readErr := io.ReadFull(request.Content, chunk[:want])
		if read > 0 {
			encoded := base64.StdEncoding.EncodeToString(chunk[:read])
			if err := c.write(ctx, Message{
				Type:       MessageArtifactChunk,
				RequestID:  requestID,
				Generation: c.generation,
				ChunkIndex: chunkIndex,
				ChunkData:  encoded,
			}); err != nil {
				abort()
				removePending()
				return fmt.Errorf("send artifact upload chunk %d: %w", chunkIndex, err)
			}
			chunkIndex++
			remaining -= int64(read)
		}
		if readErr != nil {
			abort()
			removePending()
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				return fmt.Errorf("artifact upload content is shorter than declared size: %w", ErrArtifactUploadRejected)
			}
			return fmt.Errorf("read artifact upload content: %w", readErr)
		}
	}
	var extra [1]byte
	read, readErr := request.Content.Read(extra[:])
	if read > 0 {
		abort()
		removePending()
		return fmt.Errorf("artifact upload content is larger than declared size: %w", ErrArtifactUploadRejected)
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		abort()
		removePending()
		return fmt.Errorf("read artifact upload terminator: %w", readErr)
	}
	if err := c.write(ctx, Message{Type: MessageArtifactCommit, RequestID: requestID, Generation: c.generation}); err != nil {
		removePending()
		return fmt.Errorf("send artifact upload commit: %w", err)
	}
	select {
	case response := <-pending:
		removePending()
		if response.err != nil {
			return response.err
		}
		if response.message.Error != nil {
			return fmt.Errorf("%w: %s", ErrArtifactUploadRejected, response.message.Error.Code)
		}
		if response.message.Artifact == nil || !sameArtifactUploadMetadata(request.Artifact, *response.message.Artifact) {
			return ErrArtifactUploadIdentityMismatch
		}
		return nil
	case <-ctx.Done():
		removePending()
		return fmt.Errorf("%w: %v", ErrArtifactUploadUnknown, ctx.Err())
	}
}

func (c *ClientConnection) resolveArtifactAck(message Message) {
	c.artifactMu.Lock()
	pending := c.artifactPending[message.RequestID]
	if pending != nil {
		delete(c.artifactPending, message.RequestID)
	}
	c.artifactMu.Unlock()
	if pending != nil {
		pending <- artifactUploadResponse{message: message}
	}
}

func (c *ClientConnection) failArtifactUploads(err error) {
	if err == nil {
		err = ErrConnectionClosed
	}
	c.artifactMu.Lock()
	pending := make([]chan artifactUploadResponse, 0, len(c.artifactPending))
	for requestID, channel := range c.artifactPending {
		delete(c.artifactPending, requestID)
		pending = append(pending, channel)
	}
	c.artifactMu.Unlock()
	for _, channel := range pending {
		channel <- artifactUploadResponse{err: err}
	}
}

func validateArtifactBeginMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 || message.Artifact == nil {
		return errors.New("artifact upload begin requires request id, generation and metadata")
	}
	return validateArtifactUploadMetadata(*message.Artifact, message.EventID, message.SourceEventID, message.IdempotencyKey)
}

func validateArtifactChunkMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 || message.ChunkIndex < 0 || message.ChunkData == "" {
		return errors.New("artifact upload chunk requires request id, generation, index and data")
	}
	if len(message.ChunkData) > base64.StdEncoding.EncodedLen(artifactUploadChunkBytes) {
		return errors.New("artifact upload chunk exceeds the configured size")
	}
	return nil
}

func validateArtifactTerminalMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 {
		return errors.New("artifact upload terminal frame requires request id and generation")
	}
	return nil
}

func validateArtifactAckMessage(message Message) error {
	if strings.TrimSpace(message.RequestID) == "" || message.Generation <= 0 {
		return errors.New("artifact upload acknowledgement requires request id and generation")
	}
	if message.Error == nil && message.Artifact == nil {
		return errors.New("artifact upload acknowledgement requires artifact or error")
	}
	if message.Error != nil {
		if strings.TrimSpace(message.Error.Code) == "" || strings.TrimSpace(message.Error.Message) == "" {
			return errors.New("artifact upload acknowledgement error is incomplete")
		}
	}
	if message.Artifact != nil {
		if err := validateArtifactDescriptor(*message.Artifact); err != nil {
			return fmt.Errorf("validate artifact upload acknowledgement: %w", err)
		}
	}
	return nil
}

func validateArtifactUploadMetadata(artifact protocol.Artifact, eventID, sourceEventID, idempotencyKey string) error {
	if err := validateArtifactDescriptor(artifact); err != nil {
		return err
	}
	for label, value := range map[string]string{
		"artifact event id":        eventID,
		"artifact source event id": sourceEventID,
		"artifact idempotency key": idempotencyKey,
	} {
		if err := validateArtifactText(value, label, 256); err != nil {
			return err
		}
	}
	if idempotencyKey != artifact.ID {
		return errors.New("artifact idempotency key must match artifact id")
	}
	return nil
}

func validateArtifactDescriptor(artifact protocol.Artifact) error {
	if err := validateArtifactText(artifact.ID, "artifact id", 128); err != nil {
		return err
	}
	if err := validateArtifactText(artifact.SessionID, "artifact session id", 256); err != nil {
		return err
	}
	if artifact.RunID != nil {
		if err := validateArtifactText(*artifact.RunID, "artifact run id", 256); err != nil {
			return err
		}
	}
	if artifact.Name == "" || len(artifact.Name) > 1024 || strings.ContainsAny(artifact.Name, "/\\") || strings.ContainsRune(artifact.Name, '\x00') {
		return errors.New("artifact name is invalid")
	}
	switch artifact.Kind {
	case protocol.ArtifactKindFile, protocol.ArtifactKindDiff, protocol.ArtifactKindSnapshot:
	default:
		return fmt.Errorf("artifact kind %q is unsupported", artifact.Kind)
	}
	if artifact.Size < 0 || artifact.Size > maxGatewayArtifactBytes {
		return errors.New("artifact size is outside the gateway limit")
	}
	if strings.TrimSpace(artifact.ContentType) == "" || len(artifact.ContentType) > 255 {
		return errors.New("artifact content type is invalid")
	}
	if _, _, err := mime.ParseMediaType(artifact.ContentType); err != nil {
		return errors.New("artifact content type is invalid")
	}
	if artifact.Sha256 != "" {
		if len(artifact.Sha256) != sha256.Size*2 {
			return errors.New("artifact sha256 is invalid")
		}
		if _, err := hex.DecodeString(artifact.Sha256); err != nil {
			return errors.New("artifact sha256 is invalid")
		}
	}
	if artifact.CreatedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, artifact.CreatedAt); err != nil {
			return errors.New("artifact created_at is invalid")
		}
	}
	return nil
}

func validateArtifactText(value, label string, maxBytes int) error {
	if strings.TrimSpace(value) == "" || value != strings.TrimSpace(value) || len(value) > maxBytes || strings.ContainsAny(value, "\r\n") {
		return fmt.Errorf("%s is invalid", label)
	}
	return nil
}

func sameArtifactUploadMetadata(left, right protocol.Artifact) bool {
	return left.ID == right.ID &&
		left.SessionID == right.SessionID &&
		sameOptionalArtifactID(left.RunID, right.RunID) &&
		left.Name == right.Name &&
		left.Kind == right.Kind &&
		left.Size == right.Size &&
		strings.EqualFold(left.Sha256, right.Sha256) &&
		left.ContentType == right.ContentType
}

func sameOptionalArtifactID(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func verifyArtifactUploadContent(artifact protocol.Artifact, content []byte) error {
	if int64(len(content)) != artifact.Size {
		return errors.New("artifact upload content size does not match metadata")
	}
	sum := sha256.Sum256(content)
	if artifact.Sha256 != "" && !strings.EqualFold(artifact.Sha256, hex.EncodeToString(sum[:])) {
		return errors.New("artifact upload content hash does not match metadata")
	}
	return nil
}

func (c *serverConnection) handleArtifactBegin(message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	if len(c.artifactUploads) >= maxPendingArtifactUploads {
		return errors.New("too many pending artifact uploads")
	}
	if _, exists := c.artifactUploads[message.RequestID]; exists {
		return errors.New("artifact upload request id is already active")
	}
	artifact := *message.Artifact
	pending := &pendingServerArtifactUpload{request: ArtifactUploadRequest{
		Artifact:       artifact,
		EventID:        message.EventID,
		SourceEventID:  message.SourceEventID,
		IdempotencyKey: message.IdempotencyKey,
	}}
	pending.content.Grow(int(artifact.Size))
	c.artifactUploads[message.RequestID] = pending
	return nil
}

func (c *serverConnection) handleArtifactChunk(message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	pending := c.artifactUploads[message.RequestID]
	if pending == nil {
		return errors.New("artifact upload request is not active")
	}
	if message.ChunkIndex != pending.nextChunk {
		return errors.New("artifact upload chunk order is invalid")
	}
	decoded, err := base64.StdEncoding.DecodeString(message.ChunkData)
	if err != nil || len(decoded) == 0 || len(decoded) > artifactUploadChunkBytes {
		return errors.New("artifact upload chunk data is invalid")
	}
	if int64(pending.content.Len()+len(decoded)) > pending.request.Artifact.Size {
		return errors.New("artifact upload content exceeds declared size")
	}
	if _, err := pending.content.Write(decoded); err != nil {
		return fmt.Errorf("buffer artifact upload chunk: %w", err)
	}
	pending.nextChunk++
	return nil
}

func (c *serverConnection) handleArtifactCommit(ctx context.Context, message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	pending := c.artifactUploads[message.RequestID]
	if pending == nil {
		return errors.New("artifact upload request is not active")
	}
	content := append([]byte(nil), pending.content.Bytes()...)
	request := pending.request
	delete(c.artifactUploads, message.RequestID)
	if err := verifyArtifactUploadContent(request.Artifact, content); err != nil {
		return c.sendArtifactAck(ctx, message.RequestID, nil, "artifact_integrity")
	}
	request.Content = bytes.NewReader(content)
	if c.onArtifact == nil {
		return c.sendArtifactAck(ctx, message.RequestID, nil, "artifact_handler_unavailable")
	}
	var stored protocol.Artifact
	err := c.registry.AuthorizeCommand(ctx, c.connection, func() error {
		var handlerErr error
		stored, handlerErr = c.onArtifact(ctx, c.connection, request)
		return handlerErr
	})
	if err != nil {
		if errors.Is(err, hosts.ErrConnectionStale) || errors.Is(err, hosts.ErrCommandNotDelivered) {
			return err
		}
		return c.sendArtifactAck(ctx, message.RequestID, nil, artifactHandlerErrorCode(err))
	}
	if !sameArtifactUploadMetadata(request.Artifact, stored) {
		return c.sendArtifactAck(ctx, message.RequestID, nil, "artifact_identity_mismatch")
	}
	return c.sendArtifactAck(ctx, message.RequestID, &stored, "")
}

func (c *serverConnection) handleArtifactAbort(message Message) error {
	if message.Generation != c.connection.Generation {
		return hosts.ErrConnectionStale
	}
	delete(c.artifactUploads, message.RequestID)
	return nil
}

func (c *serverConnection) sendArtifactAck(ctx context.Context, requestID string, artifact *protocol.Artifact, code string) error {
	message := Message{Type: MessageArtifactAck, RequestID: requestID, Generation: c.connection.Generation, Artifact: artifact}
	if code != "" {
		message.Error = &WireError{Code: code, Message: "artifact upload was rejected"}
	}
	return c.write(ctx, message)
}

func artifactHandlerErrorCode(err error) string {
	var typed *ArtifactHandlerError
	if errors.As(err, &typed) && typed != nil && validArtifactErrorCode(typed.Code) {
		return typed.Code
	}
	return "artifact_rejected"
}

func validArtifactErrorCode(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if !(character == '-' || character == '_' || character == ':' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}
