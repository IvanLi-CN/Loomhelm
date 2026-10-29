package artifacts

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
)

const defaultDownloadContentType = "application/octet-stream"

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
	store      protocol.ArtifactStore
	writeError DownloadErrorWriter
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
	return &DownloadHTTPHandler{store: store, writeError: writeError}, nil
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
	artifact, reader, err := h.store.Open(request.Context(), id)
	if err != nil {
		if request.Context().Err() != nil {
			return
		}
		h.writeStoreError(writer, request, err, "artifact download is unavailable")
		return
	}
	defer reader.Close()

	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Disposition", contentDisposition(artifact.Name))
	writer.Header().Set("Content-Type", safeDownloadContentType(artifact.ContentType))
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if artifact.Sha256 != "" {
		writer.Header().Set("ETag", `"`+artifact.Sha256+`"`)
	}
	modTime := parseDownloadTime(artifact.CreatedAt)
	http.ServeContent(writer, request, safeDownloadFilename(artifact.Name), modTime, reader)
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
		h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact content seek failed")
		return
	}
	content := make([]byte, 0, chunkSize)
	if chunkSize > 0 {
		content, err = io.ReadAll(io.LimitReader(reader, chunkSize))
		if err != nil {
			if request.Context().Err() != nil {
				return
			}
			h.writeError(writer, request, http.StatusServiceUnavailable, ErrStoreUnavailable, "artifact content read failed")
			return
		}
		if int64(len(content)) != chunkSize {
			h.writeError(writer, request, http.StatusNotFound, ErrSizeMismatch, "artifact content is incomplete")
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
		case character == '/' || character == '\\' || unicode.IsControl(character):
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
