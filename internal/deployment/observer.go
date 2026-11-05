package deployment

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

type observationSample struct {
	at     time.Time
	totals map[string]uint64
	errors map[string]uint64
}

type routeIdentity struct {
	CandidateSourceSHA string `json:"candidate_source_sha"`
	ArtifactDigest     string `json:"artifact_digest"`
}

func (e *CommandExecutor) Observe(ctx context.Context, status Status) (Observation, error) {
	if e == nil {
		return unavailableObservation(status, "deployment executor is unavailable"), nil
	}
	if ctx == nil {
		return unavailableObservation(status, "observation context is unavailable"), nil
	}

	e.observationMu.Lock()
	defer e.observationMu.Unlock()

	now := time.Now().UTC()
	result := Observation{
		State:                 ObservationMeasured,
		ObservedAt:            now,
		DesiredActiveSlot:     status.ActiveSlot,
		MigrationState:        ObservationUnknown,
		SharedWorkerLoadState: ObservationUnavailable,
		Slots:                 make([]SlotObservation, len(status.Slots)),
	}

	type componentResult struct {
		server ComponentObservation
		worker ComponentObservation
	}
	results := make([]componentResult, len(status.Slots))
	var wait sync.WaitGroup
	for index, slot := range status.Slots {
		index, slot := index, slot
		results[index] = componentResult{
			server: unavailableComponent("server observation endpoint is unavailable"),
			worker: unavailableComponent("worker observation endpoint is unavailable"),
		}
		wait.Add(2)
		go func() {
			defer wait.Done()
			if observation, err := e.fetchComponent(ctx, e.SlotURLs[slot.Name]); err == nil {
				results[index].server = observation
			}
		}()
		go func() {
			defer wait.Done()
			if observation, err := e.fetchComponent(ctx, e.WorkerURLs[slot.Name]); err == nil {
				results[index].worker = observation
			}
		}()
	}
	wait.Wait()

	previous := e.observationSample
	sample := &observationSample{at: now, totals: make(map[string]uint64), errors: make(map[string]uint64)}
	validDeltas := make(map[string]struct {
		total uint64
		error uint64
	})
	counterResets := make(map[string]struct{})
	window := 0.0
	if previous != nil {
		window = now.Sub(previous.at).Seconds()
		if window <= 0 {
			window = 0
		}
	}
	for index, slot := range status.Slots {
		component := results[index].server
		worker := results[index].worker
		load := SlotLoadObservation{
			State:              component.LoadState,
			Reason:             component.LoadReason,
			HTTPActiveRequests: component.ActiveRequests,
		}
		if workerObservationMatches(slot, worker) {
			load.WorkerRunningJobs = cloneInt64Pointer(worker.RunningJobs)
			load.WorkerCapacity = cloneInt64Pointer(worker.WorkerCapacity)
			if load.WorkerRunningJobs != nil && load.WorkerCapacity != nil && *load.WorkerCapacity > 0 {
				utilization := float64(*load.WorkerRunningJobs) / float64(*load.WorkerCapacity)
				load.WorkerUtilization = &utilization
			}
		} else {
			load.State = ObservationDegraded
			if load.Reason == "" {
				load.Reason = worker.LoadReason
			}
			if load.Reason == "" {
				load.Reason = "Worker generation load is unavailable"
			}
		}
		result.Slots[index] = SlotObservation{
			Slot:             slot.Name,
			DesiredState:     slot.State,
			CandidateID:      slot.CandidateID,
			WorkerGeneration: slot.WorkerGeneration,
			Server:           component,
			Worker:           worker,
			Traffic: SlotTrafficObservation{
				State:          component.State,
				Reason:         component.Reason,
				RequestsTotal:  component.RequestsTotal,
				ActiveRequests: component.ActiveRequests,
			},
			Load: load,
		}
		if component.State == ObservationMeasured {
			sample.totals[slot.Name] = component.RequestsTotal
			sample.errors[slot.Name] = component.Responses4xx + component.Responses5xx
			if previous != nil && window > 0 {
				previousTotal, totalOK := previous.totals[slot.Name]
				previousErrors, errorsOK := previous.errors[slot.Name]
				if totalOK && errorsOK && component.RequestsTotal >= previousTotal && sample.errors[slot.Name] >= previousErrors {
					validDeltas[slot.Name] = struct {
						total uint64
						error uint64
					}{total: component.RequestsTotal - previousTotal, error: sample.errors[slot.Name] - previousErrors}
				} else if totalOK && errorsOK && (component.RequestsTotal < previousTotal || sample.errors[slot.Name] < previousErrors) {
					counterResets[slot.Name] = struct{}{}
					result.Slots[index].Traffic.State = ObservationUnknown
					result.Slots[index].Traffic.Reason = "runtime counter reset; waiting for a fresh sample"
				}
			}
		}
	}
	workerEndpointResponded := false
	for index, slot := range status.Slots {
		worker := results[index].worker
		if worker.State != ObservationUnavailable {
			workerEndpointResponded = true
		}
		if !workerObservationMatches(slot, worker) {
			continue
		}
		if result.SharedWorkerLoadState == ObservationMeasured {
			if !sameInt64Pointer(result.SharedWorkerQueueDepth, worker.QueueDepth) || !sameInt64Pointer(result.SharedWorkerRunningJobs, worker.RunningJobs) || !sameInt64Pointer(result.SharedWorkerCapacity, worker.WorkerCapacity) {
				result.SharedWorkerLoadState = ObservationDegraded
				result.SharedWorkerLoadReason = "ready Worker observations disagree"
			}
			continue
		}
		result.SharedWorkerLoadState = ObservationMeasured
		result.SharedWorkerLoadReason = ""
		result.SharedWorkerQueueDepth = cloneInt64Pointer(worker.QueueDepth)
		result.SharedWorkerRunningJobs = cloneInt64Pointer(worker.RunningJobs)
		result.SharedWorkerCapacity = cloneInt64Pointer(worker.WorkerCapacity)
		if worker.RunningJobs != nil && worker.WorkerCapacity != nil && *worker.WorkerCapacity > 0 {
			utilization := float64(*worker.RunningJobs) / float64(*worker.WorkerCapacity)
			result.SharedWorkerUtilization = &utilization
		}
	}
	if result.SharedWorkerLoadState == ObservationUnavailable && workerEndpointResponded {
		result.SharedWorkerLoadState = ObservationDegraded
		result.SharedWorkerLoadReason = "no ready Worker generation supplied a load sample"
	}

	allServersMeasured := len(result.Slots) > 0
	measuredServers := 0
	for index := range result.Slots {
		if result.Slots[index].Server.State == ObservationMeasured {
			measuredServers++
		} else {
			allServersMeasured = false
		}
	}
	if measuredServers == 0 {
		if e.lastObservation != nil {
			stale := cloneObservation(*e.lastObservation)
			stale.State = ObservationStale
			stale.Reason = "runtime observation endpoints are unavailable; showing the last successful sample"
			return stale, nil
		}
		return unavailableObservation(status, "runtime observation endpoints are unavailable"), nil
	}
	e.observationSample = sample
	if !allServersMeasured {
		result.State = ObservationDegraded
		result.Reason = "one or more slot observation endpoints are unavailable"
	} else if len(counterResets) > 0 {
		result.State = ObservationDegraded
		result.Reason = "one or more runtime counters reset; traffic rates are partial until the next sample"
	} else if previous == nil || window <= 0 {
		result.State = ObservationWarmingUp
		result.Reason = "waiting for a second counter sample before calculating traffic share"
	}
	if result.SharedWorkerLoadState != ObservationMeasured && result.State == ObservationMeasured {
		result.State = ObservationDegraded
		result.Reason = appendObservationReason(result.Reason, result.SharedWorkerLoadReason)
	} else if result.SharedWorkerLoadState != ObservationMeasured {
		result.Reason = appendObservationReason(result.Reason, result.SharedWorkerLoadReason)
	}
	if previous != nil && window > 0 && len(validDeltas) > 0 {
		var totalRequests, totalErrors uint64
		for _, delta := range validDeltas {
			totalRequests += delta.total
			totalErrors += delta.error
		}
		result.SampleWindowSeconds = window
		if totalRequests > 0 {
			rate := float64(totalRequests) / window
			errorRate := float64(totalErrors) / float64(totalRequests)
			result.TotalRequestRate = &rate
			result.TotalErrorRate = &errorRate
		}
		for index, slot := range result.Slots {
			delta, ok := validDeltas[slot.Slot]
			if !ok {
				continue
			}
			if totalRequests > 0 {
				share := float64(delta.total) / float64(totalRequests)
				result.Slots[index].Traffic.Share = &share
			}
			rate := float64(delta.total) / window
			errorRate := 0.0
			if delta.total > 0 {
				errorRate = float64(delta.error) / float64(delta.total)
			}
			result.Slots[index].Traffic.State = ObservationMeasured
			result.Slots[index].Traffic.RequestRate = &rate
			result.Slots[index].Traffic.ErrorRate = &errorRate
		}
	}

	if route, err := e.fetchRouteIdentity(ctx); err == nil {
		result.ObservedActiveCandidateSHA = route.CandidateSourceSHA
		for _, slot := range result.Slots {
			if slot.Server.CandidateSourceSHA == route.CandidateSourceSHA && slot.Server.ArtifactDigest == route.ArtifactDigest {
				result.ObservedActiveSlot = slot.Slot
				break
			}
		}
	} else {
		result.State = ObservationDegraded
		result.Reason = appendObservationReason(result.Reason, "public route identity is unavailable")
	}
	switch {
	case result.ObservedActiveSlot == "":
		result.MigrationState = "unknown"
		result.State = ObservationDegraded
		result.Reason = appendObservationReason(result.Reason, "public route identity does not match an observed slot")
	case result.ObservedActiveSlot != result.DesiredActiveSlot:
		result.MigrationState = "route_mismatch"
		result.State = ObservationDegraded
		result.Reason = appendObservationReason(result.Reason, "public route identity does not match the desired slot")
	default:
		result.MigrationState = "stable"
		for _, slot := range result.Slots {
			if slot.Slot != result.DesiredActiveSlot && (slot.DesiredState == "draining" || slot.Load.HTTPActiveRequests > 0) {
				result.MigrationState = "draining"
				break
			}
		}
	}
	last := cloneObservation(result)
	e.lastObservation = &last
	return result, nil
}

func (e *CommandExecutor) fetchComponent(ctx context.Context, baseURL string) (ComponentObservation, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		return ComponentObservation{}, errors.New("observation endpoint is not configured")
	}
	var observation ComponentObservation
	err := e.requestStatus(ctx, http.MethodGet, baseURL+"/-/observe", nil, func(status int, body []byte) error {
		if status != http.StatusOK {
			return errors.New("observation endpoint returned a non-success status")
		}
		return json.Unmarshal(body, &observation)
	})
	if err != nil {
		return ComponentObservation{}, err
	}
	if observation.State == "" {
		observation.State = ObservationMeasured
	}
	return observation, nil
}

func (e *CommandExecutor) fetchRouteIdentity(ctx context.Context) (routeIdentity, error) {
	if strings.TrimSpace(e.PublicURL) == "" {
		return routeIdentity{}, errors.New("public observation route is not configured")
	}
	var identity routeIdentity
	err := e.requestStatus(ctx, http.MethodGet, strings.TrimRight(e.PublicURL, "/")+"/version", nil, func(status int, body []byte) error {
		if status != http.StatusOK {
			return errors.New("public version route returned a non-success status")
		}
		if err := json.Unmarshal(body, &identity); err != nil {
			return err
		}
		if strings.TrimSpace(identity.CandidateSourceSHA) == "" || strings.TrimSpace(identity.ArtifactDigest) == "" {
			return errors.New("public version route omitted candidate identity")
		}
		return nil
	})
	return identity, err
}

func workerObservationMatches(slot Slot, observation ComponentObservation) bool {
	if observation.State != ObservationMeasured || observation.LoadState != ObservationMeasured || !observation.Ready {
		return false
	}
	if slot.WorkerGeneration == nil || observation.WorkerGeneration == nil {
		return slot.WorkerGeneration == nil && observation.WorkerGeneration == nil
	}
	return *slot.WorkerGeneration == *observation.WorkerGeneration
}

func appendObservationReason(current, next string) string {
	current = strings.TrimSpace(current)
	next = strings.TrimSpace(next)
	if next == "" || strings.Contains(current, next) {
		return current
	}
	if current == "" {
		return next
	}
	return current + "; " + next
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func sameInt64Pointer(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func unavailableComponent(reason string) ComponentObservation {
	return ComponentObservation{State: ObservationUnavailable, LoadState: ObservationUnavailable, Reason: reason, LoadReason: reason}
}

func cloneObservation(value Observation) Observation {
	value.Slots = append([]SlotObservation(nil), value.Slots...)
	return value
}
