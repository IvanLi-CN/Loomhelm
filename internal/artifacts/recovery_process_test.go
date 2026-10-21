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
	store, err := NewStore(db.Pool(), Config{Root: root, Authorizer: allowAllAuthorizer{}, faults: faults})
	if err != nil {
		cancel()
		fmt.Fprintf(os.Stderr, "create helper store: %v\n", err)
		os.Exit(2)
	}
	artifact := testArtifact(id, nil, content)
	_, err = store.Put(ctx, artifact, bytes.NewReader(content))
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
