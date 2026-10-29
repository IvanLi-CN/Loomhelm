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
)

const (
	MaxContentBytes = 1 << 20
	maxIdentitySize = 256
)

// Draft is the current durable projection. OwnerUserID is intentionally an
// internal field; public adapters expose only the session-scoped content and
// its ordering metadata.
type Draft struct {
	SessionID      string
	OwnerUserID    string
	Content        string
	Revision       int64
	MutationID     string
	ClientID       string
	ClientSequence int64
	UpdatedAt      string
}

// UpdateInput is one complete replacement of the unsent draft. The server
// serializes accepted updates by the Session row lock; that commit order is
// the canonical LWW order and is independent of client wall clocks.
type UpdateInput struct {
	SessionID      string
	OwnerUserID    string
	MutationID     string
	ClientID       string
	ClientSequence int64
	Content        string
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

func applyProjection(current Draft, found bool, input UpdateInput, updatedAt time.Time) (Draft, error) {
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
	revision := int64(1)
	if found {
		revision = current.Revision + 1
	}
	return Draft{
		SessionID:      input.SessionID,
		OwnerUserID:    input.OwnerUserID,
		Content:        input.Content,
		Revision:       revision,
		MutationID:     input.MutationID,
		ClientID:       input.ClientID,
		ClientSequence: input.ClientSequence,
		UpdatedAt:      updatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func consumeProjection(current Draft, found bool, input ConsumeInput, updatedAt time.Time) (Draft, bool, error) {
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
		SessionID:      current.SessionID,
		OwnerUserID:    current.OwnerUserID,
		Content:        "",
		Revision:       current.Revision + 1,
		MutationID:     consumeMutationID(input.CommandID),
		ClientID:       "loomhelm",
		ClientSequence: 0,
		UpdatedAt:      updatedAt.UTC().Format(time.RFC3339Nano),
	}, true, nil
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
	return "consume:" + commandID
}
