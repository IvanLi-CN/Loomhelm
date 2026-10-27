package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
)

const migrationTimeout = 30 * time.Second

type migrationOperation string

const (
	migrationOperationSchema   migrationOperation = "schema"
	migrationOperationPrepare  migrationOperation = "prepare"
	migrationOperationBackfill migrationOperation = "backfill"
	migrationOperationValidate migrationOperation = "validate"
	migrationOperationIndexes  migrationOperation = "indexes"
	migrationOperationCutover  migrationOperation = "cutover"
	migrationOperationStatus   migrationOperation = "status"
	migrationOperationAdopt    migrationOperation = "adopt"
)

type migrationCommand struct {
	operation migrationOperation
	timeout   time.Duration
	options   database.ApprovalHistoryMigrationOptions
}

type approvalHistoryMigrationOperator interface {
	Prepare(context.Context) (database.ApprovalHistoryMigrationProgress, error)
	Progress(context.Context) (database.ApprovalHistoryMigrationProgress, error)
	RunBackfill(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error)
	Validate(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error)
	BuildIndexes(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error)
	Cutover(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error)
	AdoptAtomic00012(context.Context, database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error)
}

type migrationProgressOutput struct {
	Operation           migrationOperation                     `json:"operation"`
	Status              string                                 `json:"status"`
	Phase               database.ApprovalHistoryMigrationPhase `json:"phase"`
	CheckpointID        string                                 `json:"checkpoint_id"`
	RowsScanned         int64                                  `json:"rows_scanned"`
	RowsCopied          int64                                  `json:"rows_copied"`
	DirtyRowsReconciled int64                                  `json:"dirty_rows_reconciled"`
	DirtyRowsPending    int64                                  `json:"dirty_rows_pending"`
	ErrorCode           string                                 `json:"error_code,omitempty"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runWithArgs(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "database migration failed:", safeMigrationError(err))
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	return runCommandWithTimeout(ctx, migrationCommand{timeout: migrationTimeout}, io.Discard)
}

func runWithTimeout(ctx context.Context, timeout time.Duration) error {
	return runCommandWithTimeout(ctx, migrationCommand{timeout: timeout}, io.Discard)
}

func runWithArgs(ctx context.Context, args []string) error {
	command, err := parseMigrationCommand(args)
	if err != nil {
		return err
	}
	return runCommandWithTimeout(ctx, command, os.Stdout)
}

func runCommandWithTimeout(ctx context.Context, command migrationCommand, output io.Writer) error {
	if ctx == nil {
		return errors.New("migration context must not be nil")
	}
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		return err
	}
	migrationCtx, cancel := context.WithTimeout(ctx, command.timeout)
	defer cancel()

	db, err := database.Open(migrationCtx, database.Config{
		URL:      config.URL,
		MinConns: config.MinConns,
		MaxConns: config.MaxConns,
	})
	if err != nil {
		return err
	}
	defer db.Close()
	migrator := database.NewApprovalHistoryMigrator(db.Pool(), database.ApprovalHistoryMigratorConfig{
		LeaseOwner: command.options.LeaseOwner,
	})
	if command.operation == migrationOperationAdopt {
		progress, operationErr := migrator.AdoptAtomic00012(migrationCtx, command.options)
		return emitMigrationProgress(output, command.operation, progress, operationErr)
	}
	runner, err := jobs.NewRunner(db, nil, jobs.Config{})
	if err != nil {
		return err
	}
	if err := db.WithMigrationLock(migrationCtx, func(lockCtx context.Context) error {
		if err := db.Migrate(lockCtx); err != nil {
			return err
		}
		return runner.Migrate(lockCtx)
	}); err != nil {
		return err
	}
	if command.operation == "" || command.operation == migrationOperationSchema {
		return nil
	}
	progress, operationErr := dispatchMigrationOperation(migrationCtx, command.operation, migrator, command.options)
	return emitMigrationProgress(output, command.operation, progress, operationErr)
}

func parseMigrationCommand(args []string) (migrationCommand, error) {
	flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	operation := flags.String("operation", "", "explicit migration operation")
	timeout := flags.Duration("timeout", migrationTimeout, "overall operation timeout")
	batchSize := flags.Int("batch-size", 0, "approval history backfill batch size")
	workBudget := flags.Int64("work-budget", 0, "approval history backfill work budget")
	preDrainBatchSize := flags.Int("pre-drain-batch-size", 0, "approval history pre-drain batch size")
	preDrainWorkBudget := flags.Int64("pre-drain-work-budget", 0, "approval history pre-drain work budget")
	finalRowBudget := flags.Int64("final-row-budget", 0, "approval history final cutover row budget")
	finalWorkBudget := flags.Int64("final-work-budget", 0, "approval history final cutover work budget")
	lockTimeout := flags.Duration("lock-timeout", 0, "approval history lock timeout")
	statementTimeout := flags.Duration("statement-timeout", 0, "approval history statement timeout")
	leaseDuration := flags.Duration("lease-duration", 0, "approval history lease duration")
	leaseOwner := flags.String("lease-owner", "", "approval history migration lease owner")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return migrationCommand{}, errors.New("migration help requested")
		}
		return migrationCommand{}, errors.New("invalid migration arguments")
	}
	if len(flags.Args()) != 0 {
		return migrationCommand{}, errors.New("invalid migration arguments: unexpected positional argument")
	}
	parsedOperation := migrationOperation(strings.TrimSpace(strings.ToLower(*operation)))
	if parsedOperation == "migrate" {
		parsedOperation = migrationOperationSchema
	}
	switch parsedOperation {
	case "", migrationOperationSchema, migrationOperationPrepare, migrationOperationBackfill,
		migrationOperationValidate, migrationOperationIndexes, migrationOperationCutover,
		migrationOperationStatus, migrationOperationAdopt:
	default:
		return migrationCommand{}, fmt.Errorf("invalid migration operation %q", *operation)
	}
	if *timeout <= 0 {
		return migrationCommand{}, errors.New("migration timeout must be greater than zero")
	}
	for name, value := range map[string]int{
		"batch-size":           *batchSize,
		"pre-drain-batch-size": *preDrainBatchSize,
	} {
		if value < 0 {
			return migrationCommand{}, fmt.Errorf("%s must not be negative", name)
		}
	}
	for name, value := range map[string]int64{
		"work-budget":           *workBudget,
		"pre-drain-work-budget": *preDrainWorkBudget,
		"final-row-budget":      *finalRowBudget,
		"final-work-budget":     *finalWorkBudget,
	} {
		if value < 0 {
			return migrationCommand{}, fmt.Errorf("%s must not be negative", name)
		}
	}
	for name, value := range map[string]time.Duration{
		"lock-timeout":      *lockTimeout,
		"statement-timeout": *statementTimeout,
		"lease-duration":    *leaseDuration,
	} {
		if value < 0 {
			return migrationCommand{}, fmt.Errorf("%s must not be negative", name)
		}
	}
	return migrationCommand{
		operation: parsedOperation,
		timeout:   *timeout,
		options: database.ApprovalHistoryMigrationOptions{
			BatchSize:          *batchSize,
			WorkBudget:         *workBudget,
			PreDrainBatchSize:  *preDrainBatchSize,
			PreDrainWorkBudget: *preDrainWorkBudget,
			FinalRowBudget:     *finalRowBudget,
			FinalWorkBudget:    *finalWorkBudget,
			LockTimeout:        *lockTimeout,
			StatementTimeout:   *statementTimeout,
			LeaseDuration:      *leaseDuration,
			LeaseOwner:         strings.TrimSpace(*leaseOwner),
		},
	}, nil
}

func dispatchMigrationOperation(ctx context.Context, operation migrationOperation, migrator approvalHistoryMigrationOperator, options database.ApprovalHistoryMigrationOptions) (database.ApprovalHistoryMigrationProgress, error) {
	if migrator == nil {
		return database.ApprovalHistoryMigrationProgress{}, errors.New("approval history migration operator is required")
	}
	switch operation {
	case migrationOperationPrepare:
		return migrator.Prepare(ctx)
	case migrationOperationBackfill:
		return migrator.RunBackfill(ctx, options)
	case migrationOperationValidate:
		return migrator.Validate(ctx, options)
	case migrationOperationIndexes:
		return migrator.BuildIndexes(ctx, options)
	case migrationOperationCutover:
		return migrator.Cutover(ctx, options)
	case migrationOperationStatus:
		return migrator.Progress(ctx)
	case migrationOperationAdopt:
		return migrator.AdoptAtomic00012(ctx, options)
	default:
		return database.ApprovalHistoryMigrationProgress{}, fmt.Errorf("unsupported migration operation %q", operation)
	}
}

func emitMigrationProgress(output io.Writer, operation migrationOperation, progress database.ApprovalHistoryMigrationProgress, operationErr error) error {
	if output == nil {
		return operationErr
	}
	result := migrationProgressOutput{
		Operation:           operation,
		Status:              "complete",
		Phase:               progress.Phase,
		CheckpointID:        progress.CheckpointID,
		RowsScanned:         progress.RowsScanned,
		RowsCopied:          progress.RowsCopied,
		DirtyRowsReconciled: progress.DirtyRowsReconciled,
		DirtyRowsPending:    progress.DirtyRowsPending,
	}
	if operationErr != nil {
		result.Status = "failed"
		result.ErrorCode = migrationErrorCode(operationErr)
	}
	if err := json.NewEncoder(output).Encode(result); err != nil {
		return errors.Join(operationErr, fmt.Errorf("write migration progress: %w", err))
	}
	return operationErr
}

func migrationErrorCode(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, database.ErrApprovalHistoryMigrationBusy):
		return "busy"
	case errors.Is(err, database.ErrApprovalHistoryMigrationBudget):
		return "budget_exceeded"
	case errors.Is(err, database.ErrApprovalHistoryMigrationNotReady):
		return "not_ready"
	case errors.Is(err, database.ErrApprovalHistoryAtomicAdoption):
		return "atomic_adoption_rejected"
	case errors.Is(err, database.ErrApprovalHistoryMigrationUnavailable):
		return "unavailable"
	default:
		return "failed"
	}
}

func safeMigrationError(err error) string {
	if err == nil {
		return ""
	}
	if strings.HasPrefix(err.Error(), "invalid migration") || strings.HasPrefix(err.Error(), "migration help") || strings.HasPrefix(err.Error(), "LOOMHELM_") {
		return err.Error()
	}
	return migrationErrorCode(err)
}
