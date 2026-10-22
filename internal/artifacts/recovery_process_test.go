package artifacts

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
	"github.com/jackc/pgx/v5"
)

func TestArtifactProcessHelper(t *testing.T) {
	mode := os.Getenv("LOOMHELM_ARTIFACT_HELPER")
	if mode == "" {
		return
	}
	databaseURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	root := os.Getenv("LOOMHELM_ARTIFACT_ROOT")
	id := os.Getenv("LOOMHELM_ARTIFACT_ID")
	contentEncoded := os.Getenv("LOOMHELM_ARTIFACT_CONTENT")
	content, err := base64.StdEncoding.DecodeString(contentEncoded)
	if err != nil {
		fmt.Fprintf(os.Stderr, "decode helper content: %v\n", err)
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		cancel()
		fmt.Fprintf(os.Stderr, "open helper database: %v\n", err)
		os.Exit(2)
	}
	if err := db.Migrate(ctx); err != nil {
		cancel()
		fmt.Fprintf(os.Stderr, "migrate helper database: %v\n", err)
		os.Exit(2)
	}
	faults := &faultHooks{}
	if mode == "crash" {
		crash := func() { os.Exit(91) }
		switch faultPoint(os.Getenv("LOOMHELM_ARTIFACT_FAULT")) {
		case faultAfterStage:
			faults.AfterStage = crash
		case faultAfterIntentCommit:
			faults.AfterIntentCommit = crash
		case faultAfterRepairIntentCommit:
			faults.AfterRepairIntentCommit = crash
		case faultAfterFinalLink:
			faults.AfterFinalLink = crash
		case faultAfterFinalPublication:
			faults.AfterFinalPublication = crash
		case faultAfterReadyCommit:
			faults.AfterReadyCommit = crash
		default:
			cancel()
			fmt.Fprintln(os.Stderr, "unknown helper crash point")
			os.Exit(2)
		}
	}
	if mode == "pause-repair" || mode == "pause-recovery" || mode == "pause-put" {
		pauseAfterRepairIntent := mode == "pause-repair" && faultPoint(os.Getenv("LOOMHELM_ARTIFACT_FAULT")) == faultAfterRepairIntentCommit
		pauseSignal := "locked"
		if pauseAfterRepairIntent {
			pauseSignal = "intent-committed"
		}
		pause := func() {
			signal := os.Getenv("LOOMHELM_ARTIFACT_SIGNAL")
			release := os.Getenv("LOOMHELM_ARTIFACT_RELEASE")
			timeoutSignal := os.Getenv("LOOMHELM_ARTIFACT_TIMEOUT_SIGNAL")
			if signal != "" {
				_ = os.WriteFile(signal, []byte(pauseSignal), 0o600)
			}
			deadline := time.Now().Add(20 * time.Second)
			for {
				if _, statErr := os.Stat(release); statErr == nil {
					return
				}
				if time.Now().After(deadline) {
					if timeoutSignal != "" {
						_ = os.WriteFile(timeoutSignal, []byte("pause-timeout"), 0o600)
					}
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		if pauseAfterRepairIntent {
			faults.AfterRepairIntentCommit = pause
		} else {
			faults.AfterIdentityLock = pause
		}
	}
	if mode == "repair-attempt" || mode == "put-attempt" {
		faults.BeforeIdentityLock = func(lockCtx context.Context, tx pgx.Tx, _ string) {
			var pid int32
			if err := tx.QueryRow(lockCtx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				signal := os.Getenv("LOOMHELM_ARTIFACT_SIGNAL")
				if signal != "" {
					_ = os.WriteFile(signal, []byte("error: "+err.Error()), 0o600)
				}
				fmt.Fprintf(os.Stderr, "identity lock pid: %v\n", err)
				os.Exit(2)
			}
			if signal := os.Getenv("LOOMHELM_ARTIFACT_SIGNAL"); signal != "" {
				_ = os.WriteFile(signal, []byte("attempt"), 0o600)
			}
			if signal := os.Getenv("LOOMHELM_ARTIFACT_PID_SIGNAL"); signal != "" {
				_ = os.WriteFile(signal, []byte(strconv.Itoa(int(pid))), 0o600)
			}
		}
	}
	store, err := NewStore(db.Pool(), Config{Root: root, Authorizer: allowAllAuthorizer{}, faults: faults})
	if err != nil {
		cancel()
		fmt.Fprintf(os.Stderr, "create helper store: %v\n", err)
		os.Exit(2)
	}
	if mode == "recover" {
		faults.BeforeIdentityLock = func(lockCtx context.Context, tx pgx.Tx, _ string) {
			if signal := os.Getenv("LOOMHELM_ARTIFACT_SIGNAL"); signal != "" {
				_ = os.WriteFile(signal, []byte("attempt"), 0o600)
			}
			if signal := os.Getenv("LOOMHELM_ARTIFACT_PID_SIGNAL"); signal != "" {
				var pid int32
				if err := tx.QueryRow(lockCtx, `SELECT pg_backend_pid()`).Scan(&pid); err == nil {
					_ = os.WriteFile(signal, []byte(strconv.Itoa(int(pid))), 0o600)
				}
			}
		}
		_, _, err := store.reconcileOneForRecovery(ctx, id, nil)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "helper Recover: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if mode == "pause-recovery" {
		_, _, err := store.reconcileOne(ctx, id, nil)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "helper reconcile: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	artifact := testArtifact(id, nil, content)
	if runID := os.Getenv("LOOMHELM_ARTIFACT_RUN_ID"); runID != "" {
		artifact.RunID = &runID
	}
	_, err = store.Put(ctx, artifact, readCloser(bytes.NewReader(content)))
	cancel()
	if err != nil {
		if errors.Is(err, ErrConflict) {
			os.Exit(42)
		}
		fmt.Fprintf(os.Stderr, "helper Put: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestStoreRecoversAfterProcessCrashBoundaries(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	points := []faultPoint{faultAfterStage, faultAfterIntentCommit, faultAfterFinalLink, faultAfterFinalPublication, faultAfterReadyCommit}
	for _, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root := t.TempDir()
			id := uniqueID("artifact-crash")
			content := []byte("process crash boundary content")
			runID := "run-" + id
			if code, output := runArtifactHelper(t, "crash", point, root, id, content, runID); code != 91 {
				t.Fatalf("helper exit code = %d, output = %s", code, output)
			}
			db, store, ctx := openStoreAtRoot(t, root)
			defer db.Close()
			if point == faultAfterStage {
				if _, err := store.Recover(ctx, MaxRecoveryLimit); err != nil {
					t.Fatal(err)
				}
				if _, err := store.Metadata(ctx, id); !errors.Is(err, ErrNotFound) {
					t.Fatalf("staging-only metadata error = %v, want %v", err, ErrNotFound)
				}
				if _, err := os.Stat(filepath.Join(store.objects, id)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("staging-only final object error = %v, want missing", err)
				}
				assertHasStagingFiles(t, store.objects)
				return
			}
			_, err := store.Recover(ctx, MaxRecoveryLimit)
			if err != nil {
				t.Fatalf("recovery error = %v", err)
			}
			metadata, reader, err := store.Open(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			readBack, err := io.ReadAll(reader)
			_ = reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			expected := testArtifact(id, &runID, content)
			if metadata.ID != id || metadata.SessionID != expected.SessionID || !sameOptionalID(metadata.RunID, expected.RunID) || !bytes.Equal(readBack, content) {
				t.Fatalf("recovered publication = %#v/%q", metadata, readBack)
			}
			assertNoStagingFiles(t, store.objects)
		})
	}
}

func TestStoreConcurrentProcessesConvergeAndProtectConflicts(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	root := t.TempDir()
	id := uniqueID("artifact-concurrent")
	content := []byte("concurrent immutable content")
	holderSignal := filepath.Join(root, "writer-locked")
	holderRelease := filepath.Join(root, "writer-release")
	t.Cleanup(func() { _ = os.WriteFile(holderRelease, []byte("release"), 0o600) })
	holder := newArtifactHelper(t, "pause-put", "", root, id, content)
	holder.Env = append(holder.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+holderSignal,
		"LOOMHELM_ARTIFACT_RELEASE="+holderRelease,
	)
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, holderSignal, "locked")

	contenderSignal := filepath.Join(root, "writer-contender-blocked")
	contenderPIDSignal := filepath.Join(root, "writer-contender-pid")
	probeDB, _, probeCtx := openStoreAtRoot(t, root)
	defer probeDB.Close()
	contender := newArtifactHelper(t, "put-attempt", "", root, id, content)
	var contenderOutput bytes.Buffer
	contender.Stdout = &contenderOutput
	contender.Stderr = &contenderOutput
	contender.Env = append(contender.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+contenderSignal,
		"LOOMHELM_ARTIFACT_PID_SIGNAL="+contenderPIDSignal,
	)
	if err := contender.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, contenderSignal, "attempt")
	waitForBlockedPID(t, probeDB, probeCtx, contenderPIDSignal)
	if err := os.WriteFile(holderRelease, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := holder.Wait(); err != nil {
		t.Fatalf("held writer failed: %v", err)
	}
	if err := contender.Wait(); err != nil {
		t.Fatalf("contending writer failed: %v, output=%s", err, contenderOutput.String())
	}

	db, store, ctx := openStoreAtRoot(t, root)
	defer db.Close()
	metadata, reader, err := store.Open(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	if metadata.ID != id || !bytes.Equal(readBack, content) {
		t.Fatalf("concurrent publication = %#v/%q", metadata, readBack)
	}
	assertNoStagingFiles(t, store.objects)

	conflict := newArtifactHelper(t, "put", "", root, id, []byte("conflicting content"))
	var output bytes.Buffer
	conflict.Stdout = &output
	conflict.Stderr = &output
	if err := conflict.Run(); err == nil {
		t.Fatal("conflicting helper unexpectedly succeeded")
	} else if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 42 {
		t.Fatalf("conflicting helper error = %v, output = %s", err, output.String())
	}
}

func TestStoreConcurrentProcessesRejectDifferentContentForOneID(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	root := t.TempDir()
	id := uniqueID("artifact-concurrent-conflict")
	winnerContent := []byte("first concurrent content")
	conflictContent := []byte("second concurrent content")
	holderSignal := filepath.Join(root, "conflict-writer-locked")
	holderRelease := filepath.Join(root, "conflict-writer-release")
	t.Cleanup(func() { _ = os.WriteFile(holderRelease, []byte("release"), 0o600) })
	holder := newArtifactHelper(t, "pause-put", "", root, id, winnerContent)
	holder.Env = append(holder.Env, "LOOMHELM_ARTIFACT_SIGNAL="+holderSignal, "LOOMHELM_ARTIFACT_RELEASE="+holderRelease)
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, holderSignal, "locked")

	contenderSignal := filepath.Join(root, "conflict-writer-attempt")
	contenderPIDSignal := filepath.Join(root, "conflict-writer-pid")
	probeDB, _, probeCtx := openStoreAtRoot(t, root)
	defer probeDB.Close()
	contender := newArtifactHelper(t, "put-attempt", "", root, id, conflictContent)
	var contenderOutput bytes.Buffer
	contender.Stdout = &contenderOutput
	contender.Stderr = &contenderOutput
	contender.Env = append(contender.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+contenderSignal,
		"LOOMHELM_ARTIFACT_PID_SIGNAL="+contenderPIDSignal,
	)
	if err := contender.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, contenderSignal, "attempt")
	waitForBlockedPID(t, probeDB, probeCtx, contenderPIDSignal)
	if err := os.WriteFile(holderRelease, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := holder.Wait(); err != nil {
		t.Fatalf("winning writer failed: %v", err)
	}
	if err := contender.Wait(); err == nil {
		t.Fatal("conflicting writer unexpectedly succeeded")
	} else if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 42 {
		t.Fatalf("conflicting writer error = %v, output=%s", err, contenderOutput.String())
	}

	db, store, ctx := openStoreAtRoot(t, root)
	defer db.Close()
	metadata, reader, err := store.Open(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != id || !bytes.Equal(readBack, winnerContent) {
		t.Fatalf("concurrent conflict publication = %#v/%q, err=%v", metadata, readBack, err)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreRepairsMissingStagingAfterProcessInterruption(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	root := t.TempDir()
	id := uniqueID("artifact-repair-crash")
	content := []byte("repair crash boundary content")
	db, store, ctx := openStoreAtRoot(t, root)
	artifact := testArtifact(id, nil, content)
	oldStagingName := ".upload-repair-crash-old"
	insertUnavailableArtifact(t, store, ctx, artifact, oldStagingName, "staging-missing")
	db.Close()
	if code, output := runArtifactHelper(t, "crash", faultAfterRepairIntentCommit, root, id, content, ""); code != 91 {
		t.Fatalf("repair helper exit code = %d, output = %s", code, output)
	}

	db, store, ctx = openStoreAtRoot(t, root)
	defer db.Close()
	var queued int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM conversation_artifact_staging_cleanup WHERE staging_name = $1`, oldStagingName).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("repair interruption cleanup debt rows = %d, want 1", queued)
	}
	report, err := store.Recover(ctx, MaxRecoveryLimit)
	if err != nil {
		t.Fatalf("repair recovery error = %v, report = %#v", err, report)
	}
	var state string
	var reclaimed bool
	if err := db.Pool().QueryRow(ctx, `
		SELECT state, staging_reclaimed_at IS NOT NULL
		FROM conversation_artifacts
		WHERE id = $1
	`, id).Scan(&state, &reclaimed); err != nil {
		t.Fatal(err)
	}
	if state != string(publicationReady) || !reclaimed {
		t.Fatalf("repair recovery artifact = state %q/reclaimed %v, want ready/reclaimed", state, reclaimed)
	}
	metadata, reader, err := store.Open(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != id || !bytes.Equal(readBack, content) {
		t.Fatalf("repaired publication = %#v/%q, err=%v", metadata, readBack, err)
	}
}

func TestStoreConcurrentRepairAndRecoveryConverge(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	root := t.TempDir()
	id := uniqueID("artifact-repair-concurrent")
	content := []byte("concurrent repair content")
	db, store, ctx := openStoreAtRoot(t, root)
	artifact := testArtifact(id, nil, content)
	insertUnavailableArtifact(t, store, ctx, artifact, ".upload-original", "staging-missing")
	db.Close()

	signal := filepath.Join(root, "repair-started")
	release := filepath.Join(root, "repair-release")
	timeoutSignal := filepath.Join(root, "repair-pause-timeout")
	repair := newArtifactHelper(t, "pause-repair", faultAfterRepairIntentCommit, root, id, content)
	repair.Env = append(repair.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+signal,
		"LOOMHELM_ARTIFACT_RELEASE="+release,
		"LOOMHELM_ARTIFACT_TIMEOUT_SIGNAL="+timeoutSignal,
	)
	if err := repair.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, signal, "intent-committed")
	t.Cleanup(func() {
		_ = os.WriteFile(release, []byte("release"), 0o600)
		if repair.Process != nil {
			_ = repair.Process.Kill()
		}
	})
	recoverySignal := filepath.Join(root, "recovery-started")
	recovery := newArtifactHelper(t, "recover", "", root, id, content)
	recovery.Env = append(recovery.Env, "LOOMHELM_ARTIFACT_SIGNAL="+recoverySignal)
	if err := recovery.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if recovery.Process != nil {
			_ = recovery.Process.Kill()
		}
	})
	waitForFile(t, recoverySignal)
	if _, err := os.Stat(release); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("repair release marker = %v, want absent while recovery attempts", err)
	}
	if _, err := os.Stat(timeoutSignal); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("repair pause timeout marker = %v, want absent while recovery attempts", err)
	}
	if err := os.WriteFile(release, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := repair.Wait(); err != nil {
		t.Fatalf("repair helper failed: %v", err)
	}
	if err := recovery.Wait(); err != nil {
		t.Fatalf("recovery helper failed: %v", err)
	}

	db, store, ctx = openStoreAtRoot(t, root)
	defer db.Close()
	metadata, reader, err := store.Open(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != id || !bytes.Equal(readBack, content) {
		t.Fatalf("concurrent repair publication = %#v/%q, err=%v", metadata, readBack, err)
	}
	assertNoStagingFiles(t, store.objects)
}

func TestStoreRepairAndRecoveryContendOnIdentityLock(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	root := t.TempDir()
	id := uniqueID("artifact-repair-lock")
	content := []byte("repair identity lock content")
	db, _, ctx := openStoreAtRoot(t, root)
	artifact := testArtifact(id, nil, content)
	insertPendingArtifact(t, db.Pool(), ctx, artifact, ".upload-missing")

	recoverySignal := filepath.Join(root, "recovery-locked")
	recoveryRelease := filepath.Join(root, "recovery-release")
	recovery := newArtifactHelper(t, "pause-recovery", "", root, id, content)
	var recoveryOutput bytes.Buffer
	recovery.Stdout = &recoveryOutput
	recovery.Stderr = &recoveryOutput
	recovery.Env = append(recovery.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+recoverySignal,
		"LOOMHELM_ARTIFACT_RELEASE="+recoveryRelease,
	)
	t.Cleanup(func() { _ = os.WriteFile(recoveryRelease, []byte("release"), 0o600) })
	if err := recovery.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, recoverySignal, "locked")
	probe, err := db.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var acquired bool
	if err := probe.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, "loomhelm:artifact:"+id).Scan(&acquired); err != nil {
		_ = probe.Rollback(ctx)
		t.Fatal(err)
	}
	_ = probe.Rollback(ctx)
	if acquired {
		t.Fatal("recovery helper did not hold the expected identity lock")
	}

	repairSignal := filepath.Join(root, "repair-attempt")
	repairPIDSignal := filepath.Join(root, "repair-attempt-pid")
	repair := newArtifactHelper(t, "repair-attempt", "", root, id, content)
	var repairOutput bytes.Buffer
	repair.Stdout = &repairOutput
	repair.Stderr = &repairOutput
	repair.Env = append(repair.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+repairSignal,
		"LOOMHELM_ARTIFACT_PID_SIGNAL="+repairPIDSignal,
	)
	if err := repair.Start(); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, repairSignal, "attempt")
	waitForBlockedPID(t, db, ctx, repairPIDSignal)
	if err := os.WriteFile(recoveryRelease, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := recovery.Wait(); err != nil {
		t.Fatalf("recovery helper failed: %v, output=%s", err, recoveryOutput.String())
	}
	if err := repair.Wait(); err != nil {
		t.Fatalf("repair helper failed: %v, output=%s", err, repairOutput.String())
	}

	db, store, ctx := openStoreAtRoot(t, root)
	defer db.Close()
	metadata, reader, err := store.Open(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || metadata.ID != id || !bytes.Equal(readBack, content) {
		t.Fatalf("identity-lock convergence = %#v/%q, err=%v", metadata, readBack, err)
	}
	assertNoStagingFiles(t, store.objects)
}

func runArtifactHelper(t *testing.T, mode string, point faultPoint, root, id string, content []byte, runID string) (int, string) {
	t.Helper()
	command := newArtifactHelper(t, mode, point, root, id, content)
	if runID != "" {
		command.Env = append(command.Env, "LOOMHELM_ARTIFACT_RUN_ID="+runID)
	}
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	if err == nil {
		return 0, output.String()
	}
	if exitError, ok := err.(*exec.ExitError); ok {
		return exitError.ExitCode(), output.String()
	}
	return -1, output.String() + err.Error()
}

func newArtifactHelper(t *testing.T, mode string, point faultPoint, root, id string, content []byte) *exec.Cmd {
	t.Helper()
	ensureArtifactTestDatabaseClean(t)
	command := exec.Command(os.Args[0], "-test.run=^TestArtifactProcessHelper$", "-test.v=false")
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"LOOMHELM_ARTIFACT_HELPER="+mode,
		"LOOMHELM_ARTIFACT_FAULT="+string(point),
		"LOOMHELM_ARTIFACT_ROOT="+root,
		"LOOMHELM_ARTIFACT_ID="+id,
		"LOOMHELM_ARTIFACT_CONTENT="+base64.StdEncoding.EncodeToString(content),
	)
	command.Env = env
	return command
}

func openStoreAtRoot(t *testing.T, root string) (*database.DB, *Store, context.Context) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL"))
	ensureArtifactTestDatabaseClean(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := database.Open(ctx, database.Config{URL: databaseURL, MinConns: 1, MaxConns: 4})
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	if err := db.Migrate(ctx); err != nil {
		db.Close()
		t.Fatalf("migrate integration database: %v", err)
	}
	store, err := NewStore(db.Pool(), Config{Root: root, Authorizer: allowAllAuthorizer{}})
	if err != nil {
		db.Close()
		t.Fatalf("create integration store: %v", err)
	}
	return db, store, ctx
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForSignal(t *testing.T, path, expected string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var data []byte
	for {
		read, err := os.ReadFile(path)
		if err == nil {
			data = read
			if string(data) == expected {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("signal %s = %q, want %q", path, data, expected)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForBlockedPID(t *testing.T, db *database.DB, ctx context.Context, path string) {
	t.Helper()
	waitForFile(t, path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("backend pid = %q: %v", data, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var blocked bool
		if err := db.Pool().QueryRow(ctx, `SELECT COALESCE(array_length(pg_blocking_pids($1), 1), 0) > 0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("backend pid %d was not observed waiting on an identity lock", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
