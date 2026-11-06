package jobs_test

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/jobs"
	"github.com/riverqueue/river"
)

func TestProducerPersistsWithoutWorkerLeaseAndRespectsTransaction(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := database.Open(ctx, databaseConfigForTest(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	queue := "loomhelm-producer-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	runner, err := jobs.NewRunner(db, nil, jobs.Config{Queue: queue})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.WithMigrationLock(ctx, func(locked context.Context) error {
		if err := db.Migrate(locked); err != nil {
			return err
		}
		return runner.Migrate(locked)
	}); err != nil {
		t.Fatal(err)
	}
	producer, err := jobs.NewProducer(db, nil, jobs.ProducerConfig{Queue: queue})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if _, err := db.Pool().Exec(cleanup, `DELETE FROM river_job WHERE queue = $1`, queue); err != nil {
			t.Errorf("cleanup producer jobs: %v", err)
		}
	}()
	args := jobs.ShortJobArgs{Generation: 1, Payload: "insert-only producer"}
	opts := &river.InsertOpts{MaxAttempts: 2}
	jobID, err := producer.Enqueue(ctx, args, opts)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Queue != "" || opts.MaxAttempts != 2 {
		t.Fatalf("producer changed caller options: %+v", opts)
	}
	var actualQueue, state string
	if err := db.Pool().QueryRow(ctx, `SELECT queue, state FROM river_job WHERE id = $1`, jobID).Scan(&actualQueue, &state); err != nil {
		t.Fatal(err)
	}
	if actualQueue != queue || state != "available" {
		t.Fatalf("insert-only job queue/state = %q/%q", actualQueue, state)
	}
	if _, err := producer.Enqueue(ctx, args, &river.InsertOpts{Queue: queue + "-other"}); err == nil {
		t.Fatal("producer accepted an unrelated queue")
	}
	var leases int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM platform_worker_leases WHERE lease_key = $1`, "loomhelm-worker:"+queue).Scan(&leases); err != nil {
		t.Fatal(err)
	}
	if leases != 0 || runner.Ready() {
		t.Fatal("producer claimed worker execution readiness or a worker lease")
	}
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	rollbackID, err := producer.EnqueueTx(ctx, tx, args, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM river_job WHERE id = $1`, rollbackID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled-back job count = %d, error = %v", count, err)
	}
	tx, err = db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	committedID, err := producer.EnqueueTx(ctx, tx, args, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM river_job WHERE id = $1`, committedID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("committed job count = %d, error = %v", count, err)
	}
}
