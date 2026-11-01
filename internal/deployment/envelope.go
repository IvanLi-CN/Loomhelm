package deployment

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var (
	sha40Pattern  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	imagePattern  = regexp.MustCompile(`^[A-Za-z0-9._/:@-]+@sha256:[0-9a-f]{64}$`)
)

// Envelope is the stable deployment-facing projection of candidate schema 2.
// The original candidate manifest or deployment envelope remains immutable and
// is stored as ManifestJSON for later evidence and reconciliation; deployment
// never rebuilds its artifact.
type Envelope struct {
	SchemaVersion  int             `json:"schema_version"`
	CandidateID    string          `json:"candidate_id"`
	EnvelopeDigest string          `json:"envelope_digest,omitempty"`
	SourceSHA      string          `json:"source_sha"`
	ArtifactDigest string          `json:"artifact_digest"`
	WebDigest      string          `json:"web_digest"`
	ServerImage    string          `json:"server_image,omitempty"`
	WorkerImage    string          `json:"worker_image,omitempty"`
	StateVersion   int64           `json:"state_version"`
	ReadMin        int64           `json:"read_min"`
	ReadMax        int64           `json:"read_max"`
	MigrationMode  string          `json:"migration_mode"`
	ManifestJSON   json.RawMessage `json:"manifest"`
}

type candidateManifestV2 struct {
	SchemaVersion int `json:"schema_version"`
	Candidate     struct {
		Digest    string `json:"digest"`
		SourceSHA string `json:"source_sha"`
	} `json:"candidate"`
	Artifacts struct {
		Web struct {
			SHA256 string `json:"sha256"`
		} `json:"web"`
	} `json:"artifacts"`
	Deployment *struct {
		StateVersion  int64  `json:"state_version"`
		ReadMin       int64  `json:"read_min"`
		ReadMax       int64  `json:"read_max"`
		MigrationMode string `json:"migration_mode"`
	} `json:"deployment"`
}

type deploymentCompatibility struct {
	StateVersion  int64  `json:"state_version"`
	ReadMin       int64  `json:"read_min"`
	ReadMax       int64  `json:"read_max"`
	MigrationMode string `json:"migration_mode"`
}

type deploymentEnvelopeJSON struct {
	SchemaVersion     int64                   `json:"schema_version"`
	CandidateManifest json.RawMessage         `json:"candidate_manifest"`
	Compatibility     deploymentCompatibility `json:"compatibility"`
	Runtime           struct {
		ServerImage string `json:"server_image"`
		WorkerImage string `json:"worker_image"`
	} `json:"runtime"`
	EnvelopeDigest string `json:"envelope_digest"`
}

// ParseCandidateManifest converts an immutable candidate schema 2 manifest to
// the deployment envelope. A deployment block is required so compatibility is
// explicit and cannot be guessed from the binary or the current database.
func ParseCandidateManifest(data []byte) (Envelope, error) {
	return parseCandidateManifest(data, nil)
}

// ParseDeploymentEnvelope reads the separate deployment envelope generated
// from a schema 2 candidate. Keeping compatibility outside the build manifest
// lets the existing candidate verifier remain unchanged while the controller
// still receives an explicit compatibility contract.
func ParseDeploymentEnvelope(data []byte) (Envelope, error) {
	var envelope deploymentEnvelopeJSON
	if err := json.Unmarshal(data, &envelope); err != nil || envelope.SchemaVersion != 1 || len(envelope.CandidateManifest) == 0 {
		return Envelope{}, fmt.Errorf("%w: deployment envelope schema_version must be 1 and candidate_manifest is required", ErrInvalidCandidate)
	}
	parsed, err := parseCandidateManifest(envelope.CandidateManifest, &envelope.Compatibility)
	if err != nil {
		return Envelope{}, err
	}
	parsed.ServerImage = strings.TrimSpace(envelope.Runtime.ServerImage)
	parsed.WorkerImage = strings.TrimSpace(envelope.Runtime.WorkerImage)
	if envelope.EnvelopeDigest != "" && envelope.EnvelopeDigest != "sha256:"+parsed.Fingerprint() {
		return Envelope{}, fmt.Errorf("%w: deployment envelope digest does not match its identity", ErrInvalidCandidate)
	}
	parsed.EnvelopeDigest = envelope.EnvelopeDigest
	parsed.ManifestJSON = append(json.RawMessage(nil), data...)
	return parsed, nil
}

func parseCandidateManifest(data []byte, externalCompatibility *deploymentCompatibility) (Envelope, error) {
	if len(bytes.TrimSpace(data)) == 0 || !json.Valid(data) {
		return Envelope{}, fmt.Errorf("%w: manifest must be valid JSON", ErrInvalidCandidate)
	}
	var manifest candidateManifestV2
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Envelope{}, fmt.Errorf("%w: decode manifest: %v", ErrInvalidCandidate, err)
	}
	if manifest.SchemaVersion != 2 {
		return Envelope{}, fmt.Errorf("%w: candidate schema_version must be 2", ErrInvalidCandidate)
	}
	if !sha40Pattern.MatchString(manifest.Candidate.SourceSHA) {
		return Envelope{}, fmt.Errorf("%w: candidate source_sha must be 40 lowercase hexadecimal characters", ErrInvalidCandidate)
	}
	if len(manifest.Candidate.Digest) != 64 || !isLowerHex(manifest.Candidate.Digest) {
		return Envelope{}, fmt.Errorf("%w: candidate digest must be 64 lowercase hexadecimal characters", ErrInvalidCandidate)
	}
	artifactDigest := "sha256:" + manifest.Candidate.Digest
	webDigest := "sha256:" + strings.TrimSpace(manifest.Artifacts.Web.SHA256)
	if !digestPattern.MatchString(webDigest) {
		return Envelope{}, fmt.Errorf("%w: Web artifact digest is invalid", ErrInvalidCandidate)
	}
	compatibility := externalCompatibility
	if compatibility == nil && manifest.Deployment != nil {
		compatibility = &deploymentCompatibility{
			StateVersion:  manifest.Deployment.StateVersion,
			ReadMin:       manifest.Deployment.ReadMin,
			ReadMax:       manifest.Deployment.ReadMax,
			MigrationMode: manifest.Deployment.MigrationMode,
		}
	}
	if compatibility == nil {
		return Envelope{}, fmt.Errorf("%w: deployment compatibility block is required", ErrInvalidCandidate)
	}
	if compatibility.StateVersion <= 0 || compatibility.ReadMin <= 0 || compatibility.ReadMax < compatibility.ReadMin || compatibility.StateVersion < compatibility.ReadMin || compatibility.StateVersion > compatibility.ReadMax {
		return Envelope{}, fmt.Errorf("%w: deployment compatibility range is invalid", ErrInvalidCandidate)
	}
	if compatibility.MigrationMode == "" {
		compatibility.MigrationMode = "none"
	}
	if compatibility.MigrationMode != "none" && compatibility.MigrationMode != "expand" {
		return Envelope{}, fmt.Errorf("%w: migration_mode must be none or expand", ErrInvalidCandidate)
	}
	return Envelope{
		SchemaVersion:  2,
		CandidateID:    manifest.Candidate.Digest,
		SourceSHA:      manifest.Candidate.SourceSHA,
		ArtifactDigest: artifactDigest,
		WebDigest:      webDigest,
		StateVersion:   compatibility.StateVersion,
		ReadMin:        compatibility.ReadMin,
		ReadMax:        compatibility.ReadMax,
		MigrationMode:  compatibility.MigrationMode,
		ManifestJSON:   append(json.RawMessage(nil), data...),
	}, nil
}

func (e Envelope) Fingerprint() string {
	identity := fmt.Sprintf("%s:%s:%s:%s:%d:%d:%d:%s:%s:%s", e.CandidateID, e.SourceSHA, e.ArtifactDigest, e.WebDigest, e.StateVersion, e.ReadMin, e.ReadMax, e.MigrationMode, strings.TrimSpace(e.ServerImage), strings.TrimSpace(e.WorkerImage))
	digest := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(digest[:])
}

func validImageReference(value string) bool {
	return imagePattern.MatchString(strings.TrimSpace(value))
}

func isLowerHex(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}
