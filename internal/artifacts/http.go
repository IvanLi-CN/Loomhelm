package artifacts

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
	"golang.org/x/sync/semaphore"
)

const (
	defaultDownloadContentType = "application/octet-stream"
	// Full downloads are staged before response headers are sent so a source
	// identity change can still return a conflict. Bound aggregate staging to
	// the store's configured artifact maximum (64 MiB by default) and limit
	// readers opened concurrently.
	maxStagedDownloadBytes      = int64(DefaultMaxBytes)
	maxConcurrentStagedDownload = 2
	// Network responses are admitted separately from staging so a slow client
	// cannot consume the two slots needed to verify and stage new artifacts.
	maxConcurrentDownloadResponses = 32
	// Full artifact downloads may be deliberately slow, but an absolute deadline
	// and shorter idle deadline keep a client from pinning transfer resources.
	DownloadWriteTimeout     = 2 * time.Minute
	downloadWriteTimeout     = DownloadWriteTimeout
	downloadWriteIdleTimeout = 30 * time.Second
)

// DefaultContentChunkBytes keeps the JSON envelope below the default MCP
// response budget while allowing the complete artifact to be reconstructed by
// following next_offset. REST callers may request smaller chunks as needed.
const DefaultContentChunkBytes int64 = 512 << 10

// DownloadErrorWriter lets the application layer preserve its existing API
// error envelope without making the storage package depend on auth or app.
type DownloadErrorWriter func(http.ResponseWriter, *http.Request, int, error, string)

// DownloadHTTPHandler streams one already-authorized artifact. The route is
// deliberately supplied by the application; it reads the chi parameter named
// artifact_id and does not create a standalone artifacts navigation surface.
type DownloadHTTPHandler struct {
	store                 protocol.ArtifactStore
	writeError            DownloadErrorWriter
	downloadStagingSlots  chan struct{}
	downloadResponseSlots chan struct{}
	maxStagingBytes       int64
	stagingBudget         *semaphore.Weighted
	stagingDir            string
	cleanupMu             sync.Mutex
	pendingStagingCleanup map[string]int64
	removeStagingFile     func(string) error
}

type artifactSizeLimit interface {
	maxArtifactBytes() int64
}

type contentSnapshotStore interface {
	OpenContentAt(context.Context, string, string) (protocol.Artifact, protocol.ArtifactReader, error)
}

type contentVersionReader interface {
	contentVersion() string
}

type contentVerifier interface {
	verifyContent(context.Context, protocol.Artifact) error
}

type contentVersionVerifier interface {
	verifyContentVersion(context.Context) error
}

// downloadReadSeeker records a content identity failure while the source is
// staged. ServeContent does not return read errors, so the handler must finish
// validating source bytes before it writes response headers.
type downloadReadSeeker struct {
	io.ReadSeeker
	err error
}

type downloadDeadlineWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
	absolute   time.Time
}

func withDownloadDeadline(request *http.Request) (*http.Request, context.CancelFunc, time.Time) {
	deadline := time.Now().Add(downloadWriteTimeout)
	if requestDeadline, ok := request.Context().Deadline(); ok && requestDeadline.Before(deadline) {
		deadline = requestDeadline
	}
	ctx, cancel := context.WithDeadline(request.Context(), deadline)
	return request.WithContext(ctx), cancel, deadline
}

func (w *downloadDeadlineWriter) Write(content []byte) (int, error) {
	deadline := time.Now().Add(downloadWriteIdleTimeout)
	if deadline.After(w.absolute) {
		deadline = w.absolute
	}
	_ = w.controller.SetWriteDeadline(deadline)
	return w.ResponseWriter.Write(content)
}

type downloadContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *downloadContextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func (r *downloadReadSeeker) Read(buffer []byte) (int, error) {
	n, err := r.ReadSeeker.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		r.err = err
	}
	return n, err
}

func (r *downloadReadSeeker) Seek(offset int64, whence int) (int64, error) {
	position, err := r.ReadSeeker.Seek(offset, whence)
	if err != nil {
		r.err = err
	}
	return position, err
}

type downloadResponseBuffer struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (w *downloadResponseBuffer) Header() http.Header {
	return w.header
}

func (w *downloadResponseBuffer) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *downloadResponseBuffer) Write(content []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(content)
}

func copyDownloadHeaders(destination, source http.Header) {
	for key := range destination {
		destination.Del(key)
	}
	for key, values := range source {
		destination[key] = append([]string(nil), values...)
	}
}

// NewDownloadHTTPHandler constructs a handler over the existing ArtifactStore
// contract. Browser downloads use Store.Open's full verification path; the
// production Store additionally implements the snapshot-bound content path,
// which preserves authorization and file identity checks without rehashing
// every chunk.
func NewDownloadHTTPHandler(store protocol.ArtifactStore, writeError DownloadErrorWriter) (*DownloadHTTPHandler, error) {
	return newDownloadHTTPHandler(store, writeError, os.TempDir(), os.Remove)
}

func newDownloadHTTPHandler(store protocol.ArtifactStore, writeError DownloadErrorWriter, stagingDir string, removeStagingFile func(string) error) (*DownloadHTTPHandler, error) {
	if store == nil {
		return nil, fmt.Errorf("artifact download store is required: %w", ErrStoreUnavailable)
	}
	if writeError == nil {
		writeError = writeDownloadError
	}
	if strings.TrimSpace(stagingDir) == "" {
		return nil, fmt.Errorf("artifact download staging directory is required: %w", ErrStoreUnavailable)
	}
	if removeStagingFile == nil {
		removeStagingFile = os.Remove
	}
	if err := cleanupOrphanedDownloadStagingIn(stagingDir, removeStagingFile); err != nil {
		return nil, fmt.Errorf("clean up artifact download staging: %w", ErrStoreUnavailable)
	}
	maxStagingBytes := maxStagedDownloadBytes
	if boundedStore, ok := store.(artifactSizeLimit); ok {
		if configuredLimit := boundedStore.maxArtifactBytes(); configuredLimit > 0 {
			maxStagingBytes = configuredLimit
		}
	}
	return &DownloadHTTPHandler{
		store:                 store,
		writeError:            writeError,
		downloadStagingSlots:  make(chan struct{}, maxConcurrentStagedDownload),
		downloadResponseSlots: make(chan struct{}, maxConcurrentDownloadResponses),
		maxStagingBytes:       maxStagingBytes,
		stagingBudget:         semaphore.NewWeighted(maxStagingBytes),
		stagingDir:            stagingDir,
		pendingStagingCleanup: make(map[string]int64),
		removeStagingFile:     removeStagingFile,
	}, nil
}

func (h *DownloadHTTPHandler) acquireDownloadSlot(ctx context.Context) (func(), error) {
	return acquireDownloadSlot(ctx, h.downloadStagingSlots)
}

func (h *DownloadHTTPHandler) acquireDownloadResponseSlot(ctx context.Context) (func(), error) {
	return acquireDownloadSlot(ctx, h.downloadResponseSlots)
}

func acquireDownloadSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, ErrStoreUnavailable
	}
}

// SafeDownloadFilename returns the filename representation suitable for
// owner-facing artifact metadata and download headers. Legacy records are
// sanitized at read time as well as new names being rejected at write time.
func SafeDownloadFilename(name string) string {
	return safeDownloadFilename(name)
}

func (h *DownloadHTTPHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if h == nil || h.store == nil {
		writeDownloadError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download is unavailable")
		return
	}
	var cancel context.CancelFunc
	request, cancel, downloadDeadline := withDownloadDeadline(request)
	defer cancel()
	h.retryPendingStagingCleanup()
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
		h.writeError(writer, request, http.StatusMethodNotAllowed, ErrInvalid, "artifact download method is not allowed")
		return
	}
	id := chi.URLParam(request, "artifact_id")
	if id == "" {
		h.writeError(writer, request, http.StatusNotFound, ErrNotFound, "artifact was not found")
		return
	}
	var releaseSlot func()
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		var slotErr error
		releaseSlot, slotErr = h.acquireDownloadSlot(request.Context())
		if slotErr != nil {
			if request.Context().Err() != nil {
				return
			}
			h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download capacity is temporarily exhausted")
			return
		}
		defer func() {
			if releaseSlot != nil {
				releaseSlot()
			}
		}()
	}
	artifact, reader, err := h.store.Open(request.Context(), id)
	if err != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeStoreError(writer, request, err, "artifact download is unavailable")
		return
	}
	defer reader.Close()
	if err := validateDownloadRange(request, artifact.Size); err != nil {
		h.writeRangeError(writer, request, artifact.Size, err)
		return
	}
	var staged *os.File
	if request.Method == http.MethodGet {
		var releaseStaging func()
		staged, releaseStaging, err = h.stageDownload(request.Context(), reader, artifact)
		if err != nil {
			if request.Context().Err() != nil {
				return
			}
			h.writeStoreError(writer, request, err, "artifact download could not be staged safely")
			return
		}
		defer releaseStaging()
		if request.Context().Err() != nil {
			return
		}
	}
	if releaseSlot != nil {
		releaseSlot()
		releaseSlot = nil
	}
	releaseResponseSlot, responseSlotErr := h.acquireDownloadResponseSlot(request.Context())
	if responseSlotErr != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download response capacity is temporarily exhausted")
		return
	}
	defer releaseResponseSlot()

	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Disposition", contentDisposition(artifact.Name))
	writer.Header().Set("Content-Type", safeDownloadContentType(artifact.ContentType))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if artifact.Sha256 != "" {
		writer.Header().Set("ETag", `"`+artifact.Sha256+`"`)
	}
	modTime := parseDownloadTime(artifact.CreatedAt)
	responseController := http.NewResponseController(writer)
	// Staging and network writes share one absolute request deadline so a slow
	// source cannot consume the full transfer budget before response writes begin.
	_ = responseController.SetWriteDeadline(downloadDeadline)
	if request.Method == http.MethodGet {
		deadlineWriter := &downloadDeadlineWriter{ResponseWriter: writer, controller: responseController, absolute: downloadDeadline}
		http.ServeContent(deadlineWriter, request, safeDownloadFilename(artifact.Name), modTime, staged)
		_ = responseController.Flush()
		return
	}
	trackedReader := &downloadReadSeeker{ReadSeeker: reader}
	buffer := &downloadResponseBuffer{header: writer.Header().Clone()}
	http.ServeContent(buffer, request, safeDownloadFilename(artifact.Name), modTime, trackedReader)
	if trackedReader.err != nil {
		if request.Context().Err() != nil {
			return
		}
		for key := range writer.Header() {
			writer.Header().Del(key)
		}
		h.writeStoreError(writer, request, trackedReader.err, "artifact download failed while reading content")
		return
	}
	copyDownloadHeaders(writer.Header(), buffer.header)
	if buffer.status == 0 {
		buffer.status = http.StatusOK
	}
	writer.WriteHeader(buffer.status)
	_ = responseController.Flush()
}

func (h *DownloadHTTPHandler) stageDownload(ctx context.Context, reader io.ReadSeeker, artifact protocol.Artifact) (*os.File, func(), error) {
	h.retryPendingStagingCleanup()
	if h.cleanupBlocked() {
		return nil, nil, ErrStoreUnavailable
	}
	size := artifact.Size
	if size < 0 {
		return nil, nil, ErrSizeMismatch
	}
	if size > h.maxStagingBytes {
		return nil, nil, ErrTooLarge
	}
	weight := size
	if weight == 0 {
		weight = 1
	}
	if err := h.stagingBudget.Acquire(ctx, weight); err != nil {
		return nil, nil, err
	}

	stagingFile, err := os.CreateTemp(h.stagingDir, "loomhelm-artifact-download-*")
	if err != nil {
		h.stagingBudget.Release(weight)
		return nil, nil, fmt.Errorf("create artifact download staging file: %w", ErrStoreUnavailable)
	}
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			_ = stagingFile.Close()
			remove := h.removeStagingFile
			if remove == nil {
				remove = os.Remove
			}
			if err := remove(stagingFile.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
				// Keep the weighted budget occupied until a later request confirms
				// that the file is gone. This preserves the disk bound while making
				// transient cleanup failures retryable within the same process.
				h.rememberPendingStagingCleanup(stagingFile.Name(), weight)
				return
			}
			h.stagingBudget.Release(weight)
		})
	}
	staged := false
	defer func() {
		if !staged {
			release()
		}
	}()

	trackedReader := &downloadReadSeeker{ReadSeeker: reader}
	if _, err := trackedReader.Seek(0, io.SeekStart); err != nil {
		return nil, nil, err
	}
	contextReader := &downloadContextReader{ctx: ctx, reader: trackedReader}
	copied, err := io.CopyN(stagingFile, contextReader, size)
	if trackedReader.err != nil {
		return nil, nil, trackedReader.err
	}
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, ErrSizeMismatch
		}
		return nil, nil, err
	}
	if copied != size {
		return nil, nil, ErrSizeMismatch
	}
	var extra [1]byte
	read, err := contextReader.Read(extra[:])
	if trackedReader.err != nil {
		return nil, nil, trackedReader.err
	}
	if read > 0 {
		return nil, nil, ErrSizeMismatch
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}
	if artifact.Sha256 != "" {
		if err := verifyFile(ctx, stagingFile, artifact); err != nil {
			return nil, nil, err
		}
	}
	if _, err := stagingFile.Seek(0, io.SeekStart); err != nil {
		return nil, nil, fmt.Errorf("rewind artifact download staging file: %w", ErrStoreUnavailable)
	}
	staged = true
	return stagingFile, release, nil
}

func cleanupOrphanedDownloadStaging() error {
	return cleanupOrphanedDownloadStagingIn(os.TempDir(), os.Remove)
}

func cleanupOrphanedDownloadStagingIn(stagingDir string, remove func(string) error) error {
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return fmt.Errorf("read staging directory: %w", err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "loomhelm-artifact-download-") {
			continue
		}
		// Staging files are private temporary names. An active process keeps its
		// file descriptor open, so unlinking the name does not interrupt its
		// response; the releasing handler treats os.ErrNotExist as successful
		// cleanup. This also removes crash leftovers immediately after a fast
		// restart instead of allowing one full transfer timeout per generation.
		if err := remove(filepath.Join(stagingDir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove orphaned staging file %q: %w", entry.Name(), err)
		}
	}
	return nil
}

func (h *DownloadHTTPHandler) cleanupBlocked() bool {
	h.cleanupMu.Lock()
	defer h.cleanupMu.Unlock()
	return len(h.pendingStagingCleanup) >= maxConcurrentDownloadResponses
}

func (h *DownloadHTTPHandler) rememberPendingStagingCleanup(path string, weight int64) {
	h.cleanupMu.Lock()
	defer h.cleanupMu.Unlock()
	if h.pendingStagingCleanup == nil {
		h.pendingStagingCleanup = make(map[string]int64)
	}
	h.pendingStagingCleanup[path] = weight
}

func (h *DownloadHTTPHandler) retryPendingStagingCleanup() {
	h.cleanupMu.Lock()
	pending := make(map[string]int64, len(h.pendingStagingCleanup))
	for path, weight := range h.pendingStagingCleanup {
		pending[path] = weight
	}
	h.cleanupMu.Unlock()
	if len(pending) == 0 {
		return
	}
	remove := h.removeStagingFile
	if remove == nil {
		remove = os.Remove
	}
	for path := range pending {
		if err := remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			continue
		}
		h.cleanupMu.Lock()
		weight, ok := h.pendingStagingCleanup[path]
		if ok {
			delete(h.pendingStagingCleanup, path)
			h.stagingBudget.Release(weight)
		}
		h.cleanupMu.Unlock()
	}
}

// ServeContentHTTP returns a bounded, cursor-addressed JSON chunk for API and
// MCP callers. The content store repeats authorization, ready-state, regular
// file and exact-size checks for every request; content_version binds later
// cursors to the same file incarnation. The first response chunk is fully
// hashed before bytes are emitted. Later chunks use the content version token,
// including change time, to reject a rewrite without rescanning the complete
// object for every cursor request.
func (h *DownloadHTTPHandler) ServeContentHTTP(writer http.ResponseWriter, request *http.Request) {
	if h == nil || h.store == nil {
		writeDownloadError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download is unavailable")
		return
	}
	var cancel context.CancelFunc
	request, cancel, downloadDeadline := withDownloadDeadline(request)
	defer cancel()
	h.retryPendingStagingCleanup()
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		h.writeError(writer, request, http.StatusMethodNotAllowed, ErrInvalid, "artifact content method is not allowed")
		return
	}
	id := chi.URLParam(request, "artifact_id")
	if id == "" {
		h.writeError(writer, request, http.StatusNotFound, ErrNotFound, "artifact was not found")
		return
	}
	offset, limit, expectedVersion, err := contentChunkQuery(request)
	if err != nil {
		h.writeError(writer, request, http.StatusBadRequest, ErrInvalid, err.Error())
		return
	}
	if offset > 0 && expectedVersion == "" {
		h.writeError(writer, request, http.StatusBadRequest, ErrInvalid, "artifact content_version is required when offset is non-zero")
		return
	}
	releaseSlot, slotErr := h.acquireDownloadSlot(request.Context())
	if slotErr != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download capacity is temporarily exhausted")
		return
	}
	defer func() {
		if releaseSlot != nil {
			releaseSlot()
		}
	}()
	artifact, reader, version, versioned, err := h.openContent(request.Context(), id, expectedVersion)
	if err != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeStoreError(writer, request, err, "artifact download is unavailable")
		return
	}
	defer reader.Close()
	if offset > artifact.Size {
		h.writeError(writer, request, http.StatusBadRequest, ErrInvalid, "artifact content offset exceeds artifact size")
		return
	}
	if offset > 0 && !versioned {
		h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact content snapshot is unavailable")
		return
	}
	if offset == 0 {
		if verifier, ok := reader.(contentVerifier); ok {
			if err := verifier.verifyContent(request.Context(), artifact); err != nil {
				if request.Context().Err() != nil {
					return
				}
				h.writeStoreError(writer, request, err, "artifact content verification failed")
				return
			}
		}
	}
	remaining := artifact.Size - offset
	chunkSize := remaining
	if chunkSize > limit {
		chunkSize = limit
	}
	if _, err := reader.Seek(offset, io.SeekStart); err != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeStoreError(writer, request, err, "artifact content seek failed")
		return
	}
	content := make([]byte, 0, chunkSize)
	if chunkSize > 0 {
		content, err = io.ReadAll(io.LimitReader(&downloadContextReader{ctx: request.Context(), reader: reader}, chunkSize))
		if err != nil {
			if request.Context().Err() != nil {
				return
			}
			h.writeStoreError(writer, request, err, "artifact content read failed")
			return
		}
		if int64(len(content)) != chunkSize {
			h.writeError(writer, request, http.StatusNotFound, ErrSizeMismatch, "artifact content is incomplete")
			return
		}
	}
	if verifier, ok := reader.(contentVersionVerifier); ok {
		if err := verifier.verifyContentVersion(request.Context()); err != nil {
			if request.Context().Err() != nil {
				return
			}
			h.writeStoreError(writer, request, err, "artifact content verification failed")
			return
		}
	}
	nextOffset := offset + int64(len(content))
	if nextOffset < artifact.Size && !versioned {
		h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact content snapshot is unavailable")
		return
	}
	releaseResponseSlot, responseSlotErr := h.acquireDownloadResponseSlot(request.Context())
	if responseSlotErr != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download response capacity is temporarily exhausted")
		return
	}
	defer releaseResponseSlot()
	if releaseSlot != nil {
		releaseSlot()
		releaseSlot = nil
	}
	response := protocol.ArtifactContentResponse{
		Artifact:       artifact,
		ContentBase64:  base64.StdEncoding.EncodeToString(content),
		ContentVersion: version,
		Offset:         offset,
		NextOffset:     nextOffset,
		TotalSize:      artifact.Size,
		Complete:       nextOffset == artifact.Size,
	}
	response.Artifact.Name = safeDownloadFilename(response.Artifact.Name)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	responseController := http.NewResponseController(writer)
	_ = responseController.SetWriteDeadline(downloadDeadline)
	if err := json.NewEncoder(writer).Encode(response); err != nil && request.Context().Err() == nil {
		return
	}
	_ = responseController.Flush()
}

func (h *DownloadHTTPHandler) openContent(ctx context.Context, id, expectedVersion string) (protocol.Artifact, protocol.ArtifactReader, string, bool, error) {
	if store, ok := h.store.(contentSnapshotStore); ok {
		artifact, reader, err := store.OpenContentAt(ctx, id, expectedVersion)
		if err != nil {
			return protocol.Artifact{}, nil, "", false, err
		}
		versionReader, ok := reader.(contentVersionReader)
		if !ok || versionReader.contentVersion() == "" {
			_ = reader.Close()
			return protocol.Artifact{}, nil, "", false, fmt.Errorf("artifact content snapshot is unavailable: %w", ErrStoreUnavailable)
		}
		return artifact, reader, versionReader.contentVersion(), true, nil
	}
	artifact, reader, err := h.store.Open(ctx, id)
	if err != nil {
		return protocol.Artifact{}, nil, "", false, err
	}
	version := "verified"
	if artifact.Sha256 != "" {
		version += "-" + artifact.Sha256
	}
	return artifact, reader, version, false, nil
}

func (h *DownloadHTTPHandler) writeStoreError(writer http.ResponseWriter, request *http.Request, err error, message string) {
	if errors.Is(err, ErrRecoveryPending) || errors.Is(err, ErrRecoveryIncomplete) {
		writer.Header().Set("Retry-After", "60")
	}
	h.writeError(writer, request, downloadStatus(err), err, message)
}

func (h *DownloadHTTPHandler) writeRangeError(writer http.ResponseWriter, request *http.Request, size int64, err error) {
	writer.Header().Set("Accept-Ranges", "bytes")
	writer.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
	h.writeError(writer, request, http.StatusRequestedRangeNotSatisfiable, err, "artifact range is not satisfiable")
}

func validateDownloadRange(request *http.Request, size int64) error {
	values := request.Header.Values("Range")
	if len(values) == 0 || (len(values) == 1 && strings.TrimSpace(values[0]) == "") {
		return nil
	}
	if len(values) != 1 {
		// Multiple field values are delegated to net/http, which applies the
		// standard combined-range behavior instead of manufacturing a 416.
		return nil
	}
	rangeValue := strings.TrimSpace(values[0])
	if !strings.Contains(rangeValue, "=") {
		return ErrRangeNotSatisfiable
	}
	if !strings.HasPrefix(rangeValue, "bytes=") {
		// RFC 9110 permits a server to ignore a Range unit it does not
		// understand and return the complete representation.
		request.Header.Del("Range")
		return nil
	}
	specification := strings.TrimSpace(strings.TrimPrefix(rangeValue, "bytes="))
	if strings.Contains(specification, ",") {
		for _, part := range strings.Split(specification, ",") {
			if err := validateSingleDownloadRange(strings.TrimSpace(part), size); err != nil {
				return err
			}
		}
		return nil
	}
	return validateSingleDownloadRange(specification, size)
}

func validateSingleDownloadRange(specification string, size int64) error {
	parts := strings.Split(specification, "-")
	if len(parts) != 2 || specification == "-" || size < 0 {
		return ErrRangeNotSatisfiable
	}
	if parts[0] == "" {
		suffix, err := parseDownloadRangeNumber(parts[1])
		if err != nil || suffix <= 0 || size == 0 {
			return ErrRangeNotSatisfiable
		}
		return nil
	}
	start, err := parseDownloadRangeNumber(parts[0])
	if err != nil || start < 0 || start >= size {
		return ErrRangeNotSatisfiable
	}
	if parts[1] == "" {
		return nil
	}
	end, err := parseDownloadRangeNumber(parts[1])
	if err != nil || end < start {
		return ErrRangeNotSatisfiable
	}
	return nil
}

func parseDownloadRangeNumber(value string) (int64, error) {
	if value == "" {
		return 0, strconv.ErrSyntax
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return 0, strconv.ErrSyntax
		}
	}
	return strconv.ParseInt(value, 10, 64)
}

func contentChunkQuery(request *http.Request) (int64, int64, string, error) {
	query := request.URL.Query()
	offset := int64(0)
	if value := query.Get("offset"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 0 {
			return 0, 0, "", fmt.Errorf("artifact content offset must be a non-negative integer")
		}
		offset = parsed
	}
	limit := DefaultContentChunkBytes
	if value := query.Get("limit"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 1 || parsed > DefaultContentChunkBytes {
			return 0, 0, "", fmt.Errorf("artifact content limit must be between 1 and %d bytes", DefaultContentChunkBytes)
		}
		limit = parsed
	}
	contentVersion := query.Get("content_version")
	if len(contentVersion) > 128 {
		return 0, 0, "", fmt.Errorf("artifact content_version is too long")
	}
	return offset, limit, contentVersion, nil
}

func downloadStatus(err error) int {
	switch {
	case errors.Is(err, ErrInvalid):
		return http.StatusBadRequest
	case errors.Is(err, ErrContentChanged):
		return http.StatusConflict
	case errors.Is(err, ErrTooLarge):
		return http.StatusRequestEntityTooLarge
	case errors.Is(err, ErrRangeNotSatisfiable):
		return http.StatusRequestedRangeNotSatisfiable
	case errors.Is(err, ErrRecoveryPending), errors.Is(err, ErrRecoveryIncomplete):
		return http.StatusServiceUnavailable
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrUnauthorized), errors.Is(err, ErrUnavailable),
		errors.Is(err, ErrIntegrity), errors.Is(err, ErrSizeMismatch), errors.Is(err, ErrHashMismatch):
		return http.StatusNotFound
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return http.StatusRequestTimeout
	default:
		return http.StatusServiceUnavailable
	}
}

func writeDownloadError(writer http.ResponseWriter, _ *http.Request, status int, _ error, message string) {
	http.Error(writer, message, status)
}

func safeDownloadContentType(value string) string {
	if strings.ContainsAny(value, "\r\n") {
		return defaultDownloadContentType
	}
	mediaType, params, err := mime.ParseMediaType(value)
	if err != nil || mediaType == "" {
		return defaultDownloadContentType
	}
	formatted := mime.FormatMediaType(mediaType, params)
	if formatted == "" || strings.ContainsAny(formatted, "\r\n") {
		return defaultDownloadContentType
	}
	return formatted
}

func contentDisposition(name string) string {
	safeName := safeDownloadFilename(name)
	return fmt.Sprintf(
		`attachment; filename="%s"; filename*=UTF-8''%s`,
		escapeQuotedFilename(asciiFilename(safeName)),
		url.PathEscape(safeName),
	)
}

func safeDownloadFilename(name string) string {
	if !utf8.ValidString(name) {
		return "download"
	}
	var builder strings.Builder
	for _, character := range name {
		switch {
		case character == '/' || character == '\\' || unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character):
			builder.WriteByte('_')
		default:
			builder.WriteRune(character)
		}
	}
	safeName := strings.TrimSpace(builder.String())
	if safeName == "" || safeName == "." || safeName == ".." {
		return "download"
	}
	return safeName
}

func asciiFilename(name string) string {
	var builder strings.Builder
	for _, character := range name {
		if character >= 0x20 && character <= 0x7e && character != '"' && character != '\\' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte('_')
		}
	}
	if builder.Len() == 0 {
		return "download"
	}
	return builder.String()
}

func escapeQuotedFilename(name string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(name)
}

func parseDownloadTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
