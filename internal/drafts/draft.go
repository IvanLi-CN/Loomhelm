// Package drafts owns the durable private shared-draft projection and its
// mutation/consume invariants. Application adapters remain responsible for
// authenticating the caller and authorizing access to the Session.
package drafts

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrInvalidDraft       = errors.New("draft is invalid")
	ErrDraftNotFound      = errors.New("draft is not present in persistence")
	ErrDraftSession       = errors.New("draft session is not present in persistence")
	ErrDraftOwnerConflict = errors.New("draft owner conflicts with persisted state")
	ErrDraftMutation      = errors.New("draft mutation conflicts with persisted state")
	ErrDraftStaleMutation = errors.New("draft mutation is stale")
	ErrDraftRevisionStale = errors.New("draft revision is stale")
	ErrDraftOrderRequired = errors.New("draft modification order is required")
	ErrDraftClockSkew     = errors.New("draft modification clock is too far ahead")
)

const (
	MaxContentBytes = 1 << 20
	maxIdentitySize = 256
)

const maxModificationClockSkew = 5 * time.Minute

// ClockSkewError carries the server clock sample needed for a client to
// recalibrate its HLC and retry without discarding the local draft. The
// application adapter may expose these values as structured conflict details;
// the draft store never accepts the future value merely because it was
// rejected once.
type ClockSkewError struct {
	ServerTime             time.Time
	ObservedPhysicalMillis int64
	MaxFutureSkew          time.Duration
}

func (err *ClockSkewError) Error() string {
	return ErrDraftClockSkew.Error()
}

func (err *ClockSkewError) Unwrap() error {
	return ErrDraftClockSkew
}

// ModificationOrder is a hybrid logical-clock value with a stable client
// tie-break. The physical component helps edits made while disconnected
// converge by their observed wall-clock order; the logical component carries
// causality when a client clock does not advance; ClientID makes concurrent
// equal values converge deterministically. It is not proof of real-world
// edit time when device clocks are skewed or two devices edit offline.
type ModificationOrder struct {
	PhysicalMillis int64
	LogicalCounter int64
	ClientID       string
}

func (order ModificationOrder) IsZero() bool {
	return order.PhysicalMillis == 0 && order.LogicalCounter == 0 && order.ClientID == ""
}

func (order ModificationOrder) Compare(other ModificationOrder) int {
	if order.PhysicalMillis != other.PhysicalMillis {
		if order.PhysicalMillis < other.PhysicalMillis {
			return -1
		}
		return 1
	}
	if order.LogicalCounter != other.LogicalCounter {
		if order.LogicalCounter < other.LogicalCounter {
			return -1
		}
		return 1
	}
	if order.ClientID < other.ClientID {
		return -1
	}
	if order.ClientID > other.ClientID {
		return 1
	}
	return 0
}

func (order ModificationOrder) Equal(other ModificationOrder) bool {
	return order.Compare(other) == 0
}

func (order ModificationOrder) validate() error {
	if order.IsZero() {
		return nil
	}
	if order.PhysicalMillis <= 0 {
		return fmt.Errorf("%w: modification physical time must be positive", ErrInvalidDraft)
	}
	if order.LogicalCounter < 0 {
		return fmt.Errorf("%w: modification logical counter must not be negative", ErrInvalidDraft)
	}
	if err := validateIdentity(order.ClientID, "modification client id"); err != nil {
		return err
	}
	return nil
}

// Draft is the current durable projection. OwnerUserID is intentionally an
// internal field; public adapters expose only the session-scoped content and
// its ordering metadata.
type Draft struct {
	SessionID         string
	OwnerUserID       string
	Content           string
	Revision          int64
	MutationID        string
	ClientID          string
	ClientSequence    int64
	ModificationOrder ModificationOrder
	UpdatedAt         string
}

// UpdateInput is one complete replacement of the unsent draft. New writers
// provide a comparable hybrid logical-clock order; the server still serializes
// the projection by the Session row lock, but arrival order cannot override a
// higher modification order.
type UpdateInput struct {
	SessionID         string
	OwnerUserID       string
	MutationID        string
	ClientID          string
	ClientSequence    int64
	Content           string
	ModificationOrder *ModificationOrder
}

type ConsumeInput struct {
	SessionID        string
	OwnerUserID      string
	ExpectedRevision int64
	CommandID        string
}

type ConsumeResult struct {
	Draft    Draft
	Consumed bool
}

// CommandDraftInput binds one durable run command to the exact draft body
// that the caller put in its command payload. The binding is created in the
// command admission transaction and finalized only after a transport fact or
// a trusted reconciliation result exists.
type CommandDraftInput struct {
	CommandID        string
	SessionID        string
	OwnerUserID      string
	ExpectedRevision int64
	Content          string
}

// CommandDraftState records whether a bound draft was cleared after delivery
// or deliberately retained because the command was not delivered or a newer
// revision replaced it.
type CommandDraftState string

const (
	CommandDraftPending   CommandDraftState = "pending"
	CommandDraftConsumed  CommandDraftState = "consumed"
	CommandDraftPreserved CommandDraftState = "preserved"
)

type CommandDraftResult struct {
	CommandID string
	SessionID string
	State     CommandDraftState
	Draft     Draft
	Bound     bool
	Consumed  bool
}

func (input UpdateInput) validate() error {
	if err := validateIdentity(input.SessionID, "session id"); err != nil {
		return err
	}
	if err := validateIdentity(input.OwnerUserID, "owner user id"); err != nil {
		return err
	}
	if err := validateIdentity(input.MutationID, "mutation id"); err != nil {
		return err
	}
	if strings.HasPrefix(input.MutationID, consumeMutationPrefix) {
		return fmt.Errorf("%w: mutation id uses a reserved consume namespace", ErrInvalidDraft)
	}
	if err := validateIdentity(input.ClientID, "client id"); err != nil {
		return err
	}
	if input.ClientSequence <= 0 {
		return fmt.Errorf("%w: client sequence must be positive", ErrInvalidDraft)
	}
	if !utf8.ValidString(input.Content) {
		return fmt.Errorf("%w: content must be valid UTF-8", ErrInvalidDraft)
	}
	if len([]byte(input.Content)) > MaxContentBytes {
		return fmt.Errorf("%w: content exceeds %d bytes", ErrInvalidDraft, MaxContentBytes)
	}
	if input.ModificationOrder != nil {
		if err := input.ModificationOrder.validate(); err != nil {
			return err
		}
		if input.ModificationOrder.IsZero() || input.ModificationOrder.ClientID != input.ClientID {
			return fmt.Errorf("%w: modification order client id must match client id", ErrInvalidDraft)
		}
	}
	return nil
}

func (input ConsumeInput) validate() error {
	if err := validateIdentity(input.SessionID, "session id"); err != nil {
		return err
	}
	if err := validateIdentity(input.OwnerUserID, "owner user id"); err != nil {
		return err
	}
	if err := validateIdentity(input.CommandID, "command id"); err != nil {
		return err
	}
	if input.ExpectedRevision <= 0 {
		return fmt.Errorf("%w: expected revision must be positive", ErrInvalidDraft)
	}
	return nil
}

func (input CommandDraftInput) validate() error {
	if err := validateIdentity(input.CommandID, "command id"); err != nil {
		return err
	}
	if err := validateIdentity(input.SessionID, "session id"); err != nil {
		return err
	}
	if err := validateIdentity(input.OwnerUserID, "owner user id"); err != nil {
		return err
	}
	if input.ExpectedRevision <= 0 {
		return fmt.Errorf("%w: expected revision must be positive", ErrInvalidDraft)
	}
	if !utf8.ValidString(input.Content) {
		return fmt.Errorf("%w: content must be valid UTF-8", ErrInvalidDraft)
	}
	if len([]byte(input.Content)) > MaxContentBytes {
		return fmt.Errorf("%w: content exceeds %d bytes", ErrInvalidDraft, MaxContentBytes)
	}
	return nil
}

func applyProjection(current Draft, found bool, input UpdateInput, updatedAt time.Time, resolvedOrder ...ModificationOrder) (Draft, error) {
	if err := input.validate(); err != nil {
		return Draft{}, err
	}
	if found {
		if current.SessionID != input.SessionID || current.OwnerUserID != input.OwnerUserID {
			return Draft{}, ErrDraftOwnerConflict
		}
		if current.Revision <= 0 {
			return Draft{}, fmt.Errorf("%w: current revision must be positive", ErrDraftMutation)
		}
	}
	order := ModificationOrder{}
	var err error
	if len(resolvedOrder) > 0 {
		order = resolvedOrder[0]
	} else {
		order, err = resolveModificationOrder(current, input, updatedAt)
		if err != nil {
			return Draft{}, err
		}
	}
	revision := int64(1)
	if found {
		revision = current.Revision + 1
	}
	return Draft{
		SessionID:         input.SessionID,
		OwnerUserID:       input.OwnerUserID,
		Content:           input.Content,
		Revision:          revision,
		MutationID:        input.MutationID,
		ClientID:          input.ClientID,
		ClientSequence:    input.ClientSequence,
		ModificationOrder: order,
		UpdatedAt:         updatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func consumeProjection(current Draft, found bool, input ConsumeInput, updatedAt time.Time, order ModificationOrder) (Draft, bool, error) {
	if err := input.validate(); err != nil {
		return Draft{}, false, err
	}
	if !found {
		return Draft{SessionID: input.SessionID, OwnerUserID: input.OwnerUserID}, false, nil
	}
	if current.SessionID != input.SessionID || current.OwnerUserID != input.OwnerUserID {
		return Draft{}, false, ErrDraftOwnerConflict
	}
	if current.Revision != input.ExpectedRevision {
		return current, false, nil
	}
	return Draft{
		SessionID:         current.SessionID,
		OwnerUserID:       current.OwnerUserID,
		Content:           "",
		Revision:          current.Revision + 1,
		MutationID:        consumeMutationID(input.CommandID),
		ClientID:          "loomhelm",
		ClientSequence:    0,
		ModificationOrder: order,
		UpdatedAt:         updatedAt.UTC().Format(time.RFC3339Nano),
	}, true, nil
}

func resolveModificationOrder(current Draft, input UpdateInput, now time.Time) (ModificationOrder, error) {
	if input.ModificationOrder != nil {
		order := *input.ModificationOrder
		if err := order.validate(); err != nil {
			return ModificationOrder{}, err
		}
		if order.IsZero() || order.ClientID != input.ClientID {
			return ModificationOrder{}, fmt.Errorf("%w: modification order client id must match client id", ErrInvalidDraft)
		}
		if order.PhysicalMillis > now.UnixMilli()+maxModificationClockSkew.Milliseconds() {
			return ModificationOrder{}, &ClockSkewError{
				ServerTime:             now.UTC(),
				ObservedPhysicalMillis: order.PhysicalMillis,
				MaxFutureSkew:          maxModificationClockSkew,
			}
		}
		return order, nil
	}
	if !current.ModificationOrder.IsZero() {
		return ModificationOrder{}, ErrDraftOrderRequired
	}
	return nextModificationOrder(current.ModificationOrder, now, input.ClientID), nil
}

func nextModificationOrder(current ModificationOrder, now time.Time, clientID string) ModificationOrder {
	physicalMillis := now.UnixMilli()
	if physicalMillis <= 0 {
		physicalMillis = 1
	}
	if current.IsZero() || physicalMillis > current.PhysicalMillis {
		return ModificationOrder{PhysicalMillis: physicalMillis, ClientID: clientID}
	}
	return ModificationOrder{
		PhysicalMillis: physicalMillis,
		LogicalCounter: current.LogicalCounter + 1,
		ClientID:       clientID,
	}
}

func validateIdentity(value, label string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalidDraft, label)
	}
	if trimmed != value || strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("%w: %s is malformed", ErrInvalidDraft, label)
	}
	if len(value) > maxIdentitySize {
		return fmt.Errorf("%w: %s is too long", ErrInvalidDraft, label)
	}
	return nil
}

func consumeMutationID(commandID string) string {
	return consumeMutationPrefix + commandID
}

const consumeMutationPrefix = "consume:"
