package jobs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// Producer persists bounded work without acquiring the Worker's deployment
// lease or starting consumers. The caller still owns application authorization.
// A successful insert acknowledges queue persistence, never Codex completion.
type Producer struct {
	client *river.Client[pgx.Tx]
	queue  string
}

type ProducerConfig struct {
	Queue  string
	Schema string
}

func NewProducer(db *database.DB, logger *slog.Logger, cfg ProducerConfig) (*Producer, error) {
	if db == nil || db.Pool() == nil {
		return nil, errors.New("job producer database must be open")
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.Queue == "" {
		cfg.Queue = river.QueueDefault
	}
	// Omitting Queues and Workers creates River's insert-only client. This
	// client is deliberately never started and does not own the database pool.
	client, err := river.NewClient(riverpgxv5.New(db.Pool()), &river.Config{Logger: logger, Schema: cfg.Schema})
	if err != nil {
		return nil, fmt.Errorf("initialize job producer: %w", err)
	}
	return &Producer{client: client, queue: cfg.Queue}, nil
}

func (p *Producer) Enqueue(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (int64, error) {
	insertOpts, err := p.options(ctx, args, opts)
	if err != nil {
		return 0, err
	}
	result, err := p.client.Insert(ctx, args, insertOpts)
	if err != nil {
		return 0, fmt.Errorf("persist queued work: %w", err)
	}
	return result.Job.ID, nil
}

// EnqueueTx lets an application write its intent and queue item atomically.
// The caller owns commit/rollback and must supply a transaction on the same DB.
func (p *Producer) EnqueueTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (int64, error) {
	insertOpts, err := p.options(ctx, args, opts)
	if err != nil {
		return 0, err
	}
	if tx == nil {
		return 0, errors.New("job producer transaction must not be nil")
	}
	result, err := p.client.InsertTx(ctx, tx, args, insertOpts)
	if err != nil {
		return 0, fmt.Errorf("persist transactional queued work: %w", err)
	}
	return result.Job.ID, nil
}

func (p *Producer) options(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*river.InsertOpts, error) {
	if p == nil || p.client == nil {
		return nil, errors.New("job producer is not initialized")
	}
	if ctx == nil {
		return nil, errors.New("job context must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if args == nil {
		return nil, errors.New("job arguments must not be nil")
	}
	var copied river.InsertOpts
	if opts != nil {
		copied = *opts
	}
	if copied.Queue != "" && copied.Queue != p.queue {
		return nil, errors.New("job queue must match the producer queue")
	}
	copied.Queue = p.queue
	return &copied, nil
}
