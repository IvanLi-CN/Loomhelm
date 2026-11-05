package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/deployment"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

func (w *Worker) startHealthServer() error {
	if w.cfg.WorkerHTTPAddr == "" {
		return nil
	}
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", w.cfg.WorkerHTTPAddr)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           w.healthRouter(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	done := make(chan error, 1)
	w.healthMu.Lock()
	w.healthServer = server
	w.healthDone = done
	w.healthMu.Unlock()
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		done <- err
		if err != nil {
			w.logger.Warn("worker health server stopped unexpectedly", "error", err)
		}
	}()
	return nil
}

func (w *Worker) stopHealthServer() error {
	w.healthMu.Lock()
	server := w.healthServer
	done := w.healthDone
	w.healthServer = nil
	w.healthDone = nil
	w.healthMu.Unlock()
	if server == nil {
		return nil
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), w.cfg.ShutdownTimeout)
	defer cancel()
	err := server.Shutdown(shutdownCtx)
	if err != nil {
		_ = server.Close()
	}
	if done != nil {
		select {
		case serveErr := <-done:
			err = errors.Join(err, serveErr)
		case <-shutdownCtx.Done():
			err = errors.Join(err, shutdownCtx.Err())
		}
	}
	return err
}

func (w *Worker) healthRouter() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/livez", w.handleWorkerLive)
	mux.HandleFunc("/readyz", w.handleWorkerReady)
	mux.HandleFunc("/version", w.handleWorkerVersion)
	mux.HandleFunc("/-/observe", w.handleWorkerObservation)
	mux.HandleFunc("/-/drain", w.handleWorkerDrainEndpoint)
	return mux
}

func (w *Worker) handleWorkerLive(writer http.ResponseWriter, _ *http.Request) {
	snapshot := w.Lifecycle()
	status := http.StatusOK
	statusText := "alive"
	if !snapshot.Live {
		status = http.StatusServiceUnavailable
		statusText = "not_alive"
	}
	w.writeWorkerJSON(writer, status, healthResponse{
		Status:      statusText,
		Component:   string(w.cfg.Component),
		Version:     w.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (w *Worker) handleWorkerReady(writer http.ResponseWriter, _ *http.Request) {
	snapshot := w.Lifecycle()
	status := http.StatusOK
	statusText := "ready"
	if !snapshot.Ready {
		status = http.StatusServiceUnavailable
		statusText = "not_ready"
	}
	w.writeWorkerJSON(writer, status, healthResponse{
		Status:      statusText,
		Component:   string(w.cfg.Component),
		Version:     w.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (w *Worker) handleWorkerVersion(writer http.ResponseWriter, _ *http.Request) {
	w.writeWorkerJSON(writer, http.StatusOK, versionResponse{
		Component:          string(w.cfg.Component),
		Version:            w.cfg.Version,
		CandidateSourceSHA: w.cfg.CandidateSource(),
		ArtifactDigest:     w.cfg.CandidateArtifactDigest(),
	})
}

func (w *Worker) handleWorkerObservation(writer http.ResponseWriter, request *http.Request) {
	snapshot := w.Lifecycle()
	workerGeneration := int64(w.cfg.WorkerGeneration)
	if generation := w.GenerationController(); generation != nil {
		workerGeneration = int64(generation.Current())
	}
	loadState := deployment.ObservationUnavailable
	loadReason := "worker queue observation is unavailable"
	var load workerLoadSnapshot
	w.resourceMu.RLock()
	resources := w.resources
	w.resourceMu.RUnlock()
	if observer, ok := resources.(runtimeLoadObserver); ok {
		loadCtx, cancel := context.WithTimeout(request.Context(), time.Second)
		observed, err := observer.ObserveLoad(loadCtx)
		cancel()
		if err == nil {
			load = observed
			loadState = deployment.ObservationMeasured
			loadReason = ""
		} else {
			loadState = deployment.ObservationDegraded
			loadReason = "worker queue observation failed"
		}
	}
	writeRuntimeObservation(writer, deployment.ComponentObservation{
		State:              deployment.ObservationMeasured,
		LoadState:          loadState,
		LoadReason:         loadReason,
		ObservedAt:         time.Now().UTC(),
		Live:               snapshot.Live,
		Ready:              snapshot.Ready,
		CandidateSourceSHA: w.cfg.CandidateSource(),
		ArtifactDigest:     w.cfg.CandidateArtifactDigest(),
		QueueDepth:         int64Pointer(load.QueueDepth, loadState == deployment.ObservationMeasured),
		RunningJobs:        int64Pointer(load.RunningJobs, loadState == deployment.ObservationMeasured),
		WorkerCapacity:     int64Pointer(load.WorkerCapacity, loadState == deployment.ObservationMeasured),
		WorkerGeneration:   &workerGeneration,
	})
}

func int64Pointer(value int64, available bool) *int64 {
	if !available {
		return nil
	}
	return &value
}

func (w *Worker) handleWorkerDrainStatus(writer http.ResponseWriter, _ *http.Request) {
	snapshot := w.Lifecycle()
	w.writeWorkerJSON(writer, http.StatusOK, healthResponse{
		Status:      string(snapshot.State),
		Component:   string(w.cfg.Component),
		Version:     w.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
}

func (w *Worker) handleWorkerDrainEndpoint(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet {
		w.handleWorkerDrainStatus(writer, request)
		return
	}
	w.handleWorkerDrain(writer, request)
}

func (w *Worker) handleWorkerDrain(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || !isAuthorizedDrainRequest(request, w.cfg.DrainControlSubnet) || !validDrainToken(w.cfg.DrainToken, request) {
		w.writeWorkerJSON(writer, http.StatusForbidden, healthResponse{
			Status:    "forbidden",
			Component: string(w.cfg.Component),
			Version:   w.cfg.Version,
			State:     w.Lifecycle().State,
		})
		return
	}
	snapshot := w.Lifecycle()
	if snapshot.State == platform.StateNew || snapshot.State == platform.StateStopped {
		w.writeWorkerJSON(writer, http.StatusConflict, healthResponse{
			Status:      "not_running",
			Component:   string(w.cfg.Component),
			Version:     w.cfg.Version,
			State:       snapshot.State,
			Live:        snapshot.Live,
			Ready:       snapshot.Ready,
			DrainReason: snapshot.DrainReason,
		})
		return
	}
	if w.lifecycle.BeginDrain("HTTP drain request") {
		w.logger.Info("worker entering drain", "reason", "HTTP drain request")
	}
	snapshot = w.Lifecycle()
	w.writeWorkerJSON(writer, http.StatusAccepted, healthResponse{
		Status:      string(snapshot.State),
		Component:   string(w.cfg.Component),
		Version:     w.cfg.Version,
		State:       snapshot.State,
		Live:        snapshot.Live,
		Ready:       snapshot.Ready,
		DrainReason: snapshot.DrainReason,
	})
	select {
	case w.shutdown <- struct{}{}:
	default:
	}
}

func (w *Worker) writeWorkerJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		w.logger.Warn("write worker health response failed", "error", err)
	}
}

func validDrainToken(token string, request *http.Request) bool {
	if token == "" {
		return false
	}
	const bearerPrefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	if len(authorization) <= len(bearerPrefix) || authorization[:len(bearerPrefix)] != bearerPrefix {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(authorization[len(bearerPrefix):]), []byte(token)) == 1
}
