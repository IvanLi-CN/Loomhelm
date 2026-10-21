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
	"strings"
	"testing"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/platform/database"
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
	if mode == "pause-repair" {
		faults.AfterRepairIntentCommit = func() {
			signal := os.Getenv("LOOMHELM_ARTIFACT_SIGNAL")
			release := os.Getenv("LOOMHELM_ARTIFACT_RELEASE")
			if signal != "" {
				_ = os.WriteFile(signal, []byte("ready"), 0o600)
			}
			deadline := time.Now().Add(20 * time.Second)
			for {
				if _, statErr := os.Stat(release); statErr == nil || time.Now().After(deadline) {
					return
				}
				time.Sleep(10 * time.Millisecond)
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
		if signal := os.Getenv("LOOMHELM_ARTIFACT_SIGNAL"); signal != "" {
			_ = os.WriteFile(signal, []byte("ready"), 0o600)
		}
		_, err := store.Recover(ctx, 8)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "helper Recover: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	artifact := testArtifact(id, nil, content)
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
	points := []faultPoint{faultAfterStage, faultAfterIntentCommit, faultAfterFinalPublication, faultAfterReadyCommit}
	for _, point := range points {
		t.Run(string(point), func(t *testing.T) {
			root := t.TempDir()
			id := uniqueID("artifact-crash")
			content := []byte("process crash boundary content")
			if code, output := runArtifactHelper(t, "crash", point, root, id, content); code != 91 {
				t.Fatalf("helper exit code = %d, output = %s", code, output)
			}
			db, store, ctx := openStoreAtRoot(t, root)
			defer db.Close()
			if point == faultAfterStage {
				if _, err := store.Recover(ctx, 8); err != nil {
					t.Fatal(err)
				}
				if _, err := store.Metadata(ctx, id); !errors.Is(err, ErrNotFound) {
					t.Fatalf("staging-only metadata error = %v, want %v", err, ErrNotFound)
				}
				if _, err := os.Stat(filepath.Join(store.objects, id)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("staging-only final object error = %v, want missing", err)
				}
				return
			}
			report, err := store.Recover(ctx, 8)
			if err != nil {
				t.Fatalf("recovery error = %v, report = %#v", err, report)
			}
			if point == faultAfterReadyCommit {
				if report.Scanned != 0 {
					t.Fatalf("ready-commit recovery report = %#v, want no pending rows", report)
				}
			} else if report.Ready != 1 {
				t.Fatalf("recovery report = %#v, want one ready publication", report)
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
			if metadata.ID != id || !bytes.Equal(readBack, content) {
				t.Fatalf("recovered publication = %#v/%q", metadata, readBack)
			}
			if point != faultAfterReadyCommit {
				assertNoStagingFiles(t, store.objects)
			}
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
	commands := make([]*exec.Cmd, 0, 2)
	for range 2 {
		commands = append(commands, newArtifactHelper(t, "put", "", root, id, content))
	}
	for _, command := range commands {
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
	}
	for _, command := range commands {
		if err := command.Wait(); err != nil {
			t.Fatalf("concurrent helper failed: %v", err)
		}
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

func TestStoreRepairsMissingStagingAfterProcessInterruption(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LOOMHELM_DATABASE_URL")) == "" {
		t.Skip("LOOMHELM_DATABASE_URL is not set")
	}
	root := t.TempDir()
	id := uniqueID("artifact-repair-crash")
	content := []byte("repair crash boundary content")
	db, store, ctx := openStoreAtRoot(t, root)
	_ = store
	artifact := testArtifact(id, nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, artifact, "staging-missing")
	db.Close()
	if code, output := runArtifactHelper(t, "crash", faultAfterRepairIntentCommit, root, id, content); code != 91 {
		t.Fatalf("repair helper exit code = %d, output = %s", code, output)
	}

	db, store, ctx = openStoreAtRoot(t, root)
	defer db.Close()
	report, err := store.Recover(ctx, 8)
	if err != nil {
		t.Fatalf("repair recovery error = %v, report = %#v", err, report)
	}
	if report.Scanned != 1 || report.Ready != 1 {
		t.Fatalf("repair recovery report = %#v", report)
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
	db, _, ctx := openStoreAtRoot(t, root)
	artifact := testArtifact(id, nil, content)
	insertUnavailableArtifact(t, db.Pool(), ctx, artifact, "staging-missing")
	db.Close()

	signal := filepath.Join(root, "repair-started")
	release := filepath.Join(root, "repair-release")
	repair := newArtifactHelper(t, "pause-repair", faultAfterRepairIntentCommit, root, id, content)
	repair.Env = append(repair.Env,
		"LOOMHELM_ARTIFACT_SIGNAL="+signal,
		"LOOMHELM_ARTIFACT_RELEASE="+release,
	)
	if err := repair.Start(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, signal)
	recoverySignal := filepath.Join(root, "recovery-started")
	recovery := newArtifactHelper(t, "recover", "", root, id, content)
	recovery.Env = append(recovery.Env, "LOOMHELM_ARTIFACT_SIGNAL="+recoverySignal)
	if err := recovery.Start(); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, recoverySignal)
	if err := os.WriteFile(release, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := repair.Wait(); err != nil {
		t.Fatalf("repair helper failed: %v", err)
	}
	if err := recovery.Wait(); err != nil {
		t.Fatalf("recovery helper failed: %v", err)
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
		t.Fatalf("concurrent repair publication = %#v/%q, err=%v", metadata, readBack, err)
	}
	assertNoStagingFiles(t, store.objects)
}

func runArtifactHelper(t *testing.T, mode string, point faultPoint, root, id string, content []byte) (int, string) {
	t.Helper()
	command := newArtifactHelper(t, mode, point, root, id, content)
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
