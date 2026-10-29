// Package runs owns the execution state machine and the pure boundaries that
// protect it from stale commands, workers, and connector generations.
package runs

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
)

var (
	ErrInvalidGeneration = errors.New("generation is invalid")
	ErrStaleGeneration   = errors.New("generation is stale")
	ErrGenerationStopped = errors.New("generation fence is stopped")
	ErrLeaseHeld         = errors.New("lease is held by a newer generation")
	ErrLeaseLost         = errors.New("lease is no longer held")
	ErrLeaseStopped      = errors.New("lease gate is stopped")
	ErrLeaseKeyMismatch  = errors.New("lease key does not belong to this gate")
)

// Generation is deliberately bounded by the signed database range used by
// platform worker leases. Zero is reserved for an absent generation.
type Generation uint64

const MaxGeneration Generation = Generation(math.MaxInt64)

func ValidateGeneration(generation Generation) error {
	if generation == 0 {
		return fmt.Errorf("%w: generation must be greater than zero", ErrInvalidGeneration)
	}
	if generation > MaxGeneration {
		return fmt.Errorf("%w: generation must not exceed %d", ErrInvalidGeneration, MaxGeneration)
	}
	return nil
}

// GenerationFence is the process-local decision boundary for generation
// ownership. It does not replace the durable database lease. A durable
// adapter must persist the same monotonic and exact-generation checks.
type GenerationFence struct {
	mu      sync.RWMutex
	current Generation
	stopped bool
}

func NewGenerationFence(initial Generation) (*GenerationFence, error) {
	if err := ValidateGeneration(initial); err != nil {
		return nil, err
	}
	return &GenerationFence{current: initial}, nil
}

func (f *GenerationFence) Current() (Generation, bool) {
	if f == nil {
		return 0, false
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.current, !f.stopped
}

func (f *GenerationFence) IsCurrent(generation Generation) bool {
	if f == nil {
		return false
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	return !f.stopped && generation == f.current
}

func (f *GenerationFence) Advance(next Generation) error {
	if err := ValidateGeneration(next); err != nil {
		return err
	}
	if f == nil {
		return errors.New("generation fence is nil")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopped {
		return ErrGenerationStopped
	}
	if next <= f.current {
		return fmt.Errorf("%w: %d is not newer than current generation %d", ErrStaleGeneration, next, f.current)
	}
	f.current = next
	return nil
}

func (f *GenerationFence) Check(generation Generation) error {
	if err := ValidateGeneration(generation); err != nil {
		return err
	}
	if f == nil {
		return errors.New("generation fence is nil")
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.stopped {
		return ErrGenerationStopped
	}
	if generation != f.current {
		return fmt.Errorf("%w: got %d, current is %d", ErrStaleGeneration, generation, f.current)
	}
	return nil
}

func (f *GenerationFence) Stop() bool {
	if f == nil {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopped {
		return false
	}
	f.stopped = true
	return true
}

// LeaseIdentity is the full identity a durable worker/connector lease must
// fence. Candidate and artifact values are part of the identity even though
// generation is the monotonic ordering key.
type LeaseIdentity struct {
	Key            string
	Generation     Generation
	CandidateSHA   string
	ArtifactDigest string
}

func (identity LeaseIdentity) Validate() error {
	if strings.TrimSpace(identity.Key) == "" {
		return errors.New("lease key must not be empty")
	}
	if strings.ContainsAny(identity.Key, " \t\r\n") {
		return errors.New("lease key must not contain whitespace")
	}
	return ValidateGeneration(identity.Generation)
}

func (identity LeaseIdentity) equal(other LeaseIdentity) bool {
	return identity.Key == other.Key &&
		identity.Generation == other.Generation &&
		identity.CandidateSHA == other.CandidateSHA &&
		identity.ArtifactDigest == other.ArtifactDigest
}

// LeaseGate is a concurrency-safe fencing decision boundary. It intentionally
// keeps the highest observed generation after release so an old worker cannot
// resurrect itself. It is not a persistence implementation.
type LeaseGate struct {
	mu      sync.RWMutex
	key     string
	current *LeaseIdentity
	highest Generation
	stopped bool
}

func NewLeaseGate() *LeaseGate { return &LeaseGate{} }

func (g *LeaseGate) Acquire(identity LeaseIdentity) error {
	if err := identity.Validate(); err != nil {
		return err
	}
	if g == nil {
		return errors.New("lease gate is nil")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopped {
		return ErrLeaseStopped
	}
	if g.key == "" {
		g.key = identity.Key
	} else if g.key != identity.Key {
		return ErrLeaseKeyMismatch
	}
	if identity.Generation <= g.highest {
		return fmt.Errorf("%w: generation %d is not newer than %d", ErrLeaseHeld, identity.Generation, g.highest)
	}
	value := identity
	g.current = &value
	g.highest = identity.Generation
	return nil
}

func (g *LeaseGate) Renew(identity LeaseIdentity) error {
	if err := identity.Validate(); err != nil {
		return err
	}
	if g == nil {
		return errors.New("lease gate is nil")
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.stopped {
		return ErrLeaseStopped
	}
	if g.current == nil || !g.current.equal(identity) {
		return ErrLeaseLost
	}
	return nil
}

func (g *LeaseGate) Check(identity LeaseIdentity) error {
	return g.Renew(identity)
}

func (g *LeaseGate) Release(identity LeaseIdentity) bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.current == nil || !g.current.equal(identity) {
		return false
	}
	g.current = nil
	return true
}

func (g *LeaseGate) Current() (LeaseIdentity, bool) {
	if g == nil {
		return LeaseIdentity{}, false
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.current == nil {
		return LeaseIdentity{}, false
	}
	return *g.current, true
}

func (g *LeaseGate) Stop() bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopped {
		return false
	}
	g.stopped = true
	g.current = nil
	return true
}
