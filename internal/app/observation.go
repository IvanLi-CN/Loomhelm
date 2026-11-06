package app

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/deployment"
)

type requestMetrics struct {
	requestsTotal atomic.Uint64
	responses4xx  atomic.Uint64
	responses5xx  atomic.Uint64
}

type trackedResponseWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *trackedResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *trackedResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func (w *trackedResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *trackedResponseWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *trackedResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return hijacker.Hijack()
}

func (w *trackedResponseWriter) Push(target string, options *http.PushOptions) error {
	pusher, ok := w.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return pusher.Push(target, options)
}

func (w *trackedResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(reader)
	}
	return io.Copy(w.ResponseWriter, reader)
}

func (m *requestMetrics) track(active *atomic.Int64, writer http.ResponseWriter, handler http.Handler, request *http.Request) {
	active.Add(1)
	defer active.Add(-1)
	m.requestsTotal.Add(1)
	tracked := &trackedResponseWriter{ResponseWriter: writer}
	handler.ServeHTTP(tracked, request)
	status := tracked.status
	if status == 0 {
		status = http.StatusOK
	}
	switch {
	case status >= http.StatusInternalServerError:
		m.responses5xx.Add(1)
	case status >= http.StatusBadRequest:
		m.responses4xx.Add(1)
	}
}

func (s *Server) serverObservation() deployment.ComponentObservation {
	snapshot := s.lifecycle.Snapshot()
	return deployment.ComponentObservation{
		State:                 deployment.ObservationMeasured,
		LoadState:             deployment.ObservationMeasured,
		ObservedAt:            time.Now().UTC(),
		Live:                  snapshot.Live,
		Ready:                 snapshot.Ready,
		CandidateSourceSHA:    s.cfg.CandidateSource(),
		ArtifactDigest:        s.cfg.CandidateArtifactDigest(),
		RequestsTotal:         s.requestMetrics.requestsTotal.Load(),
		Responses4xx:          s.requestMetrics.responses4xx.Load(),
		Responses5xx:          s.requestMetrics.responses5xx.Load(),
		ActiveRequests:        s.activeApplicationRequests.Load() + s.activeMCPRequests.Load() + s.activeGatewayRequests.Load(),
		ActiveMCPRequests:     s.activeMCPRequests.Load(),
		ActiveGatewayRequests: s.activeGatewayRequests.Load(),
	}
}

func writeRuntimeObservation(writer http.ResponseWriter, observation deployment.ComponentObservation) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_ = jsonEncode(writer, observation)
}

func jsonEncode(writer http.ResponseWriter, value any) error {
	return json.NewEncoder(writer).Encode(value)
}

type workerLoadSnapshot struct {
	QueueDepth     int64
	RunningJobs    int64
	WorkerCapacity int64
}

type runtimeLoadObserver interface {
	ObserveLoad(context.Context) (workerLoadSnapshot, error)
}
