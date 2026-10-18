package platform

import (
	"io"
	"log/slog"
)

func NewLogger(output io.Writer, component Component, version string) *slog.Logger {
	if output == nil {
		output = io.Discard
	}
	return slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{})).With(
		"component", string(component),
		"version", version,
	)
}
