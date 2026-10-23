package jobs

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

func TestConfigDefaults(t *testing.T) {
	config := (Config{}).withDefaults()
	if config.Queue != "default" {
		t.Fatalf("default queue = %q, want default", config.Queue)
	}
	if config.MaxWorkers != 1 {
		t.Fatalf("default worker count = %d, want 1", config.MaxWorkers)
	}
	if config.SoftStopTimeout != 10*time.Second {
		t.Fatalf("default soft stop timeout = %s, want 10s", config.SoftStopTimeout)
	}
}

func TestConfigValidate(t *testing.T) {
	if err := (Config{MaxWorkers: -1}).Validate(); err == nil {
		t.Fatal("Config.Validate() accepted negative worker count")
	}
	if err := (Config{SoftStopTimeout: -1}).Validate(); err == nil {
		t.Fatal("Config.Validate() accepted negative soft stop timeout")
	}
	if err := (Config{}).Validate(); err != nil {
		t.Fatalf("Config.Validate() error = %v, want nil for defaultable values", err)
	}
}

func TestShortJobArgsKind(t *testing.T) {
	if got := (ShortJobArgs{}).Kind(); got != ShortJobKind {
		t.Fatalf("ShortJobArgs.Kind() = %q, want %q", got, ShortJobKind)
	}
}

func TestGenerationValidationUsesSignedDatabaseRange(t *testing.T) {
	for _, test := range []struct {
		generation uint64
		valid      bool
	}{
		{generation: 0, valid: false},
		{generation: 1, valid: true},
		{generation: uint64(math.MaxInt64), valid: true},
		{generation: uint64(math.MaxInt64) + 1, valid: false},
		{generation: math.MaxUint64, valid: false},
	} {
		t.Run(strings.ReplaceAll(formatGeneration(test.generation), " ", "_"), func(t *testing.T) {
			if err := validateGeneration(test.generation); (err == nil) != test.valid {
				t.Fatalf("validateGeneration(%d) error = %v, valid = %t", test.generation, err, test.valid)
			}
		})
	}
}

func TestShortJobWorkerCancelsOutOfRangeGeneration(t *testing.T) {
	worker := &shortJobWorker{generation: staticGeneration{ctx: context.Background()}}
	err := worker.Work(context.Background(), &river.Job[ShortJobArgs]{
		JobRow: &rivertype.JobRow{ID: 1},
		Args:   ShortJobArgs{Generation: uint64(math.MaxInt64) + 1},
	})
	var cancelErr *river.JobCancelError
	if !errors.As(err, &cancelErr) {
		t.Fatalf("Work() error = %v, want river.JobCancelError", err)
	}
	if !strings.Contains(err.Error(), "must not exceed") {
		t.Fatalf("Work() error = %v, want signed-range detail", err)
	}
}

func TestShortJobWorkerReturnsCallerCancellationForRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	worker := &shortJobWorker{generation: staticGeneration{ctx: context.Background()}}
	err := worker.Work(ctx, &river.Job[ShortJobArgs]{
		JobRow: &rivertype.JobRow{ID: 1},
		Args:   ShortJobArgs{Generation: 1},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Work() error = %v, want context.Canceled", err)
	}
	var cancelErr *river.JobCancelError
	if errors.As(err, &cancelErr) {
		t.Fatalf("Work() error = %v, caller cancellation must remain retryable", err)
	}
}

type staticGeneration struct {
	ctx context.Context
}

func (g staticGeneration) Current() uint64 { return 1 }

func (g staticGeneration) ContextFor(uint64) (context.Context, bool) { return g.ctx, true }

func formatGeneration(generation uint64) string {
	if generation == math.MaxUint64 {
		return "max_uint64"
	}
	return "generation_" + strconv.FormatUint(generation, 10)
}
