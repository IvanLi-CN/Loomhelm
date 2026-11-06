package deployment

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
)

type deploymentTestExecutor struct {
	mu    sync.Mutex
	calls []Operation
	err   error
}

func (e *deploymentTestExecutor) Execute(_ context.Context, operation Operation) error {
	e.mu.Lock()
	e.calls = append(e.calls, operation)
	err := e.err
	e.mu.Unlock()
	return err
}

func TestDeploymentOperationsPersistIdempotencyAndUnknownRecovery(t *testing.T) {
	db := openDeploymentTestDatabase(t)
	defer db.Close()
	executor := &deploymentTestExecutor{}
	service, err := NewService(db.Pool(), Config{OwnerUserIDs: []string{"owner"}, Executor: executor})
	if err != nil {
		t.Fatal(err)
	}
	principal := auth.Principal{UserID: "owner", CredentialID: "deployment-test"}
	first, err := service.RegisterCandidate(context.Background(), deploymentTestEnvelope(1))
	if err != nil {
		t.Fatalf("register first candidate: %v", err)
	}
	conflictingEnvelope := deploymentTestEnvelope(1)
	conflictingEnvelope.StateVersion = 2
	conflictingEnvelope.ManifestJSON = []byte(`{"schema_version":2,"deployment":{"state_version":2,"read_min":1,"read_max":2,"migration_mode":"expand"}}`)
	if _, err := service.RegisterCandidate(context.Background(), conflictingEnvelope); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting envelope registration error = %v, want %v", err, ErrIdempotencyConflict)
	}
	second, err := service.RegisterCandidate(context.Background(), deploymentTestEnvelope(2))
	if err != nil {
		t.Fatalf("register second candidate: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	preflightRequest := OperationRequest{CandidateID: first.ID}
	preflight, created, err := service.StartOperation(ctx, principal, "preflight", preflightRequest, "preflight-1")
	if err != nil || !created {
		t.Fatalf("start preflight = %+v, created=%t, err=%v", preflight, created, err)
	}
	waitDeploymentOperation(t, ctx, service, preflight.ID, "succeeded")
	retry, created, err := service.StartOperation(ctx, principal, "preflight", preflightRequest, "preflight-1")
	if err != nil || created || retry.ID != preflight.ID {
		t.Fatalf("idempotent preflight retry = %+v, created=%t, err=%v", retry, created, err)
	}
	if _, _, err := service.StartOperation(ctx, principal, "preflight", OperationRequest{CandidateID: second.ID}, "preflight-1"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting idempotency retry error = %v, want %v", err, ErrIdempotencyConflict)
	}

	stageFirst, _, err := service.StartOperation(ctx, principal, "stage", OperationRequest{CandidateID: first.ID, Confirm: true}, "stage-1")
	if err != nil {
		t.Fatalf("start first stage: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, stageFirst.ID, "succeeded")
	promoteFirst, _, err := service.StartOperation(ctx, principal, "promote", OperationRequest{CandidateID: first.ID, Confirm: true}, "promote-1")
	if err != nil {
		t.Fatalf("start first promote: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, promoteFirst.ID, "succeeded")
	status, err := service.Status(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	if status.ActiveSlot != "blue" || status.ActiveCandidateID != first.ID || status.ActiveFingerprint == "" {
		t.Fatalf("first active status = %+v", status)
	}
	firstFingerprint := status.ActiveFingerprint

	stageSecond, _, err := service.StartOperation(ctx, principal, "stage", OperationRequest{CandidateID: second.ID, Confirm: true, ExpectedFingerprint: firstFingerprint}, "stage-2")
	if err != nil {
		t.Fatalf("start second stage: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, stageSecond.ID, "succeeded")
	promoteSecond, _, err := service.StartOperation(ctx, principal, "promote", OperationRequest{CandidateID: second.ID, Confirm: true, ExpectedFingerprint: firstFingerprint}, "promote-2")
	if err != nil {
		t.Fatalf("start second promote: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, promoteSecond.ID, "succeeded")
	status, err = service.Status(ctx, principal)
	if err != nil || status.ActiveSlot != "green" || status.ActiveCandidateID != second.ID {
		t.Fatalf("second active status = %+v, err=%v", status, err)
	}
	secondFingerprint := status.ActiveFingerprint
	if secondFingerprint == firstFingerprint {
		t.Fatal("active fingerprint did not change across promotion")
	}

	rollback, _, err := service.StartOperation(ctx, principal, "rollback", OperationRequest{CandidateID: first.ID, Confirm: true, ExpectedFingerprint: secondFingerprint}, "rollback-1")
	if err != nil {
		t.Fatalf("start rollback: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, rollback.ID, "succeeded")
	status, err = service.Status(ctx, principal)
	if err != nil || status.ActiveSlot != "blue" || status.ActiveCandidateID != first.ID {
		t.Fatalf("rollback status = %+v, err=%v", status, err)
	}

	executor.mu.Lock()
	executor.err = context.DeadlineExceeded
	executor.mu.Unlock()
	third, err := service.RegisterCandidate(ctx, deploymentTestEnvelope(3))
	if err != nil {
		t.Fatalf("register third candidate: %v", err)
	}
	unknown, _, err := service.StartOperation(ctx, principal, "stage", OperationRequest{CandidateID: third.ID, Confirm: true, ExpectedFingerprint: status.ActiveFingerprint}, "stage-unknown")
	if err != nil {
		t.Fatalf("start unknown stage: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, unknown.ID, "unknown")
	status, err = service.Status(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	for _, slot := range status.Slots {
		if slot.CandidateID == third.ID && slot.State != "staging" {
			t.Fatalf("unknown stage changed slot to %q, want staging", slot.State)
		}
	}
	executor.mu.Lock()
	executor.err = &DeterministicError{Err: errors.New("reconcile proof was rejected")}
	executor.mu.Unlock()
	failedReconcile, _, err := service.StartOperation(ctx, principal, "reconcile", OperationRequest{OperationID: unknown.ID, ExpectedFingerprint: status.ActiveFingerprint}, "reconcile-stage-unknown-failed")
	if err != nil {
		t.Fatalf("start failed unknown-stage reconcile: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, failedReconcile.ID, "failed")
	if _, _, err := service.StartOperation(ctx, principal, "stage", OperationRequest{CandidateID: second.ID, Confirm: true, ExpectedFingerprint: status.ActiveFingerprint}, "blocked-while-reconcile-failed"); !errors.Is(err, ErrOperationLocked) {
		t.Fatalf("operation accepted while unknown target remained locked: %v", err)
	}
	executor.mu.Lock()
	executor.err = nil
	executor.mu.Unlock()
	reconcile, _, err := service.StartOperation(ctx, principal, "reconcile", OperationRequest{OperationID: unknown.ID, ExpectedFingerprint: status.ActiveFingerprint}, "reconcile-stage-unknown")
	if err != nil {
		t.Fatalf("start unknown-stage reconcile: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, reconcile.ID, "succeeded")
	recovered, err := service.GetOperation(ctx, unknown.ID)
	if err != nil || recovered.Status != "succeeded" {
		t.Fatalf("reconciled stage operation = %+v, err=%v", recovered, err)
	}
	events, err := service.ListEvents(ctx, 200)
	if err != nil {
		t.Fatalf("list deployment events: %v", err)
	}
	var observedPromotion, observedReconciledStage bool
	for _, event := range events {
		if event.Type == "promote_succeeded" {
			if event.WorkerGeneration == nil || *event.WorkerGeneration <= 0 || event.ObservedFingerprint == "" {
				t.Fatalf("promotion event did not preserve runtime identity: %+v", event)
			}
			observedPromotion = true
		}
		if event.OperationID == unknown.ID && event.Type == "stage_succeeded" {
			if event.Details["reconciled_by"] != reconcile.ID || event.ObservedFingerprint == "" {
				t.Fatalf("reconciled stage event did not preserve terminal evidence: %+v", event)
			}
			observedReconciledStage = true
		}
	}
	if !observedPromotion {
		t.Fatal("deployment events did not contain a successful promotion")
	}
	if !observedReconciledStage {
		t.Fatal("deployment events did not contain a terminal event for the reconciled stage")
	}

	fourth, err := service.RegisterCandidate(ctx, deploymentTestEnvelope(4))
	if err != nil {
		t.Fatalf("register fourth candidate: %v", err)
	}
	executor.mu.Lock()
	executor.err = &DeterministicError{Err: errors.New("candidate readiness was rejected")}
	executor.mu.Unlock()
	failedStage, _, err := service.StartOperation(ctx, principal, "stage", OperationRequest{CandidateID: fourth.ID, Confirm: true, ExpectedFingerprint: status.ActiveFingerprint}, "stage-deterministic-failure")
	if err != nil {
		t.Fatalf("start deterministic failed stage: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, failedStage.ID, "failed")
	candidates, err := service.ListCandidates(ctx)
	if err != nil {
		t.Fatalf("list candidates after deterministic failure: %v", err)
	}
	for _, candidate := range candidates {
		if candidate.ID == fourth.ID && candidate.Status != "failed" {
			t.Fatalf("deterministic failed candidate status = %q, want failed", candidate.Status)
		}
	}
	executor.mu.Lock()
	executor.err = nil
	executor.mu.Unlock()
	retainedDrain, _, err := service.StartOperation(ctx, principal, "drain", OperationRequest{
		Slot:                "green",
		ExpectedFingerprint: status.ActiveFingerprint,
		Confirm:             true,
	}, "drain-retained")
	if err != nil {
		t.Fatalf("start retained-slot drain: %v", err)
	}
	waitDeploymentOperation(t, ctx, service, retainedDrain.ID, "succeeded")
	status, err = service.Status(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	for _, slot := range status.Slots {
		if slot.Name == "green" && slot.State != "draining" {
			t.Fatalf("retained slot state = %q, want draining", slot.State)
		}
	}
}

func deploymentTestEnvelope(index byte) Envelope {
	character := fmt.Sprintf("%x", index)
	return Envelope{
		SchemaVersion:  2,
		CandidateID:    strings.Repeat(character, 64),
		SourceSHA:      strings.Repeat(character, 40),
		ArtifactDigest: "sha256:" + strings.Repeat(character, 64),
		WebDigest:      "sha256:" + strings.Repeat(character, 64),
		ServerImage:    "ghcr.io/example/loomhelm-server@sha256:" + strings.Repeat(character, 64),
		WorkerImage:    "ghcr.io/example/loomhelm-worker@sha256:" + strings.Repeat(character, 64),
		StateVersion:   1,
		ReadMin:        1,
		ReadMax:        1,
		MigrationMode:  "none",
		ManifestJSON:   []byte(`{"schema_version":2}`),
	}
}

func waitDeploymentOperation(t *testing.T, ctx context.Context, service *Service, id, wantStatus string) Operation {
	t.Helper()
	for {
		operation, err := service.GetOperation(ctx, id)
		if err != nil {
			t.Fatalf("get operation %s: %v", id, err)
		}
		if operation.Status == wantStatus {
			return operation
		}
		if operation.Status == "failed" || operation.Status == "degraded" || operation.Status == "unknown" {
			if wantStatus != operation.Status {
				t.Fatalf("operation %s status = %q, want %q (%s)", id, operation.Status, wantStatus, operation.ErrorMessage)
			}
			return operation
		}
		select {
		case <-ctx.Done():
			t.Fatalf("operation %s did not reach %q: %v", id, wantStatus, ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func openDeploymentTestDatabase(t *testing.T) *database.DB {
	t.Helper()
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 1})
	if err != nil {
		t.Fatal(err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := "deployment_test_" + hex.EncodeToString(suffix)
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	databaseURL := rawDeploymentDatabaseURL(config.URL, schema)
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Pool().Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop deployment test schema: %v", err)
		}
		admin.Close()
	})
	return db
}

func rawDeploymentDatabaseURL(raw, schema string) string {
	if strings.Contains(raw, "://") {
		parsed, err := url.Parse(raw)
		if err == nil {
			query := parsed.Query()
			query.Set("search_path", schema)
			parsed.RawQuery = query.Encode()
			return parsed.String()
		}
	}
	return strings.TrimSpace(raw) + " search_path=" + schema
}
