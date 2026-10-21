package hosts

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestServicePersistsCredentialsGenerationsAndCursorRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openHostDatabase(t, ctx)

	registration, err := NewService(db.Pool()).Register(ctx, RegisterRequest{
		Name:           "h01 integration " + time.Now().UTC().Format("20060102T150405.000000000"),
		CredentialName: "primary",
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if _, err := NewService(db.Pool()).Register(ctx, RegisterRequest{Name: "second h01 registration"}); !errors.Is(err, ErrAlreadyRegistered) {
		t.Fatalf("second Register() error = %v, want ErrAlreadyRegistered", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupHostRegistration(cleanupCtx, db.Pool(), registration.Host.ID)
		db.Close()
	})

	var storedHash []byte
	if err := db.Pool().QueryRow(ctx, `SELECT token_hash FROM host_credentials WHERE id = $1`, registration.Credential.ID).Scan(&storedHash); err != nil {
		t.Fatalf("read token hash: %v", err)
	}
	expectedHash := sha256.Sum256([]byte(registration.Token))
	if string(storedHash) == registration.Token || len(storedHash) != len(expectedHash) {
		t.Fatalf("stored credential is not a fixed-size hash: %q", storedHash)
	}
	for index, value := range expectedHash {
		if storedHash[index] != value {
			t.Fatalf("stored credential hash differs at byte %d", index)
		}
	}

	clock := time.Date(2026, time.October, 22, 12, 0, 0, 0, time.UTC)
	service := NewService(db.Pool(), Config{
		CursorRetention: time.Hour,
		Now:             func() time.Time { return clock },
	})
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	first, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() first error = %v", err)
	}
	if first.Generation != 1 || len(first.ResumeCursors) != 0 {
		t.Fatalf("first connection = %+v", first)
	}
	if err := service.Checkpoint(ctx, first, Cursor{SessionID: "session_1", Value: "cursor_1"}); err != nil {
		t.Fatalf("Checkpoint() first error = %v", err)
	}
	if err := service.Checkpoint(ctx, first, Cursor{SessionID: "session_2", Value: "cursor_other"}); err != nil {
		t.Fatalf("Checkpoint() second stream error = %v", err)
	}
	start := make(chan struct{})
	errorsCh := make(chan error, 8)
	var group sync.WaitGroup
	for index := 0; index < 8; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			if index%2 == 0 {
				errorsCh <- service.Touch(ctx, first)
				return
			}
			errorsCh <- service.Checkpoint(ctx, first, Cursor{SessionID: "session_1", Value: "cursor_concurrent"})
		}(index)
	}
	close(start)
	group.Wait()
	close(errorsCh)
	for mutationErr := range errorsCh {
		if mutationErr != nil {
			t.Fatalf("concurrent connection mutation error = %v", mutationErr)
		}
	}

	second, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() replacement error = %v", err)
	}
	if second.Generation != 2 || len(second.ResumeCursors) != 2 || !hasCursor(second.ResumeCursors, "session_1", "cursor_concurrent") || !hasCursor(second.ResumeCursors, "session_2", "cursor_other") {
		t.Fatalf("replacement connection = %+v", second)
	}
	if err := service.Touch(ctx, first); !errors.Is(err, ErrConnectionStale) {
		t.Fatalf("Touch() stale error = %v, want ErrConnectionStale", err)
	}
	if err := service.Checkpoint(ctx, first, Cursor{SessionID: "session_1", Value: "stale_cursor"}); !errors.Is(err, ErrConnectionStale) {
		t.Fatalf("Checkpoint() stale error = %v, want ErrConnectionStale", err)
	}
	handlerCalled := false
	if err := service.ProcessEvent(ctx, first, Cursor{SessionID: "session_1", Value: "stale_event"}, func(context.Context) error {
		handlerCalled = true
		return nil
	}); !errors.Is(err, ErrConnectionStale) || handlerCalled {
		t.Fatalf("ProcessEvent() stale error = %v, handlerCalled = %t", err, handlerCalled)
	}
	if err := service.CloseConnection(ctx, first); err != nil {
		t.Fatalf("CloseConnection() stale error = %v", err)
	}
	host, err := service.GetHost(ctx, registration.Host.ID)
	if err != nil {
		t.Fatalf("GetHost() after stale close error = %v", err)
	}
	if host.Status != StatusOnline || host.ConnectionGeneration != second.Generation || len(host.LastCursors) != 2 || !hasCursor(host.LastCursors, "session_1", "cursor_concurrent") {
		t.Fatalf("host after stale close = %+v", host)
	}

	clock = clock.Add(2 * time.Hour)
	third, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() expired cursor error = %v", err)
	}
	if len(third.ResumeCursors) != 0 {
		t.Fatalf("expired resume cursors = %+v, want none", third.ResumeCursors)
	}

	if err := service.RevokeCredential(ctx, registration.Credential.ID); err != nil {
		t.Fatalf("RevokeCredential() error = %v", err)
	}
	if _, err := service.Authenticate(ctx, registration.Token); !errors.Is(err, ErrCredentialRevoked) {
		t.Fatalf("Authenticate() after revoke error = %v, want ErrCredentialRevoked", err)
	}
	if err := service.Touch(ctx, third); !errors.Is(err, ErrConnectionStale) {
		t.Fatalf("Touch() after revoke error = %v, want ErrConnectionStale", err)
	}
	if _, err := service.OpenConnection(ctx, credential); !errors.Is(err, ErrCredentialRevoked) {
		t.Fatalf("OpenConnection() after revoke error = %v, want ErrCredentialRevoked", err)
	}
}

func TestServiceCursorSurvivesDatabaseReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openHostDatabase(t, ctx)

	registration, err := NewService(db.Pool()).Register(ctx, RegisterRequest{Name: "h01 reopen " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		db.Close()
		reopened, openErr := openHostDatabaseWithContext(cleanupCtx)
		if openErr == nil {
			defer reopened.Close()
			cleanupHostRegistration(cleanupCtx, reopened.Pool(), registration.Host.ID)
		}
	})

	service := NewService(db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	if err := service.Checkpoint(ctx, connection, Cursor{SessionID: "session_reopen", Value: "cursor_reopen"}); err != nil {
		t.Fatalf("Checkpoint() error = %v", err)
	}
	db.Close()

	reopened, err := openHostDatabaseWithContext(ctx)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer reopened.Close()
	reconnected, err := NewService(reopened.Pool()).OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() after reopen error = %v", err)
	}
	if len(reconnected.ResumeCursors) != 1 || !hasCursor(reconnected.ResumeCursors, "session_reopen", "cursor_reopen") {
		t.Fatalf("resume cursors after reopen = %+v", reconnected.ResumeCursors)
	}
}

func hasCursor(cursors []Cursor, sessionID, value string) bool {
	for _, cursor := range cursors {
		if cursor.SessionID == sessionID && cursor.Value == value {
			return true
		}
	}
	return false
}

func openHostDatabase(t *testing.T, ctx context.Context) *database.DB {
	t.Helper()
	db, err := openHostDatabaseWithContext(ctx)
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("open host database: %v", err)
	}
	return db
}

func cleanupHostRegistration(ctx context.Context, pool *pgxpool.Pool, hostID string) {
	if pool == nil {
		return
	}
	_, _ = pool.Exec(ctx, `DELETE FROM host_connections WHERE host_id = $1`, hostID)
	_, _ = pool.Exec(ctx, `DELETE FROM host_credentials WHERE host_id = $1`, hostID)
	_, _ = pool.Exec(ctx, `DELETE FROM host_registrations WHERE id = $1`, hostID)
}

func openHostDatabaseWithContext(ctx context.Context) (*database.DB, error) {
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		return nil, err
	}
	db, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 4})
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
