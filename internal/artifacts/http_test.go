package artifacts

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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

func TestDownloadHTTPHandlerMapsMissingUnauthorizedAndInvalidAccess(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "missing", err: ErrNotFound, status: http.StatusNotFound},
		{name: "unauthorized", err: ErrUnauthorized, status: http.StatusNotFound},
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
			if strings.Contains(response.Body.String(), test.err.Error()) && test.err != ErrInvalid {
				t.Fatalf("response leaked storage error: %q", response.Body.String())
			}
		})
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
