package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/db/migrations"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database/generated"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

const migrationAdvisoryLockKey int64 = 0x4c6f6f6d68656c6d

type migrationLockContextKey struct{}

type Config struct {
	URL      string
	MinConns int32
	MaxConns int32
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.URL) == "" {
		return errors.New("database URL must not be empty")
	}
	if c.MinConns < 0 {
		return errors.New("database minimum connections must not be negative")
	}
	if c.MaxConns < 0 {
		return errors.New("database maximum connections must not be negative")
	}
	if c.MaxConns > 0 && c.MinConns > c.MaxConns {
		return errors.New("database minimum connections must not exceed maximum connections")
	}
	return nil
}

type DB struct {
	pool       *pgxpool.Pool
	queries    *generated.Queries
	connConfig *pgx.ConnConfig
}

func Open(ctx context.Context, cfg Config) (*DB, error) {
	if ctx == nil {
		return nil, errors.New("database context must not be nil")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	poolConfig, err := pgxpool.ParseConfig(strings.TrimSpace(cfg.URL))
	if err != nil {
		return nil, errors.New("invalid database URL")
	}
	if cfg.MinConns > 0 {
		poolConfig.MinConns = cfg.MinConns
	}
	if cfg.MaxConns > 0 {
		poolConfig.MaxConns = cfg.MaxConns
	}
	connConfig := poolConfig.ConnConfig.Copy()

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, errors.New("open database pool")
	}
	db := &DB{pool: pool, queries: generated.New(pool), connConfig: connConfig}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return db, nil
}

func (db *DB) Ping(ctx context.Context) error {
	if db == nil || db.pool == nil {
		return errors.New("database is not open")
	}
	if ctx == nil {
		return errors.New("database context must not be nil")
	}
	return db.pool.Ping(ctx)
}

func (db *DB) Migrate(ctx context.Context) error {
	if db == nil || db.pool == nil {
		return errors.New("database is not open")
	}
	if ctx == nil {
		return errors.New("database context must not be nil")
	}
	if MigrationLockHeld(ctx) {
		return db.migrate(ctx)
	}
	return db.WithMigrationLock(ctx, db.migrate)
}

func (db *DB) migrate(ctx context.Context) error {
	if db == nil || db.pool == nil {
		return errors.New("database is not open")
	}
	if ctx == nil {
		return errors.New("database context must not be nil")
	}

	sqlDB := stdlib.OpenDBFromPool(db.pool)
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		return fmt.Errorf("create database migration provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply database migrations: %w", err)
	}
	return nil
}

// WithMigrationLock serializes schema changes across Loomhelm processes.
// The callback receives the lock-bearing context and must run the complete
// application and queue migration window before returning.
func (db *DB) WithMigrationLock(ctx context.Context, fn func(context.Context) error) error {
	if db == nil || db.pool == nil {
		return errors.New("database is not open")
	}
	if ctx == nil {
		return errors.New("database context must not be nil")
	}
	if fn == nil {
		return errors.New("database migration callback must not be nil")
	}
	if MigrationLockHeld(ctx) {
		return fn(ctx)
	}

	lockConn, err := pgx.ConnectConfig(ctx, db.connConfig.Copy())
	if err != nil {
		return errors.New("open database migration lock connection")
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, unlockErr := lockConn.Exec(closeCtx, "SELECT pg_advisory_unlock($1)", migrationAdvisoryLockKey); unlockErr != nil {
			_ = lockConn.Close(closeCtx)
			return
		}
		_ = lockConn.Close(closeCtx)
	}()

	if _, err := lockConn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationAdvisoryLockKey); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("acquire database migration lock: %w", err)
		}
		return errors.New("acquire database migration lock")
	}
	return fn(context.WithValue(ctx, migrationLockContextKey{}, struct{}{}))
}

func MigrationLockHeld(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	_, ok := ctx.Value(migrationLockContextKey{}).(struct{})
	return ok
}

func (db *DB) Pool() *pgxpool.Pool {
	if db == nil {
		return nil
	}
	return db.pool
}

func (db *DB) Queries() *generated.Queries {
	if db == nil {
		return nil
	}
	return db.queries
}

func (db *DB) Close() {
	if db == nil || db.pool == nil {
		return
	}
	db.pool.Close()
}
