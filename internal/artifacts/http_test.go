package artifacts

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
)

func TestDownloadHTTPHandlerStreamsVerifiedBytesWithSafeHeaders(t *testing.T) {
	content := []byte("downloaded original bytes")
	reader := writeArtifactReader(t, content)
	artifact := protocol.Artifact{
		ID:          "artifact-download",
		SessionID:   "session-download",
		Name:        `../report/季度 "final".txt`,
		Kind:        protocol.ArtifactKindFile,
		Size:        int64(len(content)),
		ContentType: "text/plain; charset=utf-8",
		Sha256:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		CreatedAt:   "2026-10-30T01:02:03Z",
	}
	handler, err := NewDownloadHTTPHandler(httpArtifactStoreStub{artifact: artifact, reader: reader}, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/artifacts/{artifact_id}/download", handler.ServeHTTP)

	request := httptest.NewRequest(http.MethodGet, "/artifacts/"+artifact.ID+"/download", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%q", response.Code, http.StatusOK, response.Body.String())
	}
	if response.Body.String() != string(content) {
		t.Fatalf("body = %q, want %q", response.Body.String(), content)
	}
	if response.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("content type = %q", response.Header().Get("Content-Type"))
	}
	if disposition := response.Header().Get("Content-Disposition"); !strings.HasPrefix(disposition, `attachment; filename="`) || !strings.Contains(disposition, "filename*=UTF-8''") || strings.ContainsAny(disposition, "\r\n/\\") {
		t.Fatalf("content disposition = %q", disposition)
	}
	if response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("content type options = %q", response.Header().Get("X-Content-Type-Options"))
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache control = %q", response.Header().Get("Cache-Control"))
	}
	if response.Header().Get("ETag") != `"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"` {
		t.Fatalf("etag = %q", response.Header().Get("ETag"))
	}
}

func TestContentResponseSanitizesLegacyArtifactNames(t *testing.T) {
	content := []byte("legacy content")
	store := &contentHTTPArtifactStoreStub{
		httpArtifactStoreStub: httpArtifactStoreStub{
			artifact: protocol.Artifact{ID: "artifact-legacy-name", Name: "../report\u202Etxt.txt", Size: int64(len(content))},
			reader:   writeArtifactReader(t, content),
		},
	}
	handler, err := NewDownloadHTTPHandler(store, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/artifacts/{artifact_id}/content", handler.ServeContentHTTP)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/artifacts/artifact-legacy-name/content", nil))
	var payload protocol.ArtifactContentResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(payload.Artifact.Name, "/\\") || strings.ContainsRune(payload.Artifact.Name, '\u202E') {
		t.Fatalf("content response retained unsafe legacy name: %q", payload.Artifact.Name)
	}
}

func TestContentDispositionRemovesBidiControls(t *testing.T) {
	disposition := contentDisposition("report\u202Etxt.txt")
	if strings.ContainsRune(disposition, '\u202E') || strings.Contains(disposition, "%E2%80%AE") {
		t.Fatalf("content disposition retained a bidi control: %q", disposition)
	}
}

func TestDownloadHTTPHandlerSupportsHeadWithoutBody(t *testing.T) {
	content := []byte("head body is suppressed")
	artifact := protocol.Artifact{
		ID:          "artifact-head",
		Name:        "head.txt",
		ContentType: "text/plain",
		Size:        int64(len(content)),
	}
	handler, err := NewDownloadHTTPHandler(httpArtifactStoreStub{artifact: artifact, reader: writeArtifactReader(t, content)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/artifacts/{artifact_id}", handler.ServeHTTP)
	router.Head("/artifacts/{artifact_id}", handler.ServeHTTP)
	request := httptest.NewRequest(http.MethodHead, "/artifacts/"+artifact.ID, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("HEAD response = status %d/body %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Length") != "23" {
		t.Fatalf("HEAD content length = %q", response.Header().Get("Content-Length"))
	}
}

func TestDownloadHTTPHandlerReturnsCompleteContentChunkAsBase64JSON(t *testing.T) {
	content := []byte{0, 1, 2, 255}
	artifact := protocol.Artifact{
		ID:          "artifact-content",
		Name:        "content.bin",
		Kind:        protocol.ArtifactKindFile,
		Size:        int64(len(content)),
		ContentType: "application/octet-stream",
	}
	handler, err := NewDownloadHTTPHandler(httpArtifactStoreStub{artifact: artifact, reader: writeArtifactReader(t, content)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/artifacts/{artifact_id}/content", handler.ServeContentHTTP)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/artifacts/"+artifact.ID+"/content?limit=4", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%q", response.Code, http.StatusOK, response.Body.String())
	}
	var payload protocol.ArtifactContentResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(payload.ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != string(content) || payload.Offset != 0 || payload.NextOffset != int64(len(content)) || payload.TotalSize != int64(len(content)) || !payload.Complete {
		t.Fatalf("content response = %#v, decoded=%v", payload, decoded)
	}
	if response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("content response headers = %#v", response.Header())
	}
}

func TestDownloadHTTPHandlerMapsMissingUnauthorizedAndInvalidAccess(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		status     int
		retryAfter string
	}{
		{name: "missing", err: ErrNotFound, status: http.StatusNotFound},
		{name: "unauthorized", err: ErrUnauthorized, status: http.StatusNotFound},
		{name: "recovery pending", err: ErrRecoveryPending, status: http.StatusServiceUnavailable, retryAfter: "60"},
		{name: "content changed", err: ErrContentChanged, status: http.StatusConflict},
		{name: "invalid path", err: ErrInvalid, status: http.StatusBadRequest},
		{name: "store unavailable", err: ErrStoreUnavailable, status: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler, err := NewDownloadHTTPHandler(httpArtifactStoreStub{err: test.err}, nil)
			if err != nil {
				t.Fatal(err)
			}
			router := chi.NewRouter()
			router.Get("/artifacts/{artifact_id}", handler.ServeHTTP)
			request := httptest.NewRequest(http.MethodGet, "/artifacts/artifact-id", nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d; body=%q", response.Code, test.status, response.Body.String())
			}
			if response.Header().Get("Retry-After") != test.retryAfter {
				t.Fatalf("retry-after = %q, want %q", response.Header().Get("Retry-After"), test.retryAfter)
			}
			if strings.Contains(response.Body.String(), test.err.Error()) && test.err != ErrInvalid {
				t.Fatalf("response leaked storage error: %q", response.Body.String())
			}
		})
	}
}

func TestDownloadHTTPHandlerUsesBoundedContentOpenPath(t *testing.T) {
	content := []byte("bounded content")
	store := &contentHTTPArtifactStoreStub{
		httpArtifactStoreStub: httpArtifactStoreStub{
			artifact: protocol.Artifact{ID: "artifact-content-open", Name: "content.bin", Size: int64(len(content))},
			reader:   writeArtifactReader(t, content),
		},
	}
	handler, err := NewDownloadHTTPHandler(store, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/artifacts/{artifact_id}/content", handler.ServeContentHTTP)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/artifacts/artifact-content-open/content?limit=4", nil))
	if response.Code != http.StatusOK || store.contentOpens != 1 || store.fullOpens != 0 {
		t.Fatalf("content response status=%d/content opens=%d/full opens=%d", response.Code, store.contentOpens, store.fullOpens)
	}
}

func TestContentReaderRejectsInPlaceChangeAfterRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "artifact")
	original := []byte("original content")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	version, err := fileContentVersion(file)
	if err != nil {
		t.Fatal(err)
	}
	reader := &contentReader{File: file, version: version}
	if _, err := io.ReadFull(reader, make([]byte, 4)); err != nil {
		t.Fatal(err)
	}
	writer, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.WriteAt([]byte{'X'}, 0); err != nil {
		_ = writer.Close()
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := writer.WriteAt(original[:1], 0); err != nil {
		_ = writer.Close()
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Read(make([]byte, 4)); !errors.Is(err, ErrContentChanged) {
		t.Fatalf("in-place content read error = %v, want ErrContentChanged", err)
	}
	if err := reader.verifyContentVersion(context.Background()); !errors.Is(err, ErrContentChanged) {
		t.Fatalf("in-place content change error = %v, want ErrContentChanged", err)
	}
}

func TestDownloadHTTPHandlerRejectsMethodsAndMissingRouteParameter(t *testing.T) {
	handler, err := NewDownloadHTTPHandler(httpArtifactStoreStub{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Handle("/artifacts/{artifact_id}", handler)
	request := httptest.NewRequest(http.MethodPost, "/artifacts/artifact-id", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("POST response = status %d/allow %q", response.Code, response.Header().Get("Allow"))
	}

	routeContext := chi.NewRouteContext()
	request = httptest.NewRequest(http.MethodGet, "/artifacts/", nil)
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing route parameter status = %d, want %d", response.Code, http.StatusNotFound)
	}
}

func TestDownloadHTTPHandlerUsesCallerErrorEnvelope(t *testing.T) {
	var got struct {
		status  int
		err     error
		message string
	}
	handler, err := NewDownloadHTTPHandler(httpArtifactStoreStub{err: ErrNotFound}, func(_ http.ResponseWriter, _ *http.Request, status int, err error, message string) {
		got.status, got.err, got.message = status, err, message
	})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Get("/artifacts/{artifact_id}", handler.ServeHTTP)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/artifacts/missing", nil))
	if got.status != http.StatusNotFound || !errors.Is(got.err, ErrNotFound) || got.message == "" {
		t.Fatalf("error callback = %#v", got)
	}
}

type httpArtifactStoreStub struct {
	artifact protocol.Artifact
	reader   protocol.ArtifactReader
	err      error
}

type contentHTTPArtifactStoreStub struct {
	httpArtifactStoreStub
	contentOpens int
	fullOpens    int
}

func (s *contentHTTPArtifactStoreStub) Open(ctx context.Context, id string) (protocol.Artifact, protocol.ArtifactReader, error) {
	s.fullOpens++
	return s.httpArtifactStoreStub.Open(ctx, id)
}

func (s *contentHTTPArtifactStoreStub) OpenContentAt(ctx context.Context, id, _ string) (protocol.Artifact, protocol.ArtifactReader, error) {
	s.contentOpens++
	artifact, reader, err := s.httpArtifactStoreStub.Open(ctx, id)
	if err != nil {
		return protocol.Artifact{}, nil, err
	}
	return artifact, &contentVersionReaderStub{ArtifactReader: reader, version: "v1-test"}, nil
}

type contentVersionReaderStub struct {
	protocol.ArtifactReader
	version string
}

func (r *contentVersionReaderStub) contentVersion() string {
	return r.version
}

func (s httpArtifactStoreStub) Put(context.Context, protocol.Artifact, io.Reader) (protocol.Artifact, error) {
	return protocol.Artifact{}, errors.New("unexpected Put")
}

func (s httpArtifactStoreStub) Metadata(context.Context, string) (protocol.Artifact, error) {
	return protocol.Artifact{}, errors.New("unexpected Metadata")
}

func (s httpArtifactStoreStub) Open(context.Context, string) (protocol.Artifact, protocol.ArtifactReader, error) {
	if s.err != nil {
		return protocol.Artifact{}, nil, s.err
	}
	return s.artifact, s.reader, nil
}

func writeArtifactReader(t *testing.T, content []byte) protocol.ArtifactReader {
	t.Helper()
	path := filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return reader
}
