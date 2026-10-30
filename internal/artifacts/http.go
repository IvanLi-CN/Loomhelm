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
	"strconv"
	"strings"
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
	// the default artifact maximum and limit readers opened concurrently.
	maxStagedDownloadBytes      = int64(DefaultMaxBytes)
	maxConcurrentStagedDownload = 2
	// The application Server keeps a 60-second default response deadline for
	// ordinary APIs. Full artifact downloads are bounded to 64 MiB and may be
	// deliberately slow, so extend only this route's write deadline without
	// weakening the timeout for the rest of the Server.
	downloadWriteTimeout = 10 * time.Minute
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
	store                protocol.ArtifactStore
	writeError           DownloadErrorWriter
	downloadStagingSlots chan struct{}
	stagingBudget        *semaphore.Weighted
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
	if store == nil {
		return nil, fmt.Errorf("artifact download store is required: %w", ErrStoreUnavailable)
	}
	if writeError == nil {
		writeError = writeDownloadError
	}
	return &DownloadHTTPHandler{
		store:                store,
		writeError:           writeError,
		downloadStagingSlots: make(chan struct{}, maxConcurrentStagedDownload),
		stagingBudget:        semaphore.NewWeighted(maxStagedDownloadBytes),
	}, nil
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
	if request.Method == http.MethodGet {
		select {
		case h.downloadStagingSlots <- struct{}{}:
			defer func() { <-h.downloadStagingSlots }()
		case <-request.Context().Done():
			return
		default:
			h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download capacity is temporarily exhausted")
			return
		}
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
	var staged *os.File
	if request.Method == http.MethodGet {
		var releaseStaging func()
		staged, releaseStaging, err = h.stageDownload(request.Context(), reader, artifact.Size)
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

	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Disposition", contentDisposition(artifact.Name))
	writer.Header().Set("Content-Type", safeDownloadContentType(artifact.ContentType))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if artifact.Sha256 != "" {
		writer.Header().Set("ETag", `"`+artifact.Sha256+`"`)
	}
	modTime := parseDownloadTime(artifact.CreatedAt)
	responseController := http.NewResponseController(writer)
	// Staging reads the full artifact before any response bytes are sent. Start
	// the network-write deadline only after staging has completed.
	_ = responseController.SetWriteDeadline(time.Now().Add(downloadWriteTimeout))
	defer func() { _ = responseController.SetWriteDeadline(time.Time{}) }()
	if request.Method == http.MethodGet {
		http.ServeContent(writer, request, safeDownloadFilename(artifact.Name), modTime, staged)
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
}

func (h *DownloadHTTPHandler) stageDownload(ctx context.Context, reader io.ReadSeeker, size int64) (*os.File, func(), error) {
	if size < 0 {
		return nil, nil, ErrSizeMismatch
	}
	if size > maxStagedDownloadBytes {
		return nil, nil, ErrTooLarge
	}
	weight := size
	if weight == 0 {
		weight = 1
	}
	if err := h.stagingBudget.Acquire(ctx, weight); err != nil {
		return nil, nil, err
	}

	stagingFile, err := os.CreateTemp("", "loomhelm-artifact-download-*")
	if err != nil {
		h.stagingBudget.Release(weight)
		return nil, nil, fmt.Errorf("create artifact download staging file: %w", ErrStoreUnavailable)
	}
	release := func() {
		_ = stagingFile.Close()
		_ = os.Remove(stagingFile.Name())
		h.stagingBudget.Release(weight)
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
	if _, err := stagingFile.Seek(0, io.SeekStart); err != nil {
		return nil, nil, fmt.Errorf("rewind artifact download staging file: %w", ErrStoreUnavailable)
	}
	staged = true
	return stagingFile, release, nil
}

// ServeContentHTTP returns a bounded, cursor-addressed JSON chunk for API and
// MCP callers. The content store repeats authorization, ready-state, regular
// file and exact-size checks for every request; content_version binds later
// cursors to the same file incarnation, and the final chunk rechecks the
// canonical SHA-256 before reporting complete=true.
func (h *DownloadHTTPHandler) ServeContentHTTP(writer http.ResponseWriter, request *http.Request) {
	if h == nil || h.store == nil {
		writeDownloadError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact download is unavailable")
		return
	}
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
		content, err = io.ReadAll(io.LimitReader(reader, chunkSize))
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
	if nextOffset == artifact.Size {
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
	if err := json.NewEncoder(writer).Encode(response); err != nil && request.Context().Err() == nil {
		return
	}
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
