package deployment

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseCandidateManifestRequiresAndPreservesCompatibility(t *testing.T) {
	manifest := validEnvelopeCandidateManifest(t, true)

	envelope, err := ParseCandidateManifest(manifest)
	if err != nil {
		t.Fatalf("ParseCandidateManifest() error = %v", err)
	}
	if envelope.CandidateID == "" || envelope.SourceSHA != strings.Repeat("b", 40) {
		t.Fatalf("unexpected identity: %+v", envelope)
	}
	if envelope.WebDigest != "sha256:"+strings.Repeat("c", 64) || envelope.MigrationMode != "expand" || envelope.ReadMin != 2 || envelope.ReadMax != 4 {
		t.Fatalf("unexpected compatibility: %+v", envelope)
	}
	if envelope.Fingerprint() == "" || len(envelope.Fingerprint()) != 64 {
		t.Fatalf("unexpected fingerprint: %q", envelope.Fingerprint())
	}
}

func TestParseDeploymentEnvelopeUsesExternalCompatibilityAndDigest(t *testing.T) {
	manifest := json.RawMessage(validEnvelopeCandidateManifest(t, false))
	compatibility := deploymentCompatibility{StateVersion: 1, ReadMin: 1, ReadMax: 1, MigrationMode: "none"}
	var envelope deploymentEnvelopeJSON
	envelope.SchemaVersion = 1
	envelope.CandidateManifest = manifest
	envelope.Compatibility = compatibility
	var parsedManifest candidateManifestV2
	if err := json.Unmarshal(manifest, &parsedManifest); err != nil {
		t.Fatal(err)
	}
	parsed := Envelope{CandidateID: parsedManifest.Candidate.Digest, SourceSHA: parsedManifest.Candidate.SourceSHA, ArtifactDigest: "sha256:" + parsedManifest.Candidate.Digest, WebDigest: "sha256:" + parsedManifest.Artifacts.Web.SHA256, StateVersion: 1, ReadMin: 1, ReadMax: 1, MigrationMode: "none"}
	envelope.EnvelopeDigest = "sha256:" + parsed.Fingerprint()
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseDeploymentEnvelope(data)
	if err != nil {
		t.Fatalf("ParseDeploymentEnvelope() error = %v", err)
	}
	if got.StateVersion != 1 || got.MigrationMode != "none" || string(got.ManifestJSON) != string(data) {
		t.Fatalf("unexpected parsed envelope: %+v", got)
	}
}

func TestParseCandidateManifestRejectsInvalidCompatibility(t *testing.T) {
	manifest := validEnvelopeCandidateManifest(t, true)
	var decoded map[string]any
	if err := json.Unmarshal(manifest, &decoded); err != nil {
		t.Fatal(err)
	}
	decoded["deployment"] = map[string]any{"state_version": 2, "read_min": 1, "read_max": 1, "migration_mode": "expand"}
	manifest, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseCandidateManifest(manifest); err == nil || !strings.Contains(err.Error(), "compatibility range") {
		t.Fatalf("ParseCandidateManifest() error = %v, want compatibility range error", err)
	}
}

func validEnvelopeCandidateManifest(t *testing.T, includeDeployment bool) []byte {
	t.Helper()
	manifest := map[string]any{
		"schema_version": 2,
		"candidate": map[string]any{
			"digest":            strings.Repeat("0", 64),
			"source_sha":        strings.Repeat("b", 40),
			"source_tree_sha":   strings.Repeat("d", 40),
			"source_date_epoch": int64(1700000000),
		},
		"platform": map[string]any{"goos": "linux", "goarch": "amd64", "cgo_enabled": false},
		"inputs":   map[string]any{"build_contract": "candidate-v2"},
		"artifacts": map[string]any{
			"server":    map[string]any{"path": "bin/server", "sha256": strings.Repeat("1", 64), "size": 1, "mode": 493},
			"worker":    map[string]any{"path": "bin/worker", "sha256": strings.Repeat("2", 64), "size": 1, "mode": 493},
			"connector": map[string]any{"path": "bin/connector", "sha256": strings.Repeat("3", 64), "size": 1, "mode": 493},
			"web":       map[string]any{"path": "web", "sha256": strings.Repeat("c", 64), "files": []any{}},
		},
	}
	if includeDeployment {
		manifest["deployment"] = map[string]any{"state_version": 3, "read_min": 2, "read_max": 4, "migration_mode": "expand"}
	}
	withoutDigest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := canonicalCandidateDigest(withoutDigest)
	if err != nil {
		t.Fatal(err)
	}
	manifest["candidate"].(map[string]any)["digest"] = digest
	result, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
