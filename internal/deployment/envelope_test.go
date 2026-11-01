package deployment

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseCandidateManifestRequiresAndPreservesCompatibility(t *testing.T) {
	manifest := []byte(`{
  "schema_version": 2,
  "candidate": {"digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "source_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
  "artifacts": {"web": {"sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},
  "deployment": {"state_version": 3, "read_min": 2, "read_max": 4, "migration_mode": "expand"}
}`)

	envelope, err := ParseCandidateManifest(manifest)
	if err != nil {
		t.Fatalf("ParseCandidateManifest() error = %v", err)
	}
	if envelope.CandidateID != strings.Repeat("a", 64) || envelope.SourceSHA != strings.Repeat("b", 40) {
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
	manifest := json.RawMessage(`{"schema_version":2,"candidate":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"artifacts":{"web":{"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}}`)
	compatibility := deploymentCompatibility{StateVersion: 1, ReadMin: 1, ReadMax: 1, MigrationMode: "none"}
	identity := strings.Repeat("a", 64) + ":" + strings.Repeat("b", 40) + ":sha256:" + strings.Repeat("a", 64) + ":sha256:" + strings.Repeat("c", 64) + ":1:1:1:none"
	var envelope deploymentEnvelopeJSON
	envelope.SchemaVersion = 1
	envelope.CandidateManifest = manifest
	envelope.Compatibility = compatibility
	parsed := Envelope{CandidateID: strings.Repeat("a", 64), SourceSHA: strings.Repeat("b", 40), ArtifactDigest: "sha256:" + strings.Repeat("a", 64), WebDigest: "sha256:" + strings.Repeat("c", 64), StateVersion: 1, ReadMin: 1, ReadMax: 1, MigrationMode: "none"}
	_ = identity
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
	manifest := []byte(`{"schema_version":2,"candidate":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"artifacts":{"web":{"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},"deployment":{"state_version":2,"read_min":1,"read_max":1,"migration_mode":"expand"}}`)
	if _, err := ParseCandidateManifest(manifest); err == nil || !strings.Contains(err.Error(), "compatibility range") {
		t.Fatalf("ParseCandidateManifest() error = %v, want compatibility range error", err)
	}
}
