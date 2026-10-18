package jobs

import (
	"testing"
	"time"
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
