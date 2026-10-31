package app

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
)

// This test keeps the production Server and HTTP API intact while injecting a
// single pre-write dependency failure at the external HTTP boundary. It
// verifies API reconciliation before an explicit retry; browser UI behavior
// is covered by separate Web contracts.
func TestServerAPIRelationPartialWriteRefreshesBeforeRetry(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	cfg := platform.Config{
		Component: platform.ComponentServer, Version: "integration", DrainToken: "test-drain",
		ShutdownTimeout: 5 * time.Second, StartupTimeout: 30 * time.Second,
		DatabaseURL: databaseURL, DatabaseMaxConns: 4,
		BrowserAuth: platform.BrowserAuthConfig{OIDCIssuerURL: issuer.URL, OIDCClientID: "loomhelm-test", SecureCookies: false},
	}
	baseURL, fault, stop := startApplicationServerWithRelationFaultProxy(t, cfg)
	defer stop()

	browser := applicationBrowser(t)
	loginApplicationBrowser(t, browser, baseURL, "partial-relation-owner")
	sameOrigin := map[string]string{"Origin": baseURL}

	var project struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	decodeApplicationResponse(t, applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/projects", map[string]string{
		"name": "Partial relation fault project",
	}, sameOrigin, http.StatusCreated), &project)
	if project.Project.ID == "" {
		t.Fatal("project create response omitted identity")
	}

	parentID := createApplicationRelationFaultTask(t, browser, baseURL, project.Project.ID, "Relation parent")
	childID := createApplicationRelationFaultTask(t, browser, baseURL, project.Project.ID, "Relation child")
	parentPath := baseURL + "/api/v1/tasks/" + childID + "/parents/" + parentID
	dependencyPath := baseURL + "/api/v1/tasks/" + childID + "/dependencies/" + parentID

	type relationWriteResult struct {
		path   string
		status int
		body   []byte
		err    error
	}
	results := make(chan relationWriteResult, 2)
	var writes sync.WaitGroup
	for _, path := range []string{parentPath, dependencyPath} {
		path := path
		writes.Add(1)
		go func() {
			defer writes.Done()
			request, err := http.NewRequest(http.MethodPost, path, nil)
			if err != nil {
				results <- relationWriteResult{path: path, err: err}
				return
			}
			request.Header.Set("Origin", baseURL)
			response, err := browser.Do(request)
			if err != nil {
				results <- relationWriteResult{path: path, err: err}
				return
			}
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			results <- relationWriteResult{path: path, status: response.StatusCode, body: body, err: readErr}
		}()
	}
	writes.Wait()
	close(results)

	var parentWrite, dependencyWrite relationWriteResult
	for result := range results {
		if result.path == parentPath {
			parentWrite = result
		} else if result.path == dependencyPath {
			dependencyWrite = result
		}
	}
	if parentWrite.err != nil {
		t.Fatalf("parent relation write failed: %v", parentWrite.err)
	}
	if parentWrite.status != http.StatusNoContent {
		t.Fatalf("parent relation status = %d, body = %s; want %d", parentWrite.status, parentWrite.body, http.StatusNoContent)
	}
	if dependencyWrite.err != nil {
		t.Fatalf("dependency relation request failed before receiving the injected response: %v", dependencyWrite.err)
	}
	if dependencyWrite.status != http.StatusServiceUnavailable {
		t.Fatalf("dependency relation status = %d, body = %s; want %d", dependencyWrite.status, dependencyWrite.body, http.StatusServiceUnavailable)
	}
	var injectedFailure struct {
		Code      string `json:"code"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(dependencyWrite.body, &injectedFailure); err != nil {
		t.Fatalf("decode injected dependency failure: %v; body=%s", err, dependencyWrite.body)
	}
	if injectedFailure.Code != "unavailable" || injectedFailure.RequestID == "" {
		t.Fatalf("injected failure envelope = %+v", injectedFailure)
	}
	if got := fault.DependencyFailures(); got != 1 {
		t.Fatalf("injected dependency failures = %d, want 1", got)
	}

	var afterPartialWrite struct {
		Parents []struct {
			ParentTaskID string `json:"parent_task_id"`
		} `json:"parents"`
		Prerequisites []struct {
			PrerequisiteTaskID string `json:"prerequisite_task_id"`
		} `json:"prerequisites"`
	}
	decodeApplicationResponse(t, applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/tasks/"+childID+"/relationships", nil, nil, http.StatusOK), &afterPartialWrite)
	if len(afterPartialWrite.Parents) != 1 || afterPartialWrite.Parents[0].ParentTaskID != parentID {
		t.Fatalf("refreshed parent relationships = %+v", afterPartialWrite.Parents)
	}
	if len(afterPartialWrite.Prerequisites) != 0 {
		t.Fatalf("failed dependency became persisted before refresh retry: %+v", afterPartialWrite.Prerequisites)
	}

	// The refresh above is the reconciliation barrier: only after it confirms
	// the partial state does the test retry the failed relation explicitly.
	applicationRequest(t, browser, http.MethodPost, dependencyPath, nil, sameOrigin, http.StatusNoContent)
	var afterRetry struct {
		Parents []struct {
			ParentTaskID string `json:"parent_task_id"`
		} `json:"parents"`
		Prerequisites []struct {
			PrerequisiteTaskID string `json:"prerequisite_task_id"`
		} `json:"prerequisites"`
	}
	decodeApplicationResponse(t, applicationRequest(t, browser, http.MethodGet, baseURL+"/api/v1/tasks/"+childID+"/relationships", nil, nil, http.StatusOK), &afterRetry)
	if len(afterRetry.Parents) != 1 || afterRetry.Parents[0].ParentTaskID != parentID || len(afterRetry.Prerequisites) != 1 || afterRetry.Prerequisites[0].PrerequisiteTaskID != parentID {
		t.Fatalf("relationships after refresh-gated retry = %+v", afterRetry)
	}
}

func createApplicationRelationFaultTask(t *testing.T, browser *http.Client, baseURL, projectID, title string) string {
	t.Helper()
	var response struct {
		Task struct {
			ID string `json:"id"`
		} `json:"task"`
	}
	decodeApplicationResponse(t, applicationRequest(t, browser, http.MethodPost, baseURL+"/api/v1/tasks", map[string]string{
		"project_id": projectID,
		"title":      title,
		"goal":       title + " goal",
	}, map[string]string{"Origin": baseURL}, http.StatusCreated), &response)
	if response.Task.ID == "" {
		t.Fatalf("task %q create response omitted identity", title)
	}
	return response.Task.ID
}

type relationFaultProxy struct {
	proxy             *httputil.ReverseProxy
	failDependency    atomic.Bool
	dependencyFailure atomic.Uint64
}

func (p *relationFaultProxy) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodPost && strings.Contains(request.URL.Path, "/dependencies/") && p.failDependency.CompareAndSwap(false, true) {
		p.dependencyFailure.Add(1)
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(writer, `{"code":"unavailable","message":"injected dependency write failure","request_id":"fault-injected"}`)
		return
	}
	p.proxy.ServeHTTP(writer, request)
}

func (p *relationFaultProxy) DependencyFailures() uint64 {
	return p.dependencyFailure.Load()
}

func startApplicationServerWithRelationFaultProxy(t *testing.T, cfg platform.Config) (string, *relationFaultProxy, func()) {
	t.Helper()
	backendListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxyListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		backendListener.Close()
		t.Fatal(err)
	}
	backendURL := "http://" + backendListener.Addr().String()
	baseURL := "http://" + proxyListener.Addr().String()
	cfg.HTTPAddr = backendListener.Addr().String()
	if cfg.BrowserAuth.OIDCEnabled() {
		cfg.BrowserAuth.OIDCRedirectURL = baseURL + "/api/v1/auth/oidc/callback"
	}
	target, err := url.Parse(backendURL)
	if err != nil {
		backendListener.Close()
		proxyListener.Close()
		t.Fatal(err)
	}
	reverseProxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := reverseProxy.Director
	reverseProxy.Director = func(request *http.Request) {
		host := request.Host
		originalDirector(request)
		// Keep the externally visible host so same-origin/CSRF checks observe
		// the browser-facing URL while the transport targets the backend.
		request.Host = host
	}
	fault := &relationFaultProxy{proxy: reverseProxy}
	proxyServer := &http.Server{Handler: fault}
	go func() {
		_ = proxyServer.Serve(proxyListener)
	}()

	server, err := NewServer(cfg, nil)
	if err != nil {
		_ = proxyServer.Close()
		_ = backendListener.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.Serve(ctx, backendListener) }()
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			cancel()
			select {
			case err := <-serverDone:
				if err != nil {
					t.Errorf("stop actual Server behind relation fault proxy: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Error("actual Server behind relation fault proxy did not stop")
			}
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer shutdownCancel()
			if err := proxyServer.Shutdown(shutdownCtx); err != nil {
				t.Errorf("stop relation fault proxy: %v", err)
			}
		})
	}
	t.Cleanup(stop)
	deadline := time.Now().Add(35 * time.Second)
	for !server.Lifecycle().Ready {
		select {
		case err := <-serverDone:
			cancel()
			_ = proxyServer.Close()
			t.Fatalf("start actual Server behind relation fault proxy: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("actual Server behind relation fault proxy readiness deadline exceeded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return baseURL, fault, stop
}
