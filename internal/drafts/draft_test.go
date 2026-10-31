package drafts

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestUpdateInputValidationAllowsExactContent(t *testing.T) {
	input := UpdateInput{
		SessionID:      "session-1",
		OwnerUserID:    "user-1",
		MutationID:     "mutation-1",
		ClientID:       "browser-1",
		ClientSequence: 1,
		Content:        "  keep whitespace\n",
	}
	if err := input.validate(); err != nil {
		t.Fatalf("UpdateInput.validate() error = %v", err)
	}
}

func TestUpdateInputValidationRejectsOversizeAndNonPositiveSequence(t *testing.T) {
	base := UpdateInput{SessionID: "session-1", OwnerUserID: "user-1", MutationID: "mutation-1", ClientID: "browser-1", ClientSequence: 1}
	oversize := base
	oversize.Content = strings.Repeat("x", MaxContentBytes+1)
	if err := oversize.validate(); !errors.Is(err, ErrInvalidDraft) {
		t.Fatalf("oversize validation error = %v, want ErrInvalidDraft", err)
	}

	stale := base
	stale.ClientSequence = 0
	if err := stale.validate(); !errors.Is(err, ErrInvalidDraft) {
		t.Fatalf("stale sequence validation error = %v, want ErrInvalidDraft", err)
	}
}

func TestUpdateInputValidationRejectsReservedConsumeMutationIDs(t *testing.T) {
	input := UpdateInput{
		SessionID:      "session-1",
		OwnerUserID:    "user-1",
		MutationID:     "consume:command-1",
		ClientID:       "browser-1",
		ClientSequence: 1,
	}
	if err := input.validate(); !errors.Is(err, ErrInvalidDraft) {
		t.Fatalf("reserved mutation ID validation error = %v, want ErrInvalidDraft", err)
	}
}

func TestConsumeMutationIDIsCommandScoped(t *testing.T) {
	if got, want := consumeMutationID("command-1"), "consume:command-1"; got != want {
		t.Fatalf("consumeMutationID() = %q, want %q", got, want)
	}
	if got := consumeMutationID("command-1"); got == consumeMutationID("command-2") {
		t.Fatal("different command IDs must not share a consume mutation ID")
	}
}

func TestApplyProjectionUsesDeterministicRevisionOrder(t *testing.T) {
	now := time.Date(2026, 10, 29, 8, 30, 0, 0, time.UTC)
	firstOrder := ModificationOrder{PhysicalMillis: now.UnixMilli(), ClientID: "desktop"}
	first, err := applyProjection(Draft{}, false, UpdateInput{
		SessionID:         "session-1",
		OwnerUserID:       "user-1",
		MutationID:        "mutation-1",
		ClientID:          "desktop",
		ClientSequence:    1,
		Content:           "desktop draft",
		ModificationOrder: &firstOrder,
	}, now)
	if err != nil {
		t.Fatalf("first applyProjection() error = %v", err)
	}
	second, err := applyProjection(first, true, UpdateInput{
		SessionID:         "session-1",
		OwnerUserID:       "user-1",
		MutationID:        "mutation-2",
		ClientID:          "mobile",
		ClientSequence:    1,
		Content:           "mobile draft wins",
		ModificationOrder: &ModificationOrder{PhysicalMillis: now.Add(time.Second).UnixMilli(), ClientID: "mobile"},
	}, now.Add(time.Second))
	if err != nil {
		t.Fatalf("second applyProjection() error = %v", err)
	}
	if second.Revision != 2 || second.Content != "mobile draft wins" || second.ClientID != "mobile" {
		t.Fatalf("second projection = %+v, want revision 2 from mobile", second)
	}
}

func TestConsumeProjectionPreservesNewerInput(t *testing.T) {
	now := time.Date(2026, 10, 29, 8, 30, 0, 0, time.UTC)
	current := Draft{SessionID: "session-1", OwnerUserID: "user-1", Content: "newer input", Revision: 3, MutationID: "mutation-3", ClientID: "mobile", ClientSequence: 2, ModificationOrder: ModificationOrder{PhysicalMillis: now.UnixMilli(), ClientID: "mobile"}}
	consumeOrder := ModificationOrder{PhysicalMillis: now.Add(time.Second).UnixMilli(), ClientID: "loomhelm"}
	unchanged, consumed, err := consumeProjection(current, true, ConsumeInput{SessionID: "session-1", OwnerUserID: "user-1", ExpectedRevision: 2, CommandID: "command-1"}, now, consumeOrder)
	if err != nil {
		t.Fatalf("stale consume error = %v", err)
	}
	if consumed || unchanged != current {
		t.Fatalf("stale consume = %+v, consumed %v; want unchanged current", unchanged, consumed)
	}

	cleared, consumed, err := consumeProjection(current, true, ConsumeInput{SessionID: "session-1", OwnerUserID: "user-1", ExpectedRevision: 3, CommandID: "command-1"}, now, consumeOrder)
	if err != nil {
		t.Fatalf("current consume error = %v", err)
	}
	if !consumed || cleared.Content != "" || cleared.Revision != 4 || cleared.MutationID != "consume:command-1" {
		t.Fatalf("current consume = %+v, consumed %v; want cleared revision 4", cleared, consumed)
	}
}

func TestModificationOrderUsesStableTieBreak(t *testing.T) {
	base := ModificationOrder{PhysicalMillis: 100, LogicalCounter: 2, ClientID: "desktop"}
	if got := base.Compare(ModificationOrder{PhysicalMillis: 100, LogicalCounter: 2, ClientID: "mobile"}); got >= 0 {
		t.Fatalf("desktop order compare = %d, want negative stable tie-break", got)
	}
	if !base.Equal(base) {
		t.Fatal("a modification order must equal itself")
	}
}

func TestNextModificationOrderPreservesFuturePhysicalComponent(t *testing.T) {
	now := time.UnixMilli(100)
	current := ModificationOrder{PhysicalMillis: 200, LogicalCounter: 3, ClientID: "desktop"}
	next := nextModificationOrder(current, now, "loomhelm")
	if next.PhysicalMillis != current.PhysicalMillis || next.LogicalCounter != current.LogicalCounter+1 || next.ClientID != "loomhelm" {
		t.Fatalf("next order = %+v, want physical %d and logical %d", next, current.PhysicalMillis, current.LogicalCounter+1)
	}
}

func TestResolveModificationOrderRejectsLegacyFallbackAndFutureClock(t *testing.T) {
	now := time.Date(2026, 10, 30, 8, 30, 0, 0, time.UTC)
	input := UpdateInput{SessionID: "session-1", OwnerUserID: "user-1", MutationID: "mutation-1", ClientID: "desktop", ClientSequence: 1, Content: "draft"}
	current := Draft{ModificationOrder: ModificationOrder{PhysicalMillis: now.UnixMilli(), ClientID: "mobile"}}
	if _, err := resolveModificationOrder(current, input, now); !errors.Is(err, ErrDraftOrderRequired) {
		t.Fatalf("missing order error = %v, want ErrDraftOrderRequired", err)
	}

	future := ModificationOrder{PhysicalMillis: now.Add(maxModificationClockSkew + time.Millisecond).UnixMilli(), ClientID: "desktop"}
	input.ModificationOrder = &future
	_, err := resolveModificationOrder(Draft{}, input, now)
	if !errors.Is(err, ErrDraftClockSkew) {
		t.Fatalf("future order error = %v, want ErrDraftClockSkew", err)
	}
	var clockSkew *ClockSkewError
	if !errors.As(err, &clockSkew) || !clockSkew.ServerTime.Equal(now) || clockSkew.MaxFutureSkew != maxModificationClockSkew {
		t.Fatalf("future order error details = %+v, want server time and bound", clockSkew)
	}
}
