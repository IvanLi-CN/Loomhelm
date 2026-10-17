package platform

import (
	"context"
	"fmt"
	"sync"
)

// GenerationController provides process-local cancellation semantics for a worker generation.
// It is intentionally not a durable or cross-process fencing mechanism; RD02 must add that boundary.
type GenerationController struct {
	mu      sync.RWMutex
	parent  context.Context
	current uint64
	ctx     context.Context
	cancel  context.CancelFunc
	stopped bool
}

func NewGenerationController(parent context.Context, initial uint64) (*GenerationController, error) {
	if parent == nil {
		return nil, fmt.Errorf("generation parent context must not be nil")
	}
	if initial == 0 {
		return nil, fmt.Errorf("generation must be greater than zero")
	}
	ctx, cancel := context.WithCancel(parent)
	return &GenerationController{
		parent:  parent,
		current: initial,
		ctx:     ctx,
		cancel:  cancel,
	}, nil
}

func (c *GenerationController) Current() uint64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.current
}

func (c *GenerationController) Context() context.Context {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.ctx
}

func (c *GenerationController) ContextFor(generation uint64) (context.Context, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.stopped || generation != c.current {
		return nil, false
	}
	return c.ctx, true
}

func (c *GenerationController) IsCurrent(generation uint64) bool {
	_, ok := c.ContextFor(generation)
	return ok
}

func (c *GenerationController) Cancel(generation uint64) bool {
	c.mu.RLock()
	if c.stopped || generation != c.current {
		c.mu.RUnlock()
		return false
	}
	cancel := c.cancel
	c.mu.RUnlock()
	cancel()
	return true
}

func (c *GenerationController) CancelCurrent() bool {
	return c.Cancel(c.Current())
}

func (c *GenerationController) Advance(next uint64) error {
	if next == 0 {
		return fmt.Errorf("generation must be greater than zero")
	}

	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return fmt.Errorf("cannot advance a stopped generation controller")
	}
	if next <= c.current {
		current := c.current
		c.mu.Unlock()
		return fmt.Errorf("generation %d must be greater than current generation %d", next, current)
	}
	oldCancel := c.cancel
	oldCancel()
	ctx, cancel := context.WithCancel(c.parent)
	c.current = next
	c.ctx = ctx
	c.cancel = cancel
	c.mu.Unlock()
	return nil
}

func (c *GenerationController) Stop() bool {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return false
	}
	c.stopped = true
	cancel := c.cancel
	cancel()
	c.mu.Unlock()
	return true
}
