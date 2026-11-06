package deployment

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestCommandExecutorObservesTrafficShareRouteAndLoad(t *testing.T) {
	type counters struct {
		total      atomic.Uint64
		errors     atomic.Uint64
		active     atomic.Int64
		queue      atomic.Int64
		running    atomic.Int64
		generation int64
	}
	newComponent := func(source, artifact string, values *counters) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/-/observe" {
				http.NotFound(writer, request)
				return
			}
			writeJSON := ComponentObservation{
				State:              ObservationMeasured,
				LoadState:          ObservationMeasured,
				ObservedAt:         time.Now().UTC(),
				Live:               true,
				Ready:              true,
				CandidateSourceSHA: source,
				ArtifactDigest:     artifact,
				RequestsTotal:      values.total.Load(),
				Responses4xx:       values.errors.Load(),
				ActiveRequests:     values.active.Load(),
				QueueDepth:         int64Value(values.queue.Load()),
				RunningJobs:        int64Value(values.running.Load()),
				WorkerCapacity:     int64Value(4),
			}
			if values.generation > 0 {
				writeJSON.WorkerGeneration = int64Value(values.generation)
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(writeJSON)
		}))
	}

	blueValues := &counters{}
	greenValues := &counters{}
	blueWorkerValues := &counters{generation: 99}
	greenWorkerValues := &counters{generation: 8}
	blueSource, greenSource := "blue-source", "green-source"
	blueArtifact, greenArtifact := "blue-artifact", "green-artifact"
	blue := newComponent(blueSource, blueArtifact, blueValues)
	green := newComponent(greenSource, greenArtifact, greenValues)
	blueWorker := newComponent(blueSource, blueArtifact, blueWorkerValues)
	greenWorker := newComponent(greenSource, greenArtifact, greenWorkerValues)
	defer blue.Close()
	defer green.Close()
	defer blueWorker.Close()
	defer greenWorker.Close()
	public := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/version" {
			http.NotFound(writer, request)
			return
		}
		_ = json.NewEncoder(writer).Encode(routeIdentity{CandidateSourceSHA: greenSource, ArtifactDigest: greenArtifact})
	}))
	defer public.Close()

	blueValues.total.Store(100)
	blueValues.active.Store(2)
	blueValues.queue.Store(3)
	blueValues.running.Store(1)
	greenValues.total.Store(50)
	greenValues.active.Store(4)
	blueWorkerValues.queue.Store(3)
	blueWorkerValues.running.Store(1)
	greenWorkerValues.queue.Store(3)
	greenWorkerValues.running.Store(4)

	executor := &CommandExecutor{
		SlotURLs:   map[string]string{"blue": blue.URL, "green": green.URL},
		WorkerURLs: map[string]string{"blue": blueWorker.URL, "green": greenWorker.URL},
		PublicURL:  public.URL,
		HTTPClient: &http.Client{Timeout: time.Second},
	}
	blueGeneration := int64(7)
	greenGeneration := int64(8)
	status := Status{
		ActiveSlot: "green",
		Slots: []Slot{
			{Name: "blue", State: "retained", CandidateID: "blue-candidate", WorkerGeneration: &blueGeneration},
			{Name: "green", State: "active", CandidateID: "green-candidate", WorkerGeneration: &greenGeneration},
		},
	}

	warming, err := executor.Observe(context.Background(), status)
	if err != nil {
		t.Fatalf("first Observe() error = %v", err)
	}
	if warming.State != ObservationWarmingUp || warming.Slots[1].Traffic.Share != nil {
		t.Fatalf("first observation = %+v, want warming_up without traffic share", warming)
	}

	blueValues.total.Add(70)
	greenValues.total.Add(30)
	greenValues.errors.Add(1)
	measured, err := executor.Observe(context.Background(), status)
	if err != nil {
		t.Fatalf("second Observe() error = %v", err)
	}
	if measured.State != ObservationMeasured || measured.MigrationState != "draining" || measured.ObservedActiveSlot != "green" {
		t.Fatalf("second observation = %+v, want measured green route with blue draining", measured)
	}
	blueTraffic := measured.Slots[0].Traffic
	greenTraffic := measured.Slots[1].Traffic
	if blueTraffic.Share == nil || greenTraffic.Share == nil || *blueTraffic.Share < 0.69 || *blueTraffic.Share > 0.71 || *greenTraffic.Share < 0.29 || *greenTraffic.Share > 0.31 {
		t.Fatalf("traffic shares = blue %v, green %v, want approximately 70/30", blueTraffic.Share, greenTraffic.Share)
	}
	if measured.TotalRequestRate == nil || measured.TotalErrorRate == nil || *measured.TotalErrorRate <= 0 {
		t.Fatalf("aggregate rates = request %v error %v, want measured rates", measured.TotalRequestRate, measured.TotalErrorRate)
	}
	if measured.SharedWorkerQueueDepth == nil || *measured.SharedWorkerQueueDepth != 3 || measured.SharedWorkerRunningJobs == nil || *measured.SharedWorkerRunningJobs != 4 || measured.Slots[1].Load.WorkerUtilization == nil || *measured.Slots[1].Load.WorkerUtilization != 1 {
		t.Fatalf("shared worker load = queue %v running %v, green load = %+v, want shared queue 3/running 4 and green utilization 1", measured.SharedWorkerQueueDepth, measured.SharedWorkerRunningJobs, measured.Slots[1].Load)
	}
}

func TestCommandExecutorDoesNotDegradeForUnavailableDrainingSlot(t *testing.T) {
	activeSource, activeArtifact := "active-source", "active-artifact"
	active := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/-/observe" {
			http.NotFound(writer, request)
			return
		}
		_ = json.NewEncoder(writer).Encode(ComponentObservation{
			State:              ObservationMeasured,
			LoadState:          ObservationMeasured,
			ObservedAt:         time.Now().UTC(),
			Live:               true,
			Ready:              true,
			CandidateSourceSHA: activeSource,
			ArtifactDigest:     activeArtifact,
			WorkerGeneration:   int64Value(7),
			WorkerCapacity:     int64Value(1),
		})
	}))
	defer active.Close()
	retired := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.NotFound(writer, request)
	}))
	retired.Close()
	public := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/version" {
			http.NotFound(writer, request)
			return
		}
		_ = json.NewEncoder(writer).Encode(routeIdentity{CandidateSourceSHA: activeSource, ArtifactDigest: activeArtifact})
	}))
	defer public.Close()

	executor := &CommandExecutor{
		SlotURLs:   map[string]string{"blue": active.URL, "green": retired.URL},
		WorkerURLs: map[string]string{"blue": active.URL, "green": retired.URL},
		PublicURL:  public.URL,
		HTTPClient: &http.Client{Timeout: time.Second},
	}
	generation := int64(7)
	status := Status{
		ActiveSlot: "blue",
		Slots: []Slot{
			{Name: "blue", State: "active", CandidateID: "active-candidate", WorkerGeneration: &generation},
			{Name: "green", State: "draining", CandidateID: "retired-candidate"},
		},
	}

	if _, err := executor.Observe(context.Background(), status); err != nil {
		t.Fatalf("first Observe() error = %v", err)
	}
	measured, err := executor.Observe(context.Background(), status)
	if err != nil {
		t.Fatalf("second Observe() error = %v", err)
	}
	if measured.State != ObservationMeasured || measured.MigrationState != "draining" {
		t.Fatalf("observation = %+v, want measured draining state", measured)
	}
}

func TestCommandExecutorReturnsStaleThenUnavailableObservation(t *testing.T) {
	component := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/-/observe" {
			_ = json.NewEncoder(writer).Encode(ComponentObservation{State: ObservationMeasured, LoadState: ObservationMeasured, ObservedAt: time.Now().UTC(), Live: true, Ready: true, RequestsTotal: 1})
			return
		}
		http.NotFound(writer, request)
	}))
	executor := &CommandExecutor{
		SlotURLs:   map[string]string{"blue": component.URL},
		WorkerURLs: map[string]string{"blue": component.URL},
		HTTPClient: &http.Client{Timeout: time.Second},
	}
	status := Status{ActiveSlot: "blue", Slots: []Slot{{Name: "blue", State: "active"}}}
	first, err := executor.Observe(context.Background(), status)
	if err != nil {
		t.Fatalf("initial Observe() error = %v", err)
	}
	if first.State != ObservationDegraded || first.MigrationState != ObservationUnknown {
		t.Fatalf("initial observation = %+v, want degraded unknown route identity", first)
	}
	component.Close()

	stale, err := executor.Observe(context.Background(), status)
	if err != nil {
		t.Fatalf("stale Observe() error = %v", err)
	}
	if stale.State != ObservationStale || stale.Slots[0].Traffic.RequestsTotal != 1 {
		t.Fatalf("stale observation = %+v, want retained last sample", stale)
	}

	unavailable, err := (&CommandExecutor{}).Observe(context.Background(), status)
	if err != nil {
		t.Fatalf("unavailable Observe() error = %v", err)
	}
	if unavailable.State != ObservationUnavailable || unavailable.Slots[0].Server.State != ObservationUnavailable {
		t.Fatalf("unavailable observation = %+v, want explicit unavailable state", unavailable)
	}
}

func int64Value(value int64) *int64 {
	return &value
}
