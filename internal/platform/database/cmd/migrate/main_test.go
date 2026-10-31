package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
)

type recordingApprovalHistoryMigrationOperator struct {
	calls []migrationOperation
}

func (o *recordingApprovalHistoryMigrationOperator) record(operation migrationOperation) (database.ApprovalHistoryMigrationProgress, error) {
	o.calls = append(o.calls, operation)
	return database.ApprovalHistoryMigrationProgress{Phase: database.ApprovalHistoryPhaseStructureReady}, nil
}

func (o *recordingApprovalHistoryMigrationOperator) Prepare(context.Context) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationPrepare)
}

func (o *recordingApprovalHistoryMigrationOperator) Progress(context.Context) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationStatus)
}

func (o *recordingApprovalHistoryMigrationOperator) RunBackfill(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationBackfill)
}

func (o *recordingApprovalHistoryMigrationOperator) Validate(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationValidate)
}

func (o *recordingApprovalHistoryMigrationOperator) BuildIndexes(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationIndexes)
}

func (o *recordingApprovalHistoryMigrationOperator) Cutover(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationCutover)
}

func (o *recordingApprovalHistoryMigrationOperator) AdoptAtomic00012(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error) {
	return o.record(migrationOperationAdopt)
}

func TestParseMigrationCommandDefaultsToSchemaOnly(t *testing.T) {
	command, err := parseMigrationCommand(nil)
	if err != nil {
		t.Fatalf("parse default migration command: %v", err)
	}
	if command.operation != "" {
		t.Fatalf("default operation = %q, want empty schema operation", command.operation)
	}
	if command.timeout != migrationTimeout {
		t.Fatalf("default timeout = %s, want %s", command.timeout, migrationTimeout)
	}
	if command.options != (database.ApprovalHistoryMigrationOptions{}) {
		t.Fatalf("default options = %+v, want zero options", command.options)
	}
}

func TestParseMigrationCommandAcceptsBoundedOperationOptions(t *testing.T) {
	command, err := parseMigrationCommand([]string{
		"--operation", "backfill",
		"--timeout", "2s",
		"--batch-size", "7",
		"--work-budget", "11",
		"--pre-drain-batch-size", "3",
		"--pre-drain-work-budget", "13",
		"--final-row-budget", "17",
		"--final-work-budget", "19",
		"--lock-timeout", "100ms",
		"--statement-timeout", "200ms",
		"--lease-duration", "1s",
		"--lease-owner", " test-owner ",
	})
	if err != nil {
		t.Fatalf("parse bounded migration command: %v", err)
	}
	wantOptions := database.ApprovalHistoryMigrationOptions{
		BatchSize:          7,
		WorkBudget:         11,
		PreDrainBatchSize:  3,
		PreDrainWorkBudget: 13,
		FinalRowBudget:     17,
		FinalWorkBudget:    19,
		LockTimeout:        100 * time.Millisecond,
		StatementTimeout:   200 * time.Millisecond,
		LeaseDuration:      time.Second,
		LeaseOwner:         "test-owner",
	}
	if command.operation != migrationOperationBackfill {
		t.Fatalf("operation = %q, want backfill", command.operation)
	}
	if command.timeout != 2*time.Second {
		t.Fatalf("timeout = %s, want 2s", command.timeout)
	}
	if command.options != wantOptions {
		t.Fatalf("options = %+v, want %+v", command.options, wantOptions)
	}
}

func TestParseMigrationCommandRejectsInvalidArguments(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "unknown operation", args: []string{"--operation", "unknown"}},
		{name: "zero timeout", args: []string{"--timeout", "0"}},
		{name: "negative batch", args: []string{"--batch-size", "-1"}},
		{name: "negative work budget", args: []string{"--work-budget", "-1"}},
		{name: "negative lock timeout", args: []string{"--lock-timeout", "-1ms"}},
		{name: "positional argument", args: []string{"backfill"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseMigrationCommand(test.args); err == nil {
				t.Fatal("parseMigrationCommand() accepted invalid arguments")
			}
		})
	}
}

func TestDispatchMigrationOperationCoversExplicitOperations(t *testing.T) {
	operator := &recordingApprovalHistoryMigrationOperator{}
	operations := []migrationOperation{
		migrationOperationPrepare,
		migrationOperationBackfill,
		migrationOperationValidate,
		migrationOperationIndexes,
		migrationOperationCutover,
		migrationOperationStatus,
		migrationOperationAdopt,
	}
	for _, operation := range operations {
		if _, err := dispatchMigrationOperation(context.Background(), operation, operator, database.ApprovalHistoryMigrationOptions{}); err != nil {
			t.Fatalf("dispatch %s: %v", operation, err)
		}
	}
	if len(operator.calls) != len(operations) {
		t.Fatalf("recorded operations = %v, want %v", operator.calls, operations)
	}
	for index, operation := range operations {
		if operator.calls[index] != operation {
			t.Fatalf("operation %d = %q, want %q", index, operator.calls[index], operation)
		}
	}
}

func TestEmitMigrationProgressDoesNotExposeLastError(t *testing.T) {
	var output bytes.Buffer
	operationErr := fmt.Errorf("database password secret: %w", database.ErrApprovalHistoryMigrationUnavailable)
	err := emitMigrationProgress(&output, migrationOperationStatus, database.ApprovalHistoryMigrationProgress{
		Phase:            database.ApprovalHistoryPhaseFailed,
		CheckpointID:     "approval-7",
		RowsScanned:      11,
		RowsCopied:       7,
		DirtyRowsPending: 2,
		LastError:        "private database details",
	}, operationErr)
	if !errors.Is(err, database.ErrApprovalHistoryMigrationUnavailable) {
		t.Fatalf("emitMigrationProgress() error = %v, want unavailable error", err)
	}
	encoded := output.String()
	for _, secret := range []string{"secret", "private database details", "LastError"} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("progress output contains %q: %s", secret, encoded)
		}
	}
	for _, expected := range []string{`"status":"failed"`, `"error_code":"unavailable"`, `"checkpoint_id":"approval-7"`, `"rows_copied":7`} {
		if !strings.Contains(encoded, expected) {
			t.Fatalf("progress output missing %q: %s", expected, encoded)
		}
	}
}

func TestRunRejectsMismatchedDevelopmentDatabasePortBeforeConnection(t *testing.T) {
	t.Setenv("LOOMHELM_DATABASE_URL", "postgres://loomhelm:secret@127.0.0.1:55432/loomhelm?sslmode=disable")
	t.Setenv("LOOMHELM_POSTGRES_PORT", "55441")

	err := run(context.Background())
	if err == nil {
		t.Fatal("run() accepted mismatched development database port")
	}
	if !strings.Contains(err.Error(), "must match LOOMHELM_POSTGRES_PORT") {
		t.Fatalf("run() error = %v, want port mismatch", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("run() error leaked database credentials: %v", err)
	}
}

func TestRunRejectsInvalidPoolConfigurationBeforeConnection(t *testing.T) {
	t.Setenv("LOOMHELM_DATABASE_URL", "postgres://loomhelm:secret@127.0.0.1:55432/loomhelm?pool_max_conns=1&sslmode=disable")
	t.Setenv("LOOMHELM_POSTGRES_PORT", "55432")
	t.Setenv("LOOMHELM_DATABASE_MIN_CONNS", "2")
	t.Setenv("LOOMHELM_DATABASE_MAX_CONNS", "0")

	err := run(context.Background())
	if err == nil {
		t.Fatal("run() accepted invalid database pool configuration")
	}
	if !strings.Contains(err.Error(), "minimum connections must not exceed maximum connections") {
		t.Fatalf("run() error = %v, want pool bounds error", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("run() error leaked database credentials: %v", err)
	}
}

func TestRunWithTimeoutHonorsMigrationDeadline(t *testing.T) {
	t.Setenv("LOOMHELM_DATABASE_URL", "postgres://loomhelm:secret@127.0.0.1:55432/loomhelm?sslmode=disable")
	t.Setenv("LOOMHELM_POSTGRES_PORT", "55432")

	err := runWithTimeout(context.Background(), 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("runWithTimeout() error = %v, want context deadline exceeded", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("runWithTimeout() error leaked database credentials: %v", err)
	}
}
