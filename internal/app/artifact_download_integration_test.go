package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestServerAuthorizedArtifactDownloadStreamsOriginalBytesAndHidesPrivateArtifacts(t *testing.T) {
	databaseURL := isolatedApplicationDatabase(t)
	issuer := applicationTestIssuer(t)
	artifactRoot := t.TempDir()
	artifactID := "artifact-app-download"
	content := []byte("the original conversation file bytes")
	digest := sha256.Sum256(content)
	objects := filepath.Join(artifactRoot, "objects")
	if err := os.MkdirAll(objects, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(objects, artifactID), content, 0o600); err != nil {
		t.Fatal(err)
	}
	projectArtifactID := "artifact-project-download"
	projectContent := []byte("project member artifact bytes")
	projectDigest := sha256.Sum256(projectContent)
	if err := os.WriteFile(filepath.Join(objects, projectArtifactID), projectContent, 0o600); err != nil {
		t.Fatal(err)
	}
	runMismatchContent := []byte("run association must be authorized")
	runMismatchDigest := sha256.Sum256(runMismatchContent)
	if err := os.WriteFile(filepath.Join(objects, "artifact-run-mismatch"), runMismatchContent, 0o600); err != nil {
		t.Fatal(err)
	}
	unconfirmedContent := []byte("unconfirmed session must be hidden")
	unconfirmedDigest := sha256.Sum256(unconfirmedContent)
	if err := os.WriteFile(filepath.Join(objects, "artifact-unconfirmed"), unconfirmedContent, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := platform.Config{
		Component: platform.ComponentServer, Version: "integration", DrainToken: "test-drain",
		ShutdownTimeout: 5 * time.Second, StartupTimeout: 30 * time.Second,
		DatabaseURL: databaseURL, DatabaseMaxConns: 4, ArtifactRoot: artifactRoot,
		BrowserAuth: platform.BrowserAuthConfig{OIDCIssuerURL: issuer.URL, OIDCClientID: "loomhelm-test", SecureCookies: false},
	}
	baseURL, stop := startApplicationTestServer(t, cfg)
	defer stop()
	alice := applicationBrowser(t)
	bob := applicationBrowser(t)
	loginApplicationBrowser(t, alice, baseURL, "artifact-alice")
	loginApplicationBrowser(t, bob, baseURL, "artifact-bob")

	var aliceSession struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &aliceSession)
	if aliceSession.UserID == "" {
		t.Fatal("Alice session omitted user identity")
	}
	var bobIdentity struct {
		UserID string `json:"user_id"`
	}
	decodeApplicationResponse(t, applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/auth/session", nil, nil, http.StatusOK), &bobIdentity)
	if bobIdentity.UserID == "" {
		t.Fatal("Bob session omitted user identity")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MaxConns: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO host_registrations (id, name) VALUES ('host-artifact-download', 'artifact download fixture')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (
			id, external_thread_ref, path, state, generation, creator_user_id, host_id, creation_state
		) VALUES ('session-artifact-download', 'thread-artifact-download', 'new', 'active', 'generation-1', $1, 'host-artifact-download', 'confirmed')
	`, aliceSession.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO projects (id, name, created_by) VALUES ('project-artifact-download', 'Artifact download project', $1)
	`, aliceSession.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO project_members (project_id, user_id, role) VALUES ('project-artifact-download', $1, 'viewer')
	`, bobIdentity.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (
			id, external_thread_ref, path, state, project_id, generation, creator_user_id, host_id, creation_state
		) VALUES ('session-artifact-project', 'thread-artifact-project', 'new', 'active', 'project-artifact-download', 'generation-1', $1, 'host-artifact-download', 'confirmed')
	`, aliceSession.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (
			id, external_thread_ref, path, state, generation, creator_user_id, host_id, creation_state
		) VALUES ('session-artifact-other', 'thread-artifact-other', 'new', 'active', 'generation-1', $1, 'host-artifact-download', 'confirmed')
	`, aliceSession.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_runs (id, session_id, command_id, generation, status)
		VALUES ('run-artifact-other', 'session-artifact-other', 'command-artifact-other', 'generation-1', 'completed')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO execution_sessions (
			id, external_thread_ref, path, state, generation, creator_user_id, host_id,
			creation_state, creation_command_id, creation_payload, creation_digest
		) VALUES (
			'session-artifact-unconfirmed', NULL, 'new', 'starting', NULL, $1, 'host-artifact-download',
			'pending', 'command-artifact-unconfirmed', decode('00', 'hex'), repeat('0', 64)
		)
	`, aliceSession.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_reclaim_after, staging_reclaimed_at, unavailable_reason
		) VALUES (
			'artifact-app-download', 'session-artifact-download', 'original.txt', 'file', $1, $2, 'text/plain', NOW(),
			'ready', '.upload-artifact-fixture', NOW(), NOW(), ''
		)
	`, int64(len(content)), hex.EncodeToString(digest[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_reclaim_after, staging_reclaimed_at, unavailable_reason
		) VALUES (
			'artifact-project-download', 'session-artifact-project', 'project.txt', 'file', $1, $2, 'text/plain', NOW(),
			'ready', '.upload-artifact-project', NOW(), NOW(), ''
		)
	`, int64(len(projectContent)), hex.EncodeToString(projectDigest[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, run_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_reclaim_after, staging_reclaimed_at, unavailable_reason
		) VALUES (
			'artifact-run-mismatch', 'session-artifact-download', 'run-artifact-other', 'mismatch.txt', 'file', $1, $2, 'text/plain', NOW(),
			'ready', '.upload-artifact-mismatch', NOW(), NOW(), ''
		)
	`, int64(len(runMismatchContent)), hex.EncodeToString(runMismatchDigest[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `
		INSERT INTO conversation_artifacts (
			id, session_id, name, kind, size, sha256, content_type, created_at,
			state, staging_name, staging_reclaim_after, staging_reclaimed_at, unavailable_reason
		) VALUES (
			'artifact-unconfirmed', 'session-artifact-unconfirmed', 'unconfirmed.txt', 'file', $1, $2, 'text/plain', NOW(),
			'ready', '.upload-artifact-unconfirmed', NOW(), NOW(), ''
		)
	`, int64(len(unconfirmedContent)), hex.EncodeToString(unconfirmedDigest[:])); err != nil {
		t.Fatal(err)
	}

	response := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, nil, http.StatusOK)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != string(content) {
		t.Fatalf("download body = %q, want %q", body, content)
	}
	if response.Header.Get("Content-Disposition") != `attachment; filename="original.txt"; filename*=UTF-8''original.txt` {
		t.Fatalf("content disposition = %q", response.Header.Get("Content-Disposition"))
	}

	projectResponse := applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/artifacts/"+projectArtifactID+"/download", nil, nil, http.StatusOK)
	projectBody, err := io.ReadAll(projectResponse.Body)
	projectResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(projectBody) != string(projectContent) {
		t.Fatalf("project download body = %q, want %q", projectBody, projectContent)
	}

	applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, nil, http.StatusNotFound)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/artifact-run-mismatch/download", nil, nil, http.StatusNotFound)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/artifact-unconfirmed/download", nil, nil, http.StatusNotFound)
	applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, nil, http.StatusUnauthorized)
}

func TestWriteArtifactDownloadErrorUsesServiceUnavailableCode(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/artifacts/artifact/download", nil)
	writeArtifactDownloadError(response, request, http.StatusServiceUnavailable, artifacts.ErrStoreUnavailable, "artifact download is unavailable")

	var failure protocol.ApiError
	if err := json.NewDecoder(response.Body).Decode(&failure); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusServiceUnavailable || failure.Code != protocol.ErrorCodeServiceUnavailable {
		t.Fatalf("service unavailable error = status %d/code %q", response.Code, failure.Code)
	}
}
