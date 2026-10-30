package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/artifacts"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
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
	runAuthorizedContent := []byte("run association in the same session is authorized")
	runAuthorizedDigest := sha256.Sum256(runAuthorizedContent)
	if err := os.WriteFile(filepath.Join(objects, "artifact-run-authorized"), runAuthorizedContent, 0o600); err != nil {
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
	var credential struct {
		Credential struct {
			ID    string `json:"id"`
			Token string `json:"token"`
		} `json:"credential"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/credentials", map[string]string{"name": "artifact-download-native"}, map[string]string{"Origin": baseURL}, http.StatusCreated), &credential)
	if credential.Credential.Token == "" {
		t.Fatal("artifact download credential omitted token")
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
		INSERT INTO execution_runs (id, session_id, command_id, generation, status)
		VALUES ('run-artifact-authorized', 'session-artifact-download', 'command-artifact-authorized', 'generation-1', 'completed')
	`); err != nil {
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
			'artifact-run-authorized', 'session-artifact-download', 'run-artifact-authorized', 'run.txt', 'file', $1, $2, 'text/plain', NOW(),
			'ready', '.upload-artifact-run-authorized', NOW(), NOW(), ''
		)
	`, int64(len(runAuthorizedContent)), hex.EncodeToString(runAuthorizedDigest[:])); err != nil {
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

	rangeResponse := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, map[string]string{"Range": "bytes=4-10"}, http.StatusPartialContent)
	rangeBody, err := io.ReadAll(rangeResponse.Body)
	rangeResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(rangeBody) != string(content[4:11]) {
		t.Fatalf("range download body = %q, want %q", rangeBody, content[4:11])
	}
	wantRange := "bytes 4-10/" + strconv.Itoa(len(content))
	if rangeResponse.Header.Get("Content-Range") != wantRange {
		t.Fatalf("range content = %q, want %q", rangeResponse.Header.Get("Content-Range"), wantRange)
	}

	headResponse := applicationRequest(t, alice, http.MethodHead, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, map[string]string{"Range": "bytes=99-100"}, http.StatusOK)
	headBody, err := io.ReadAll(headResponse.Body)
	headResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(headBody) != 0 || headResponse.Header.Get("Content-Length") != strconv.Itoa(len(content)) {
		t.Fatalf("HEAD response body/length = %d/%q, want 0/%d", len(headBody), headResponse.Header.Get("Content-Length"), len(content))
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

	runAuthorizedResponse := applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/artifact-run-authorized/download", nil, nil, http.StatusOK)
	runAuthorizedBody, err := io.ReadAll(runAuthorizedResponse.Body)
	runAuthorizedResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(runAuthorizedBody) != string(runAuthorizedContent) {
		t.Fatalf("run-authorized download body = %q, want %q", runAuthorizedBody, runAuthorizedContent)
	}

	applicationRequest(t, bob, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, nil, http.StatusNotFound)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/artifact-run-mismatch/download", nil, nil, http.StatusNotFound)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/artifact-unconfirmed/download", nil, nil, http.StatusNotFound)
	unauthorizedResponse := applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, nil, http.StatusUnauthorized)
	if unauthorizedResponse.Header.Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("unauthorized artifact download challenge = %q, want Bearer", unauthorizedResponse.Header.Get("WWW-Authenticate"))
	}
	bearer := map[string]string{"Authorization": "Bearer " + credential.Credential.Token}
	applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, bearer, http.StatusUnauthorized)
	applicationRequest(t, alice, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/download", nil, bearer, http.StatusUnauthorized)
	contentResponse := applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/content?limit=4", nil, bearer, http.StatusOK)
	var contentPayload protocol.ArtifactContentResponse
	decodeApplicationResponse(t, contentResponse, &contentPayload)
	decodedContent, err := base64.StdEncoding.DecodeString(contentPayload.ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	if string(decodedContent) != string(content[:4]) || contentPayload.Offset != 0 || contentPayload.NextOffset != 4 || contentPayload.TotalSize != int64(len(content)) || contentPayload.Complete {
		t.Fatalf("API artifact content chunk = %#v, decoded=%q", contentPayload, decodedContent)
	}
	if contentPayload.Artifact.Sha256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("API artifact content hash = %q, want %q", contentPayload.Artifact.Sha256, hex.EncodeToString(digest[:]))
	}
	if contentPayload.ContentVersion == "" {
		t.Fatal("API artifact content omitted its snapshot version")
	}
	contentURL := func(offset int64, version string) string {
		query := url.Values{}
		query.Set("limit", "4")
		query.Set("offset", strconv.FormatInt(offset, 10))
		if version != "" {
			query.Set("content_version", version)
		}
		return baseURL + "/api/v1/artifacts/" + artifactID + "/content?" + query.Encode()
	}
	reassembled := append([]byte(nil), decodedContent...)
	contentVersion := contentPayload.ContentVersion
	for !contentPayload.Complete {
		contentResponse = applicationRequest(t, http.DefaultClient, http.MethodGet, contentURL(contentPayload.NextOffset, contentVersion), nil, bearer, http.StatusOK)
		decodeApplicationResponse(t, contentResponse, &contentPayload)
		if contentPayload.Offset != int64(len(reassembled)) || contentPayload.NextOffset <= contentPayload.Offset || contentPayload.TotalSize != int64(len(content)) || contentPayload.ContentVersion != contentVersion {
			t.Fatalf("API artifact content cursor = %#v", contentPayload)
		}
		nextContent, err := base64.StdEncoding.DecodeString(contentPayload.ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		reassembled = append(reassembled, nextContent...)
	}
	if string(reassembled) != string(content) {
		t.Fatalf("reassembled API artifact content = %q, want %q", reassembled, content)
	}
	reassembledDigest := sha256.Sum256(reassembled)
	if hex.EncodeToString(reassembledDigest[:]) != contentPayload.Artifact.Sha256 {
		t.Fatalf("reassembled API artifact hash = %q, want %q", hex.EncodeToString(reassembledDigest[:]), contentPayload.Artifact.Sha256)
	}
	var revocationCredential struct {
		Credential struct {
			ID    string `json:"id"`
			Token string `json:"token"`
		} `json:"credential"`
	}
	decodeApplicationResponse(t, applicationRequest(t, alice, http.MethodPost, baseURL+"/api/v1/credentials", map[string]string{"name": "artifact-download-revocation"}, map[string]string{"Origin": baseURL}, http.StatusCreated), &revocationCredential)
	if revocationCredential.Credential.ID == "" || revocationCredential.Credential.Token == "" {
		t.Fatal("artifact download revocation credential omitted id or token")
	}
	revocationBearer := map[string]string{"Authorization": "Bearer " + revocationCredential.Credential.Token}
	revocationFirstResponse := applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/content?limit=4", nil, revocationBearer, http.StatusOK)
	var revocationFirst protocol.ArtifactContentResponse
	decodeApplicationResponse(t, revocationFirstResponse, &revocationFirst)
	if revocationFirst.Complete || revocationFirst.NextOffset <= revocationFirst.Offset {
		t.Fatalf("revocation fixture did not produce a resumable first chunk: %#v", revocationFirst)
	}
	applicationRequest(t, alice, http.MethodDelete, baseURL+"/api/v1/credentials/"+revocationCredential.Credential.ID, nil, map[string]string{"Origin": baseURL}, http.StatusNoContent)
	revokedResponse := applicationRequest(t, http.DefaultClient, http.MethodGet, contentURL(revocationFirst.NextOffset, revocationFirst.ContentVersion), nil, revocationBearer, http.StatusUnauthorized)
	revokedBody, err := io.ReadAll(revokedResponse.Body)
	revokedResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(revokedBody), string(content)) || strings.Contains(string(revokedBody), revocationFirst.ContentBase64) {
		t.Fatalf("revoked download response exposed artifact bytes: %q", revokedBody)
	}
	applicationRequest(t, http.DefaultClient, http.MethodGet, baseURL+"/api/v1/artifacts/"+artifactID+"/content?offset=999", nil, bearer, http.StatusBadRequest)
	replacement := append([]byte(nil), content...)
	replacement[8] ^= 0xff
	replaceObject := func(name string, bytes []byte) {
		t.Helper()
		path := filepath.Join(artifactRoot, name)
		if err := os.WriteFile(path, bytes, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(path, filepath.Join(objects, artifactID)); err != nil {
			t.Fatal(err)
		}
	}
	readFirstChunk := func() protocol.ArtifactContentResponse {
		response := applicationRequest(t, http.DefaultClient, http.MethodGet, contentURL(0, ""), nil, bearer, http.StatusOK)
		var payload protocol.ArtifactContentResponse
		decodeApplicationResponse(t, response, &payload)
		return payload
	}
	restoreOriginal := func(name string) {
		replaceObject(name, content)
	}
	tamperedPayload := readFirstChunk()
	replaceObject("artifact-replacement", replacement)
	applicationRequest(t, http.DefaultClient, http.MethodGet, contentURL(tamperedPayload.NextOffset, tamperedPayload.ContentVersion), nil, bearer, http.StatusConflict)
	restoreOriginal("artifact-original-after-replacement")

	interChunkPayload := readFirstChunk()
	replaceObject("artifact-replacement-before-restore", replacement)
	restoreOriginal("artifact-original-after-interchunk-change")
	applicationRequest(t, http.DefaultClient, http.MethodGet, contentURL(interChunkPayload.NextOffset, interChunkPayload.ContentVersion), nil, bearer, http.StatusConflict)

	mcpHTTPClient := &http.Client{Timeout: 20 * time.Second, Transport: &mcpHeaderTransport{
		base:          http.DefaultTransport,
		authorization: bearer["Authorization"],
	}}
	mcpCtx, cancelMCP := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelMCP()
	mcpClient := sdk.NewClient(&sdk.Implementation{Name: "loomhelm-artifact-integration", Version: "test"}, nil)
	mcpSession, err := mcpClient.Connect(mcpCtx, &sdk.StreamableClientTransport{
		Endpoint:             baseURL + "/mcp",
		HTTPClient:           mcpHTTPClient,
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatalf("official SDK MCP Connect() error = %v", err)
	}
	defer mcpSession.Close()
	metadataCall, callErr := mcpSession.CallTool(mcpCtx, &sdk.CallToolParams{
		Name:      "loomhelm.get_artifact",
		Arguments: map[string]any{"artifact_id": artifactID},
	})
	if callErr != nil {
		t.Fatalf("official SDK MCP artifact metadata call error = %v", callErr)
	}
	if metadataCall.IsError {
		t.Fatalf("official SDK MCP artifact metadata call returned an error: %#v", metadataCall)
	}
	metadataJSON, marshalErr := json.Marshal(metadataCall.StructuredContent)
	if marshalErr != nil {
		t.Fatalf("marshal MCP artifact metadata: %v", marshalErr)
	}
	var metadataPayload protocol.ArtifactResponse
	if err := json.Unmarshal(metadataJSON, &metadataPayload); err != nil {
		t.Fatalf("decode MCP artifact metadata: %v", err)
	}
	if metadataPayload.Artifact.ID != artifactID || metadataPayload.Artifact.Name != "original.txt" {
		t.Fatalf("MCP artifact metadata = %#v", metadataPayload)
	}

	var mcpReassembled []byte
	var mcpOffset int64
	var mcpVersion string
	for {
		arguments := map[string]any{
			"artifact_id": artifactID,
			"offset":      mcpOffset,
			"limit":       4,
		}
		if mcpVersion != "" {
			arguments["content_version"] = mcpVersion
		}
		call, callErr := mcpSession.CallTool(mcpCtx, &sdk.CallToolParams{
			Name:      "loomhelm.download_artifact",
			Arguments: arguments,
		})
		if callErr != nil {
			t.Fatalf("official SDK MCP artifact chunk at offset %d: %v", mcpOffset, callErr)
		}
		if call.IsError {
			t.Fatalf("official SDK MCP artifact chunk at offset %d returned an error: %#v", mcpOffset, call)
		}
		structured, marshalErr := json.Marshal(call.StructuredContent)
		if marshalErr != nil {
			t.Fatalf("marshal MCP artifact chunk at offset %d: %v", mcpOffset, marshalErr)
		}
		var payload protocol.ArtifactContentResponse
		if err := json.Unmarshal(structured, &payload); err != nil {
			t.Fatalf("decode MCP artifact chunk at offset %d: %v", mcpOffset, err)
		}
		if payload.Offset != mcpOffset || payload.NextOffset <= payload.Offset || payload.ContentVersion == "" || payload.Artifact.Sha256 != hex.EncodeToString(digest[:]) {
			t.Fatalf("MCP artifact chunk = %#v, want offset %d and canonical hash %q", payload, mcpOffset, hex.EncodeToString(digest[:]))
		}
		if mcpVersion == "" {
			mcpVersion = payload.ContentVersion
		} else if payload.ContentVersion != mcpVersion {
			t.Fatalf("MCP artifact content version changed from %q to %q", mcpVersion, payload.ContentVersion)
		}
		chunk, decodeErr := base64.StdEncoding.DecodeString(payload.ContentBase64)
		if decodeErr != nil {
			t.Fatalf("decode MCP artifact chunk at offset %d: %v", mcpOffset, decodeErr)
		}
		mcpReassembled = append(mcpReassembled, chunk...)
		if payload.Complete {
			break
		}
		mcpOffset = payload.NextOffset
	}
	if string(mcpReassembled) != string(content) {
		t.Fatalf("MCP reassembled artifact content = %q, want %q", mcpReassembled, content)
	}
	mcpDigest := sha256.Sum256(mcpReassembled)
	if hex.EncodeToString(mcpDigest[:]) != hex.EncodeToString(digest[:]) {
		t.Fatalf("MCP reassembled artifact hash = %q, want %q", hex.EncodeToString(mcpDigest[:]), hex.EncodeToString(digest[:]))
	}
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

	response = httptest.NewRecorder()
	writeArtifactDownloadError(response, request, http.StatusConflict, artifacts.ErrContentChanged, "artifact content changed")
	var conflict protocol.ApiError
	if err := json.NewDecoder(response.Body).Decode(&conflict); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusConflict || conflict.Code != protocol.ErrorCodeConflict {
		t.Fatalf("content conflict error = status %d/code %q", response.Code, conflict.Code)
	}
}
