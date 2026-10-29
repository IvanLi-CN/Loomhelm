package artifacts

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/go-chi/chi/v5"
)

const defaultDownloadContentType = "application/octet-stream"

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

// NewDownloadHTTPHandler constructs a handler over the existing ArtifactStore
// contract. Store.Open remains the only authorization and byte-verification
// boundary.
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
		h.writeError(writer, request, downloadStatus(err), err, "artifact download is unavailable")
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

func downloadStatus(err error) int {
	switch {
	case errors.Is(err, ErrInvalid):
		return http.StatusBadRequest
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
