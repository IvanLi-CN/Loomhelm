package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

type applicationTestRuntime struct {
	fakeRuntime
	handler http.Handler
}

func (r *applicationTestRuntime) APIHandler() http.Handler { return r.handler }

func TestApplicationMountAndDrainReleaseResourceLock(t *testing.T) {
	s, err := newTestServer(platform.Config{Component: platform.ComponentServer, Version: "test", HTTPAddr: "127.0.0.1:0", DrainToken: "token", ShutdownTimeout: time.Second}, nil)
	if err != nil {
		t.Fatal(err)
	}
	unavailable := httptest.NewRecorder()
	s.Router().ServeHTTP(unavailable, httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil))
	if unavailable.Code != http.StatusServiceUnavailable || unavailable.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unstarted application response = %d", unavailable.Code)
	}
	if err := s.lifecycle.Start(); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan string, 1), make(chan struct{})
	s.resources = &applicationTestRuntime{handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		entered <- request.URL.Path
		<-release
		writer.WriteHeader(http.StatusNoContent)
	})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Router().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	}()
	select {
	case path := <-entered:
		if path != "/api/v1/projects" {
			t.Errorf("mount changed URL path to %q", path)
		}
	case <-time.After(time.Second):
		t.Fatal("application request never entered")
	}
	unlocked := make(chan struct{})
	go func() {
		s.resourceMu.Lock()
		s.resourceMu.Unlock()
		close(unlocked)
	}()
	select {
	case <-unlocked:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("application held resource mutex across a live request")
	}
	s.BeginDrain("test")
	draining := httptest.NewRecorder()
	s.Router().ServeHTTP(draining, httptest.NewRequest(http.MethodPost, "/api/v1/projects", nil))
	if draining.Code != http.StatusServiceUnavailable {
		t.Errorf("new mutation during drain = %d", draining.Code)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("admitted application request did not finish")
	}
}
