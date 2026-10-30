package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestGatewayArtifactUploadReassemblesAndPreservesIdempotency(t *testing.T) {
	registry := newFakeRegistry()
	var mu sync.Mutex
	var received []ArtifactUploadRequest
	stored := make(map[string][]byte)
	server, err := NewServer(registry, ServerOptions{
		ArtifactHandler: func(_ context.Context, _ hosts.Connection, request ArtifactUploadRequest) (protocol.Artifact, error) {
			content, readErr := io.ReadAll(request.Content)
			if readErr != nil {
				return protocol.Artifact{}, readErr
			}
			mu.Lock()
			defer mu.Unlock()
			received = append(received, request)
			if previous, ok := stored[request.IdempotencyKey]; ok && !bytes.Equal(previous, content) {
				return protocol.Artifact{}, &ArtifactHandlerError{Code: "artifact_conflict", Err: errors.New("immutable bytes differ")}
			}
			if _, ok := stored[request.IdempotencyKey]; !ok {
				stored[request.IdempotencyKey] = append([]byte(nil), content...)
			}
			return request.Artifact, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	client := newTestClient(t, httpServer, registry.credential.HostID, registry.token)
	connection := connectTestClient(t, client)
	readCtx, cancelRead := context.WithCancel(context.Background())
	defer cancelRead()
	readDone := make(chan error, 1)
	go func() {
		for {
			if _, err := connection.Read(readCtx); err != nil {
				readDone <- err
				return
			}
		}
	}()
	t.Cleanup(func() {
		_ = connection.Close()
		select {
		case <-readDone:
		case <-time.After(2 * time.Second):
			t.Errorf("gateway artifact reader did not stop")
		}
	})

	content := bytes.Repeat([]byte("artifact-byte-"), artifactUploadChunkBytes/len("artifact-byte-")+2)
	content = content[:artifactUploadChunkBytes+17]
	hash := sha256.Sum256(content)
	runID := "run_artifact_upload"
	artifact := protocol.Artifact{
		ID:          "artifact_upload_1",
		SessionID:   "session_artifact_upload",
		RunID:       &runID,
		Name:        "source.bin",
		Kind:        protocol.ArtifactKindFile,
		Size:        int64(len(content)),
		Sha256:      hex.EncodeToString(hash[:]),
		ContentType: "application/octet-stream",
		CreatedAt:   "2026-10-30T01:02:03Z",
	}
	request := ArtifactUploadRequest{
		Artifact:       artifact,
		EventID:        "artifact-event-1",
		SourceEventID:  "source-event-1",
		IdempotencyKey: artifact.ID,
		Content:        bytes.NewReader(content),
	}
	if err := connection.SendArtifact(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request.Content = bytes.NewReader(content)
	if err := connection.SendArtifact(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(received) != 2 || !bytes.Equal(stored[artifact.ID], content) {
		t.Fatalf("received uploads = %d, stored bytes = %d", len(received), len(stored[artifact.ID]))
	}
	if received[0].EventID != request.EventID || received[0].SourceEventID != request.SourceEventID || received[0].IdempotencyKey != artifact.ID {
		t.Fatalf("received identity = %+v", received[0])
	}
	mu.Unlock()

	conflictingContent := bytes.Repeat([]byte("conflicting-byte-"), len(content)/len("conflicting-byte-")+1)
	conflictingContent = conflictingContent[:len(content)]
	conflictingHash := sha256.Sum256(conflictingContent)
	conflictingArtifact := artifact
	conflictingArtifact.Sha256 = hex.EncodeToString(conflictingHash[:])
	conflictingRequest := request
	conflictingRequest.Artifact = conflictingArtifact
	conflictingRequest.Content = bytes.NewReader(conflictingContent)
	if err := connection.SendArtifact(context.Background(), conflictingRequest); !errors.Is(err, ErrArtifactUploadRejected) {
		t.Fatalf("conflicting upload error = %v", err)
	}
	mu.Lock()
	if !bytes.Equal(stored[artifact.ID], content) {
		t.Fatalf("conflicting upload replaced immutable bytes")
	}
	mu.Unlock()

	badHash := artifact
	badHash.ID = "artifact_upload_bad_hash"
	badHash.Sha256 = strings.Repeat("0", sha256.Size*2)
	badRequest := request
	badRequest.Artifact = badHash
	badRequest.IdempotencyKey = badHash.ID
	badRequest.Content = bytes.NewReader(content)
	if err := connection.SendArtifact(context.Background(), badRequest); !errors.Is(err, ErrArtifactUploadRejected) {
		t.Fatalf("bad hash upload error = %v", err)
	}
	mu.Lock()
	if len(received) != 3 {
		t.Fatalf("handler received bad hash upload: %d", len(received))
	}
	mu.Unlock()
}
