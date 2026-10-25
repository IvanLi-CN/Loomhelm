package runs

import (
	"errors"
	"testing"
)

func TestValidateLeaseIdentityAcceptsOpaqueGeneration(t *testing.T) {
	identity := DurableLeaseIdentity{
		LeaseKey:           "lease-codex",
		SessionID:          "session-codex",
		RunID:              "run-codex",
		Generation:         "generation-codex-2026-10-25T01:02:03Z",
		OwnerID:            "owner-codex",
		CandidateSourceSHA: "source-sha",
		ArtifactDigest:     "artifact-digest",
	}
	if err := validateLeaseIdentity(identity); err != nil {
		t.Fatalf("opaque lease identity rejected: %v", err)
	}
}

func TestValidateLeaseIdentityPreservesInvalidInputChecks(t *testing.T) {
	base := DurableLeaseIdentity{
		LeaseKey:           "lease-codex",
		SessionID:          "session-codex",
		RunID:              "run-codex",
		Generation:         "generation-codex-1",
		OwnerID:            "owner-codex",
		CandidateSourceSHA: "source-sha",
		ArtifactDigest:     "artifact-digest",
	}
	cases := []struct {
		name   string
		mutate func(*DurableLeaseIdentity)
	}{
		{name: "empty generation", mutate: func(identity *DurableLeaseIdentity) { identity.Generation = "" }},
		{name: "surrounding generation whitespace", mutate: func(identity *DurableLeaseIdentity) { identity.Generation = " generation-codex-1" }},
		{name: "empty lease key", mutate: func(identity *DurableLeaseIdentity) { identity.LeaseKey = " " }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			identity := base
			testCase.mutate(&identity)
			if err := validateLeaseIdentity(identity); !errors.Is(err, ErrInvalidLease) {
				t.Fatalf("validation error = %v, want %v", err, ErrInvalidLease)
			}
		})
	}
}
