package platform

import (
	"fmt"
	"strings"
	"sync"
)

type State string

const (
	StateNew      State = "new"
	StateRunning  State = "running"
	StateDraining State = "draining"
	StateStopped  State = "stopped"
)

type LifecycleSnapshot struct {
	State       State
	Live        bool
	Ready       bool
	DrainReason string
}

type Lifecycle struct {
	mu          sync.RWMutex
	state       State
	drainReason string
}

func NewLifecycle() *Lifecycle {
	return &Lifecycle{state: StateNew}
}

func (l *Lifecycle) Start() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.state != StateNew {
		return fmt.Errorf("cannot start lifecycle in state %q", l.state)
	}
	l.state = StateRunning
	l.drainReason = ""
	return nil
}

func (l *Lifecycle) BeginDrain(reason string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.state != StateRunning {
		return false
	}
	l.state = StateDraining
	l.drainReason = strings.TrimSpace(reason)
	if l.drainReason == "" {
		l.drainReason = "unspecified"
	}
	return true
}

func (l *Lifecycle) Stop() bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.state == StateStopped {
		return false
	}
	l.state = StateStopped
	return true
}

func (l *Lifecycle) Snapshot() LifecycleSnapshot {
	l.mu.RLock()
	defer l.mu.RUnlock()

	return LifecycleSnapshot{
		State:       l.state,
		Live:        l.state == StateRunning || l.state == StateDraining,
		Ready:       l.state == StateRunning,
		DrainReason: l.drainReason,
	}
}
