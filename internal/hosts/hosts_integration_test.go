package hosts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform"
	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestServicePersistsCredentialsGenerationsAndCursorRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	db := testDB.db

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
	configured, err := service.ConfiguredHost(ctx)
	if err != nil {
		t.Fatalf("ConfiguredHost() error = %v", err)
	}
	if configured.ID != registration.Host.ID {
		t.Fatalf("ConfiguredHost() = %q, want %q", configured.ID, registration.Host.ID)
	}
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

func TestServiceHostOwnershipAndExplicitSharing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	pool := testDB.db.Pool()
	ownerID := "host-owner-" + time.Now().UTC().Format("20060102T150405.000000000")
	sharedID := ownerID + "-shared"
	foreignID := ownerID + "-foreign"
	for _, userID := range []string{ownerID, sharedID, foreignID} {
		insertHostTestUser(t, ctx, pool, userID)
	}
	service := NewService(pool)
	registration, err := service.RegisterForUser(ctx, ownerID, RegisterRequest{Name: "owned Host", CredentialName: "owner"})
	if err != nil {
		t.Fatalf("RegisterForUser() error = %v", err)
	}
	enrollment, err := service.EnrollForUser(ctx, ownerID, "", RegisterRequest{CredentialName: "enrolled"})
	if err != nil {
		t.Fatalf("EnrollForUser() error = %v", err)
	}
	if enrollment.Host.OwnerUserID != ownerID {
		t.Fatalf("EnrollForUser() owner = %q, want %q", enrollment.Host.OwnerUserID, ownerID)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanupHostRegistration(cleanupCtx, pool, registration.Host.ID)
		cleanupHostRegistration(cleanupCtx, pool, enrollment.Host.ID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM auth_users WHERE id = ANY($1::text[])`, []string{ownerID, sharedID, foreignID})
	})
	if _, err := service.ConfiguredHostForUser(ctx, foreignID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ConfiguredHostForUser(foreign) error = %v, want ErrNotFound", err)
	}
	if allowed, err := service.CanUse(ctx, sharedID, registration.Host.ID); err != nil || allowed {
		t.Fatalf("CanUse(before share) = (%t, %v), want false", allowed, err)
	}
	if err := service.RevokeCredentialForUser(ctx, sharedID, registration.Host.ID, registration.Credential.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("RevokeCredentialForUser(shared) error = %v, want ErrForbidden", err)
	}
	if _, err := service.GrantShare(ctx, ownerID, registration.Host.ID, ownerID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("GrantShare(owner self) error = %v, want ErrInvalid", err)
	}
	if _, err := service.GrantShare(ctx, foreignID, registration.Host.ID, sharedID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("GrantShare(foreign) error = %v, want ErrForbidden", err)
	}
	share, err := service.GrantShare(ctx, ownerID, registration.Host.ID, sharedID)
	if err != nil {
		t.Fatalf("GrantShare(owner) error = %v", err)
	}
	if share.UserID != sharedID || share.RevokedAt != nil {
		t.Fatalf("GrantShare() = %+v", share)
	}
	if allowed, err := service.CanUse(ctx, sharedID, registration.Host.ID); err != nil || !allowed {
		t.Fatalf("CanUse(after share) = (%t, %v), want true", allowed, err)
	}
	configured, err := service.ConfiguredHostForUser(ctx, sharedID)
	if err != nil || configured.ID != registration.Host.ID {
		t.Fatalf("ConfiguredHostForUser(shared) = (%q, %v), want %q", configured.ID, err, registration.Host.ID)
	}
	visible, err := service.ListForUser(ctx, sharedID)
	if err != nil || len(visible) != 1 || visible[0].Owned {
		t.Fatalf("ListForUser(shared) = (%+v, %v), want one shared Host", visible, err)
	}
	if _, err := service.ListCredentialsForUser(ctx, sharedID, registration.Host.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ListCredentialsForUser(shared) error = %v, want ErrForbidden", err)
	}
	if err := service.RevokeShare(ctx, ownerID, registration.Host.ID, sharedID); err != nil {
		t.Fatalf("RevokeShare(owner) error = %v", err)
	}
	if allowed, err := service.CanUse(ctx, sharedID, registration.Host.ID); err != nil || allowed {
		t.Fatalf("CanUse(after revoke) = (%t, %v), want false", allowed, err)
	}
	if _, err := service.ConfiguredHostForUser(ctx, sharedID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ConfiguredHostForUser(after revoke) error = %v, want ErrNotFound", err)
	}
}

func insertHostTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_users (id, issuer, subject, email, display_name)
		VALUES ($1, 'https://hosts.test', $1, $1 || '@hosts.test', $1)
	`, userID); err != nil {
		t.Fatalf("insert Host test user %q: %v", userID, err)
	}
}

func TestServiceCursorSurvivesDatabaseReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	db := testDB.db

	registration, err := NewService(db.Pool()).Register(ctx, RegisterRequest{Name: "h01 reopen " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		db.Close()
		reopened, openErr := openHostDatabaseWithContext(cleanupCtx, testDB.url)
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

	reopened, err := openHostDatabaseWithContext(ctx, testDB.url)
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

func TestServiceCursorAdmissionBoundsAndHandlerFence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	registration, err := NewService(testDB.db.Pool()).Register(ctx, RegisterRequest{Name: "h01 cursor bounds " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	service := NewService(testDB.db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	if err := service.Checkpoint(ctx, connection, Cursor{
		SessionID: strings.Repeat("s", MaxCursorIDBytes),
		RunID:     strings.Repeat("r", MaxCursorIDBytes),
		Value:     "cursor_boundary",
	}); err != nil {
		t.Fatalf("Checkpoint(boundary) error = %v", err)
	}
	for name, cursor := range map[string]Cursor{
		"session id": {SessionID: strings.Repeat("s", MaxCursorIDBytes+1), Value: "cursor"},
		"run id":     {SessionID: "session", RunID: strings.Repeat("r", MaxCursorIDBytes+1), Value: "cursor"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := service.Checkpoint(ctx, connection, cursor); !errors.Is(err, ErrInvalid) {
				t.Fatalf("Checkpoint() error = %v, want ErrInvalid", err)
			}
		})
	}
	called := false
	if err := service.ProcessEvent(ctx, connection, Cursor{SessionID: "empty_cursor", Value: "   "}, func(context.Context) error {
		called = true
		return nil
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("ProcessEvent(empty cursor) error = %v, want ErrInvalid", err)
	}
	if called {
		t.Fatal("ProcessEvent(empty cursor) ran its handler")
	}
}

func TestServiceProcessEventRejectsNULCursorTextBeforeHandler(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	registration, err := NewService(testDB.db.Pool()).Register(ctx, RegisterRequest{Name: "h01 cursor NUL " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	service := NewService(testDB.db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	baseline := Cursor{SessionID: "会话_日本", RunID: "运行_🚀", Value: "游标_✓"}
	if err := service.Checkpoint(ctx, connection, baseline); err != nil {
		t.Fatalf("Checkpoint(unicode) error = %v", err)
	}

	var baselineCount int
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT count(*) FROM host_cursors WHERE host_id = $1`, registration.Host.ID).Scan(&baselineCount); err != nil {
		t.Fatalf("count baseline cursors: %v", err)
	}
	if baselineCount != 1 {
		t.Fatalf("baseline cursor count = %d, want 1", baselineCount)
	}
	var baselineValue string
	if err := testDB.db.Pool().QueryRow(ctx, `
		SELECT cursor FROM host_cursors
		WHERE host_id = $1 AND session_id = $2 AND run_id = $3
	`, registration.Host.ID, baseline.SessionID, baseline.RunID).Scan(&baselineValue); err != nil {
		t.Fatalf("read baseline cursor: %v", err)
	}

	cases := map[string]Cursor{
		"session id": {SessionID: "会话\x00日本", RunID: baseline.RunID, Value: "cursor_session"},
		"run id":     {SessionID: baseline.SessionID, RunID: "运行\x00🚀", Value: "cursor_run"},
		"value":      {SessionID: baseline.SessionID, RunID: baseline.RunID, Value: "游标\x00✓"},
	}
	for name, cursor := range cases {
		t.Run(name, func(t *testing.T) {
			handlerCalls := 0
			if err := service.ProcessEvent(ctx, connection, cursor, func(context.Context) error {
				handlerCalls++
				return nil
			}); !errors.Is(err, ErrInvalid) {
				t.Fatalf("ProcessEvent() error = %v, want ErrInvalid", err)
			}
			if handlerCalls != 0 {
				t.Fatalf("ProcessEvent() handler calls = %d, want 0", handlerCalls)
			}
			var count int
			if err := testDB.db.Pool().QueryRow(ctx, `SELECT count(*) FROM host_cursors WHERE host_id = $1`, registration.Host.ID).Scan(&count); err != nil {
				t.Fatalf("count cursors after rejection: %v", err)
			}
			if count != baselineCount {
				t.Fatalf("cursor count after rejection = %d, want %d", count, baselineCount)
			}
			var value string
			if err := testDB.db.Pool().QueryRow(ctx, `
				SELECT cursor FROM host_cursors
				WHERE host_id = $1 AND session_id = $2 AND run_id = $3
			`, registration.Host.ID, baseline.SessionID, baseline.RunID).Scan(&value); err != nil {
				t.Fatalf("read cursor after rejection: %v", err)
			}
			if value != baselineValue {
				t.Fatalf("baseline cursor after rejection = %q, want %q", value, baselineValue)
			}
		})
	}
}

func TestServiceCursorAdmissionIsAtomicAtHostLimit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	registration, err := NewService(testDB.db.Pool()).Register(ctx, RegisterRequest{Name: "h01 cursor concurrency " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	service := NewService(testDB.db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	now := time.Now().UTC()
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		SELECT $1, 'seed_' || g::text, '', 'cursor_' || g::text, $2, $3
		FROM generate_series(1, $4) AS g
	`, registration.Host.ID, now, now.Add(time.Hour), MaxResumeCursorCount-1); err != nil {
		t.Fatalf("seed host cursors: %v", err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		i := i
		go func() {
			<-start
			results <- service.Checkpoint(ctx, connection, Cursor{SessionID: fmt.Sprintf("concurrent_%d", i), Value: "cursor"})
		}()
	}
	close(start)
	var successes int
	for i := 0; i < 2; i++ {
		if err := <-results; err == nil {
			successes++
		} else if !errors.Is(err, ErrCursorLimit) {
			t.Fatalf("concurrent Checkpoint() error = %v, want ErrCursorLimit", err)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent Checkpoint() successes = %d, want 1", successes)
	}
	var count int
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT count(*) FROM host_cursors WHERE host_id = $1 AND cursor_retained_until > CURRENT_TIMESTAMP`, registration.Host.ID).Scan(&count); err != nil {
		t.Fatalf("count host cursors: %v", err)
	}
	if count != MaxResumeCursorCount {
		t.Fatalf("unexpired cursor count = %d, want %d", count, MaxResumeCursorCount)
	}
	if err := service.Checkpoint(ctx, connection, Cursor{SessionID: "seed_1", Value: "updated_at_limit"}); err != nil {
		t.Fatalf("Checkpoint(existing at limit) error = %v", err)
	}
	called := false
	if err := service.ProcessEvent(ctx, connection, Cursor{SessionID: "handler_overflow", Value: "cursor"}, func(context.Context) error {
		called = true
		return nil
	}); !errors.Is(err, ErrCursorLimit) {
		t.Fatalf("ProcessEvent(over limit) error = %v, want ErrCursorLimit", err)
	}
	if called {
		t.Fatal("ProcessEvent(over limit) ran its handler")
	}
}

func TestServiceCursorAdmissionReclaimsExpiredPositions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	now := time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC)
	service := NewService(testDB.db.Pool(), Config{Now: func() time.Time { return now }})
	registration, err := service.Register(ctx, RegisterRequest{Name: "h01 cursor expiry capacity " + now.Format("20060102T150405")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		SELECT $1, 'expired_' || g::text, '', 'cursor', $2, $3
		FROM generate_series(1, $4) AS g
	`, registration.Host.ID, now, now.Add(-time.Second), MaxResumeCursorCount); err != nil {
		t.Fatalf("seed expired host cursors: %v", err)
	}
	if err := service.Checkpoint(ctx, connection, Cursor{SessionID: "reclaimed", Value: "cursor"}); err != nil {
		t.Fatalf("Checkpoint() after expiry cleanup error = %v", err)
	}
	var count int
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT count(*) FROM host_cursors WHERE host_id = $1`, registration.Host.ID).Scan(&count); err != nil {
		t.Fatalf("count reclaimed host cursors: %v", err)
	}
	if count != 1 {
		t.Fatalf("cursor count after expiry cleanup = %d, want 1", count)
	}
}

func TestServiceOpenConnectionRefreshesClockAfterHostLockWait(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	start := time.Date(2026, time.October, 25, 0, 0, 0, 0, time.UTC)
	var clockMu sync.Mutex
	clock := start
	now := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return clock
	}
	advance := func(delta time.Duration) {
		clockMu.Lock()
		clock = clock.Add(delta)
		clockMu.Unlock()
	}
	service := NewService(testDB.db.Pool(), Config{CursorRetention: time.Hour, Now: now})
	registration, err := service.Register(ctx, RegisterRequest{Name: "h01 cursor lock wait " + start.Format("20060102T150405")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	first, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection(first) error = %v", err)
	}
	if err := service.Checkpoint(ctx, first, Cursor{SessionID: "lock_wait", Value: "cursor_expires"}); err != nil {
		t.Fatalf("Checkpoint() error = %v", err)
	}

	blocker, err := testDB.db.Pool().Begin(ctx)
	if err != nil {
		t.Fatalf("begin host row blocker: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `
		SELECT connection_generation
		FROM host_registrations
		WHERE id = $1
		FOR UPDATE
	`, registration.Host.ID); err != nil {
		t.Fatalf("lock host row: %v", err)
	}

	result := make(chan struct {
		connection Connection
		err        error
	}, 1)
	openCtx, openCancel := context.WithTimeout(ctx, 10*time.Second)
	defer openCancel()
	go func() {
		connection, openErr := service.OpenConnection(openCtx, credential)
		result <- struct {
			connection Connection
			err        error
		}{connection: connection, err: openErr}
	}()
	if err := waitForHostConnectionLockWaiter(ctx, testDB.db.Pool()); err != nil {
		t.Fatalf("wait for OpenConnection() row lock waiter: %v", err)
	}

	advance(2 * time.Hour)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release host row blocker: %v", err)
	}
	select {
	case opened := <-result:
		if opened.err != nil {
			t.Fatalf("OpenConnection(after lock wait) error = %v", opened.err)
		}
		if len(opened.connection.ResumeCursors) != 0 {
			t.Fatalf("resume cursors after clock advanced during lock wait = %+v, want none", opened.connection.ResumeCursors)
		}
	case <-ctx.Done():
		t.Fatalf("OpenConnection(after lock wait) did not finish: %v", ctx.Err())
	}
}

func TestServiceCursorAdmissionRejectsEscapedRecoveryOverflow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	now := time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC)
	service := NewService(testDB.db.Pool(), Config{Now: func() time.Time { return now }})
	registration, err := service.Register(ctx, RegisterRequest{Name: "h01 cursor escaped budget " + now.Format("20060102T150405")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	retainedUntil := now.Add(time.Hour)
	var seed []Cursor
	var candidate Cursor
	found := false
	buildSeed := func(valueLength int) []Cursor {
		seed = make([]Cursor, MaxResumeCursorCount-1)
		for index := range seed {
			seed[index] = Cursor{
				SessionID:     fmt.Sprintf("seed_%d", index+1),
				Value:         strings.Repeat("x", valueLength),
				ObservedAt:    now,
				RetainedUntil: retainedUntil,
			}
		}
		return seed
	}
	low, high := 1, MaxCursorValueBytes
	for low <= high {
		valueLength := low + (high-low)/2
		seed = buildSeed(valueLength)
		candidate = Cursor{
			SessionID:     "escaped_candidate",
			Value:         strings.Repeat(`\`, MaxCursorValueBytes),
			ObservedAt:    now,
			RetainedUntil: retainedUntil,
		}
		currentSize, sizeErr := recoveryPayloadSize(seed)
		if sizeErr != nil {
			t.Fatalf("recoveryPayloadSize(seed) error = %v", sizeErr)
		}
		withCandidate := make([]Cursor, len(seed)+1)
		copy(withCandidate, seed)
		withCandidate[len(seed)] = candidate
		nextSize, sizeErr := recoveryPayloadSize(withCandidate)
		if sizeErr != nil {
			t.Fatalf("recoveryPayloadSize(candidate) error = %v", sizeErr)
		}
		if currentSize <= MaxRecoveryPayloadBytes && nextSize > MaxRecoveryPayloadBytes {
			found = true
			break
		}
		if currentSize > MaxRecoveryPayloadBytes {
			high = valueLength - 1
		} else {
			low = valueLength + 1
		}
	}
	if !found {
		t.Fatal("could not construct a recovery payload just below the escaped-size budget")
	}
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		SELECT $1, 'seed_' || g::text, '', $2, $3, $4
		FROM generate_series(1, $5) AS g
	`, registration.Host.ID, seed[0].Value, now, retainedUntil, MaxResumeCursorCount-1); err != nil {
		t.Fatalf("seed escaped-size host cursors: %v", err)
	}
	if err := service.Checkpoint(ctx, connection, candidate); !errors.Is(err, ErrCursorRecoveryTooLarge) {
		t.Fatalf("Checkpoint(escaped recovery overflow) error = %v, want ErrCursorRecoveryTooLarge", err)
	}
	var candidateCount int
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT count(*) FROM host_cursors WHERE host_id = $1 AND session_id = $2`, registration.Host.ID, candidate.SessionID).Scan(&candidateCount); err != nil {
		t.Fatalf("count rejected escaped cursor: %v", err)
	}
	if candidateCount != 0 {
		t.Fatalf("rejected escaped cursor rows = %d, want 0", candidateCount)
	}
}

func TestServiceRejectsLegacyOversizedRecoveryFieldsBeforeMaterializing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	now := time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC)
	service := NewService(testDB.db.Pool(), Config{Now: func() time.Time { return now }})
	registration, err := service.Register(ctx, RegisterRequest{Name: "h01 cursor legacy field bound " + now.Format("20060102T150405")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		VALUES ($1, $2, '', 'cursor', $3, $4)
	`, registration.Host.ID, strings.Repeat("s", MaxCursorIDBytes+1), now, now.Add(time.Hour)); err != nil {
		t.Fatalf("seed legacy oversized cursor field: %v", err)
	}
	if _, err := service.OpenConnection(ctx, credential); !errors.Is(err, ErrCursorStateInvalid) {
		t.Fatalf("OpenConnection(legacy oversized field) error = %v, want ErrCursorStateInvalid", err)
	}
	var generation int64
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT connection_generation FROM host_registrations WHERE id = $1`, registration.Host.ID).Scan(&generation); err != nil {
		t.Fatalf("read host generation: %v", err)
	}
	if generation != connection.Generation {
		t.Fatalf("host generation after legacy oversized field rejection = %d, want %d", generation, connection.Generation)
	}
}

func TestServiceRejectsOverfullStoredRecoveryState(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	registration, err := NewService(testDB.db.Pool()).Register(ctx, RegisterRequest{Name: "h01 cursor overfull " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	service := NewService(testDB.db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	now := time.Now().UTC()
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		SELECT $1, 'legacy_' || g::text, '', 'cursor', $2, $3
		FROM generate_series(1, $4) AS g
	`, registration.Host.ID, now, now.Add(time.Hour), MaxResumeCursorCount+1); err != nil {
		t.Fatalf("seed overfull host cursors: %v", err)
	}
	if _, err := service.OpenConnection(ctx, credential); !errors.Is(err, ErrCursorLimit) {
		t.Fatalf("OpenConnection(overfull state) error = %v, want ErrCursorLimit", err)
	}
	var generation int64
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT connection_generation FROM host_registrations WHERE id = $1`, registration.Host.ID).Scan(&generation); err != nil {
		t.Fatalf("read host generation: %v", err)
	}
	if generation != connection.Generation {
		t.Fatalf("host generation after rejected recovery read = %d, want %d", generation, connection.Generation)
	}
}

func TestServiceRejectsOversizedStoredRecoveryState(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	registration, err := NewService(testDB.db.Pool()).Register(ctx, RegisterRequest{Name: "h01 cursor overbudget " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	service := NewService(testDB.db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	connection, err := service.OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	now := time.Now().UTC()
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		SELECT $1, 'legacy_' || g::text, '', $2, $3, $4
		FROM generate_series(1, $5) AS g
	`, registration.Host.ID, strings.Repeat(`\`, 1024), now, now.Add(time.Hour), MaxResumeCursorCount); err != nil {
		t.Fatalf("seed overbudget host cursors: %v", err)
	}
	if _, err := service.OpenConnection(ctx, credential); !errors.Is(err, ErrCursorRecoveryTooLarge) {
		t.Fatalf("OpenConnection(overbudget state) error = %v, want ErrCursorRecoveryTooLarge", err)
	}
	var generation int64
	if err := testDB.db.Pool().QueryRow(ctx, `SELECT connection_generation FROM host_registrations WHERE id = $1`, registration.Host.ID).Scan(&generation); err != nil {
		t.Fatalf("read host generation: %v", err)
	}
	if generation != connection.Generation {
		t.Fatalf("host generation after rejected recovery read = %d, want %d", generation, connection.Generation)
	}
}

func TestServiceCursorLimitSurvivesDatabaseReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	testDB := openHostDatabase(t, ctx)
	registration, err := NewService(testDB.db.Pool()).Register(ctx, RegisterRequest{Name: "h01 cursor reopen limit " + time.Now().UTC().Format("20060102T150405.000000000")})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	service := NewService(testDB.db.Pool())
	credential, err := service.Authenticate(ctx, registration.Token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if _, err := service.OpenConnection(ctx, credential); err != nil {
		t.Fatalf("OpenConnection() error = %v", err)
	}
	now := time.Now().UTC()
	if _, err := testDB.db.Pool().Exec(ctx, `
		INSERT INTO host_cursors (host_id, session_id, run_id, cursor, observed_at, cursor_retained_until)
		SELECT $1, 'reopen_' || g::text, '', 'cursor_' || g::text, $2, $3
		FROM generate_series(1, $4) AS g
	`, registration.Host.ID, now, now.Add(time.Hour), MaxResumeCursorCount); err != nil {
		t.Fatalf("seed reopen host cursors: %v", err)
	}
	testDB.db.Close()
	reopened, err := openHostDatabaseWithContext(ctx, testDB.url)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer reopened.Close()
	reconnected, err := NewService(reopened.Pool()).OpenConnection(ctx, credential)
	if err != nil {
		t.Fatalf("OpenConnection(after reopen) error = %v", err)
	}
	if len(reconnected.ResumeCursors) != MaxResumeCursorCount {
		t.Fatalf("resume cursor count after reopen = %d, want %d", len(reconnected.ResumeCursors), MaxResumeCursorCount)
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

type hostTestDatabase struct {
	db  *database.DB
	url string
}

func openHostDatabase(t *testing.T, ctx context.Context) hostTestDatabase {
	t.Helper()
	config, err := platform.LoadDatabaseConfig()
	if err != nil {
		if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
			t.Skip("LOOMHELM_DATABASE_URL is not set")
		}
		t.Fatalf("load database config: %v", err)
	}
	admin, err := database.Open(ctx, database.Config{URL: config.URL, MinConns: 1, MaxConns: 1})
	if err != nil {
		t.Fatalf("open database admin connection: %v", err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		admin.Close()
		t.Fatalf("generate test schema name: %v", err)
	}
	schema := "hosts_test_" + hex.EncodeToString(suffix)
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Pool().Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatalf("create owned hosts test schema: %v", err)
	}
	var db *database.DB
	t.Cleanup(func() {
		if db != nil {
			db.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Pool().Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop owned hosts test schema: %v", err)
		}
		admin.Close()
	})
	testURL, err := databaseURLWithSearchPath(config.URL, schema)
	if err != nil {
		t.Fatalf("build isolated database URL: %v", err)
	}
	db, err = openHostDatabaseWithContext(ctx, testURL)
	if err != nil {
		t.Fatalf("open host database: %v", err)
	}
	return hostTestDatabase{db: db, url: testURL}
}

func databaseURLWithSearchPath(rawURL, schema string) (string, error) {
	if strings.Contains(rawURL, "://") {
		parsed, err := url.Parse(rawURL)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return strings.TrimSpace(rawURL) + " search_path=" + schema, nil
}

func cleanupHostRegistration(ctx context.Context, pool *pgxpool.Pool, hostID string) {
	if pool == nil {
		return
	}
	_, _ = pool.Exec(ctx, `DELETE FROM host_connections WHERE host_id = $1`, hostID)
	_, _ = pool.Exec(ctx, `DELETE FROM host_credentials WHERE host_id = $1`, hostID)
	_, _ = pool.Exec(ctx, `DELETE FROM host_registrations WHERE id = $1`, hostID)
}

func waitForHostConnectionLockWaiter(ctx context.Context, pool *pgxpool.Pool) error {
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		var count int
		err := pool.QueryRow(waitCtx, `
			SELECT count(*)
			FROM pg_stat_activity
			WHERE state = 'active'
			  AND wait_event IS NOT NULL
			  AND query ILIKE '%FROM host_registrations AS h%'
			  AND query ILIKE '%FOR UPDATE OF h%'
		`).Scan(&count)
		if err == nil && count > 0 {
			return nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return err
			}
			return waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func openHostDatabaseWithContext(ctx context.Context, databaseURL string) (*database.DB, error) {
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
