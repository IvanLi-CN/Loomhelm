package connector

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// IdentityState describes the durable evidence available for one run
// correlation. Unknown is terminal until a reconciler supplies new exact
// evidence; it never authorizes a guessed native turn.
type IdentityState string

const (
	IdentityStatePending IdentityState = "pending"
	IdentityStateBound   IdentityState = "bound"
	IdentityStateUnknown IdentityState = "unknown"
)

var (
	ErrIdentityConflict = errors.New("durable execution identity conflicts with an existing binding")
	ErrIdentityNotFound = errors.New("durable execution identity is not present")
)

// SessionAlias is the private, durable relationship between the platform
// session and one host-owned adapter session. The two session identities are
// intentionally separate. CommandID is the caller identity that authorized
// the creation; legacy records cannot populate it and therefore cannot be
// used as a new creation result.
type SessionAlias struct {
	PlatformSessionID string `json:"platform_session_id"`
	AdapterSessionID  string `json:"adapter_session_id"`
	ExternalThreadRef string `json:"external_thread_ref"`
	Generation        string `json:"generation"`
	CommandID         string `json:"command_id"`
	UpdatedAt         string `json:"updated_at"`
	Revision          int64  `json:"revision"`
}

// RunBinding is the private, durable relationship between a platform run and
// the exact native operation that produced it. NativeTurnID and
// NativeOperationID are evidence, never substitutes for PlatformRunID.
type RunBinding struct {
	PlatformSessionID string        `json:"platform_session_id"`
	PlatformRunID     string        `json:"platform_run_id"`
	CommandID         string        `json:"command_id"`
	AdapterSessionID  string        `json:"adapter_session_id"`
	ExternalThreadRef string        `json:"external_thread_ref"`
	Generation        string        `json:"generation"`
	NativeTurnID      string        `json:"native_turn_id,omitempty"`
	NativeOperationID string        `json:"native_operation_id,omitempty"`
	State             IdentityState `json:"state"`
	UpdatedAt         string        `json:"updated_at"`
}

// EventObservation identifies the adapter-side facts attached to one raw
// event. A materialized event is exposed only after the journal finds an
// exact SessionAlias and, for run-scoped observations, an exact RunBinding.
type EventObservation struct {
	AdapterSessionID  string `json:"adapter_session_id"`
	ExternalThreadRef string `json:"external_thread_ref"`
	Generation        string `json:"generation"`
	NativeTurnID      string `json:"native_turn_id,omitempty"`
	NativeOperationID string `json:"native_operation_id,omitempty"`
}

type journalObservedEvent struct {
	Event       protocol.Event   `json:"event"`
	Observation EventObservation `json:"observation"`
}

func normalizeSessionAlias(alias SessionAlias) (SessionAlias, error) {
	alias.PlatformSessionID = normalizeIdentityPart(alias.PlatformSessionID)
	alias.AdapterSessionID = normalizeIdentityPart(alias.AdapterSessionID)
	alias.ExternalThreadRef = normalizeIdentityPart(alias.ExternalThreadRef)
	alias.Generation = normalizeIdentityPart(alias.Generation)
	alias.CommandID = normalizeIdentityPart(alias.CommandID)
	if err := requireIdentityParts("session alias", alias.PlatformSessionID, alias.AdapterSessionID, alias.ExternalThreadRef, alias.Generation, alias.CommandID); err != nil {
		return SessionAlias{}, err
	}
	if alias.Revision < 0 {
		return SessionAlias{}, errors.New("session alias revision must not be negative")
	}
	if alias.Revision == 0 {
		alias.Revision = 1
	}
	if alias.UpdatedAt == "" {
		alias.UpdatedAt = now()
	}
	return alias, nil
}

func normalizeRunBinding(binding RunBinding) (RunBinding, error) {
	binding.PlatformSessionID = normalizeIdentityPart(binding.PlatformSessionID)
	binding.PlatformRunID = normalizeIdentityPart(binding.PlatformRunID)
	binding.CommandID = normalizeIdentityPart(binding.CommandID)
	binding.AdapterSessionID = normalizeIdentityPart(binding.AdapterSessionID)
	binding.ExternalThreadRef = normalizeIdentityPart(binding.ExternalThreadRef)
	binding.Generation = normalizeIdentityPart(binding.Generation)
	binding.NativeTurnID = normalizeIdentityPart(binding.NativeTurnID)
	binding.NativeOperationID = normalizeIdentityPart(binding.NativeOperationID)
	if err := requireIdentityParts("run binding", binding.PlatformSessionID, binding.PlatformRunID, binding.CommandID, binding.AdapterSessionID, binding.ExternalThreadRef, binding.Generation); err != nil {
		return RunBinding{}, err
	}
	if binding.State == "" {
		switch {
		case binding.NativeTurnID != "":
			binding.State = IdentityStateBound
		case binding.NativeOperationID != "":
			binding.State = IdentityStatePending
		default:
			binding.State = IdentityStateUnknown
		}
	}
	switch binding.State {
	case IdentityStateUnknown:
		if binding.NativeTurnID != "" || binding.NativeOperationID != "" {
			return RunBinding{}, errors.New("unknown run binding must not carry native evidence")
		}
	case IdentityStatePending:
		if binding.NativeOperationID == "" || binding.NativeTurnID != "" {
			return RunBinding{}, errors.New("pending run binding requires only native operation identity")
		}
	case IdentityStateBound:
		if binding.NativeTurnID == "" {
			return RunBinding{}, errors.New("bound run binding requires native turn identity")
		}
	default:
		return RunBinding{}, fmt.Errorf("unknown run binding state %q", binding.State)
	}
	if binding.UpdatedAt == "" {
		binding.UpdatedAt = now()
	}
	return binding, nil
}

func normalizeEventObservation(observation EventObservation) (EventObservation, error) {
	observation.AdapterSessionID = normalizeIdentityPart(observation.AdapterSessionID)
	observation.ExternalThreadRef = normalizeIdentityPart(observation.ExternalThreadRef)
	observation.Generation = normalizeIdentityPart(observation.Generation)
	observation.NativeTurnID = normalizeIdentityPart(observation.NativeTurnID)
	observation.NativeOperationID = normalizeIdentityPart(observation.NativeOperationID)
	if err := requireIdentityParts("event observation", observation.AdapterSessionID, observation.ExternalThreadRef, observation.Generation); err != nil {
		return EventObservation{}, err
	}
	return observation, nil
}

func normalizeIdentityPart(value string) string {
	return strings.TrimSpace(value)
}

func requireIdentityParts(kind string, values ...string) error {
	for _, value := range values {
		if value == "" {
			return fmt.Errorf("%s identity is incomplete", kind)
		}
		if strings.ContainsRune(value, '\x00') {
			return fmt.Errorf("%s identity contains a NUL separator", kind)
		}
	}
	return nil
}

func identityTupleKey(values ...string) string {
	return strings.Join(values, "\x00")
}

func sessionAliasKey(alias SessionAlias) string {
	return identityTupleKey(alias.AdapterSessionID, alias.ExternalThreadRef, alias.Generation)
}

func runBindingPlatformKey(binding RunBinding) string {
	return identityTupleKey(binding.PlatformSessionID, binding.PlatformRunID)
}

func runBindingNativeTurnKey(binding RunBinding) string {
	if binding.NativeTurnID == "" {
		return ""
	}
	return identityTupleKey(binding.AdapterSessionID, binding.ExternalThreadRef, binding.Generation, binding.NativeTurnID)
}

func runBindingNativeOperationKey(binding RunBinding) string {
	if binding.NativeOperationID == "" {
		return ""
	}
	return identityTupleKey(binding.AdapterSessionID, binding.ExternalThreadRef, binding.Generation, binding.NativeOperationID)
}

func sameSessionAlias(left, right SessionAlias) bool {
	return sameSessionAliasIdentity(left, right) &&
		sessionAliasRevision(left) == sessionAliasRevision(right)
}

func sameSessionAliasIdentity(left, right SessionAlias) bool {
	return left.PlatformSessionID == right.PlatformSessionID &&
		left.AdapterSessionID == right.AdapterSessionID &&
		left.ExternalThreadRef == right.ExternalThreadRef &&
		left.Generation == right.Generation &&
		left.CommandID == right.CommandID
}

func sessionAliasRevision(alias SessionAlias) int64 {
	if alias.Revision == 0 {
		return 1
	}
	return alias.Revision
}

func sameRunBindingBase(left, right RunBinding) bool {
	return left.PlatformSessionID == right.PlatformSessionID &&
		left.PlatformRunID == right.PlatformRunID &&
		left.CommandID == right.CommandID &&
		left.AdapterSessionID == right.AdapterSessionID &&
		left.ExternalThreadRef == right.ExternalThreadRef &&
		left.Generation == right.Generation
}

func identityStateRank(state IdentityState) int {
	switch state {
	case IdentityStateUnknown:
		return 0
	case IdentityStatePending:
		return 1
	case IdentityStateBound:
		return 2
	default:
		return -1
	}
}

func mergeRunBinding(existing, incoming RunBinding) (RunBinding, bool, error) {
	if !sameRunBindingBase(existing, incoming) {
		return RunBinding{}, false, ErrIdentityConflict
	}
	if existing.NativeTurnID != "" && incoming.NativeTurnID != "" && existing.NativeTurnID != incoming.NativeTurnID {
		return RunBinding{}, false, ErrIdentityConflict
	}
	if existing.NativeOperationID != "" && incoming.NativeOperationID != "" && existing.NativeOperationID != incoming.NativeOperationID {
		return RunBinding{}, false, ErrIdentityConflict
	}
	if identityStateRank(incoming.State) < identityStateRank(existing.State) {
		return RunBinding{}, false, ErrIdentityConflict
	}
	merged := existing
	if merged.NativeTurnID == "" {
		merged.NativeTurnID = incoming.NativeTurnID
	}
	if merged.NativeOperationID == "" {
		merged.NativeOperationID = incoming.NativeOperationID
	}
	if identityStateRank(incoming.State) > identityStateRank(existing.State) {
		merged.State = incoming.State
	}
	if merged.State == IdentityStatePending && merged.NativeOperationID == "" {
		return RunBinding{}, false, ErrIdentityConflict
	}
	if merged.State == IdentityStateBound && merged.NativeTurnID == "" {
		return RunBinding{}, false, ErrIdentityConflict
	}
	if merged.NativeTurnID == existing.NativeTurnID && merged.NativeOperationID == existing.NativeOperationID && merged.State == existing.State {
		return existing, false, nil
	}
	merged.UpdatedAt = incoming.UpdatedAt
	return merged, true, nil
}

// RecordSessionAlias durably records one explicit platform-to-adapter session
// relationship. The record is fsynced before its exact indexes are changed.
// Repeating the same relationship is idempotent; changing any identity is a
// conflict. It never consumes a legacy adapter-only session as a platform ID.
func (j *Journal) RecordSessionAlias(alias SessionAlias) error {
	alias, err := normalizeSessionAlias(alias)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.recordSessionAliasLocked(alias)
}

func (j *Journal) recordSessionAliasLocked(alias SessionAlias) error {
	if existing, ok := j.sessionAliases[alias.PlatformSessionID]; ok {
		if sameSessionAlias(existing, alias) {
			return nil
		}
		return ErrIdentityConflict
	}
	if alias.Revision != 1 {
		return fmt.Errorf("%w: initial session alias revision must be 1", ErrIdentityConflict)
	}
	if existingPlatform, ok := j.sessionAliasByAdapter[sessionAliasKey(alias)]; ok && existingPlatform != alias.PlatformSessionID {
		return ErrIdentityConflict
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "session_alias",
		At:            alias.UpdatedAt,
		SessionAlias:  &alias,
	}); err != nil {
		return err
	}
	j.indexSessionAliasLocked(alias)
	return nil
}

// RotateSessionAlias records a confirmed cold-recovery generation for an
// existing platform session. Historical aliases remain indexed so old runs
// and observations continue to resolve against their original generation.
func (j *Journal) RotateSessionAlias(alias SessionAlias) error {
	alias, err := normalizeSessionAlias(alias)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	existing, ok := j.sessionAliases[alias.PlatformSessionID]
	if !ok {
		return fmt.Errorf("%w: session alias %q", ErrIdentityNotFound, alias.PlatformSessionID)
	}
	if alias.AdapterSessionID != existing.AdapterSessionID || alias.ExternalThreadRef != existing.ExternalThreadRef || alias.CommandID != existing.CommandID {
		return ErrIdentityConflict
	}
	if alias.Generation == existing.Generation {
		if sameSessionAliasIdentity(existing, alias) {
			return nil
		}
		return ErrIdentityConflict
	}
	if alias.Revision == 1 {
		alias.Revision = existing.Revision + 1
	} else if alias.Revision != existing.Revision+1 {
		return fmt.Errorf("%w: expected session alias revision %d, got %d", ErrIdentityConflict, existing.Revision+1, alias.Revision)
	}
	if existingPlatform, ok := j.sessionAliasByAdapter[sessionAliasKey(alias)]; ok && existingPlatform != alias.PlatformSessionID {
		return ErrIdentityConflict
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "session_alias",
		At:            alias.UpdatedAt,
		SessionAlias:  &alias,
	}); err != nil {
		return err
	}
	j.indexSessionAliasLocked(alias)
	return nil
}

func (j *Journal) indexSessionAliasLocked(alias SessionAlias) {
	j.sessionAliases[alias.PlatformSessionID] = alias
	j.sessionAliasByAdapter[sessionAliasKey(alias)] = alias.PlatformSessionID
	j.sessionAliasByTuple[sessionAliasKey(alias)] = alias
}

func (j *Journal) applySessionAliasLoadedLocked(alias SessionAlias) error {
	if existing, ok := j.sessionAliasByTuple[sessionAliasKey(alias)]; ok {
		if sameSessionAlias(existing, alias) {
			return nil
		}
		return fmt.Errorf("%w: conflicting session alias tuple %q", ErrJournalCorrupt, sessionAliasKey(alias))
	}
	if current, ok := j.sessionAliases[alias.PlatformSessionID]; ok {
		if alias.Revision != current.Revision+1 || alias.AdapterSessionID != current.AdapterSessionID || alias.ExternalThreadRef != current.ExternalThreadRef || alias.CommandID != current.CommandID || alias.Generation == current.Generation {
			return fmt.Errorf("%w: invalid session alias revision %d for %q", ErrJournalCorrupt, alias.Revision, alias.PlatformSessionID)
		}
	} else if alias.Revision != 1 {
		return fmt.Errorf("%w: initial session alias revision must be 1", ErrJournalCorrupt)
	}
	if existingPlatform, ok := j.sessionAliasByAdapter[sessionAliasKey(alias)]; ok && existingPlatform != alias.PlatformSessionID {
		return fmt.Errorf("%w: adapter session identity maps to multiple platform sessions", ErrJournalCorrupt)
	}
	j.indexSessionAliasLocked(alias)
	return nil
}

// SessionAlias returns only an explicit platform mapping. Legacy adapter-only
// session records are intentionally absent from this lookup.
func (j *Journal) SessionAlias(platformSessionID string) (SessionAlias, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	alias, ok := j.sessionAliases[strings.TrimSpace(platformSessionID)]
	return cloneSessionAlias(alias), ok
}

// SessionAliases returns explicit mappings in stable platform identity order.
func (j *Journal) SessionAliases() []SessionAlias {
	j.mu.Lock()
	defer j.mu.Unlock()
	values := make([]SessionAlias, 0, len(j.sessionAliases))
	for _, alias := range j.sessionAliases {
		values = append(values, cloneSessionAlias(alias))
	}
	return sortSessionAliases(values)
}

// SessionAliasForAdapter resolves an adapter session only with the complete
// thread and generation tuple. A reused adapter session ID by itself is not a
// sufficient lookup key.
func (j *Journal) SessionAliasForAdapter(adapterSessionID, externalThreadRef, generation string) (SessionAlias, bool) {
	key := identityTupleKey(normalizeIdentityPart(adapterSessionID), normalizeIdentityPart(externalThreadRef), normalizeIdentityPart(generation))
	j.mu.Lock()
	defer j.mu.Unlock()
	platformSessionID, ok := j.sessionAliasByAdapter[key]
	if !ok {
		return SessionAlias{}, false
	}
	alias, ok := j.sessionAliasByTuple[key]
	if !ok || alias.PlatformSessionID != platformSessionID {
		return SessionAlias{}, false
	}
	return cloneSessionAlias(alias), ok
}

// SessionAliasForAdapterSession resolves the current platform mapping for a
// stable adapter session and thread when a recovery path no longer has the old
// generation available as an input.
func (j *Journal) SessionAliasForAdapterSession(adapterSessionID, externalThreadRef string) (SessionAlias, bool) {
	adapterSessionID = normalizeIdentityPart(adapterSessionID)
	externalThreadRef = normalizeIdentityPart(externalThreadRef)
	j.mu.Lock()
	defer j.mu.Unlock()
	var found SessionAlias
	for _, alias := range j.sessionAliases {
		if alias.AdapterSessionID != adapterSessionID || alias.ExternalThreadRef != externalThreadRef {
			continue
		}
		if found.PlatformSessionID != "" && found.PlatformSessionID != alias.PlatformSessionID {
			return SessionAlias{}, false
		}
		found = alias
	}
	return cloneSessionAlias(found), found.PlatformSessionID != ""
}

// LegacySessionFacts exposes only the facts recoverable from old session
// records. Empty platform and command identities are deliberate and must not
// be filled by a caller from prompt, thread proximity or active-turn state.
func (j *Journal) LegacySessionFacts() []SessionAlias {
	j.mu.Lock()
	defer j.mu.Unlock()
	values := make([]SessionAlias, 0, len(j.legacySessionFacts))
	for _, fact := range j.legacySessionFacts {
		values = append(values, cloneSessionAlias(fact))
	}
	return sortSessionAliases(values)
}

// RecordRunBinding durably records or advances one platform-to-native run
// relationship. A pending or unknown relationship may be advanced only by
// exact native evidence. Native turn/operation indexes are qualified by the
// adapter session, external thread and generation, so reused native IDs do
// not cross generations.
func (j *Journal) RecordRunBinding(binding RunBinding) error {
	binding, err := normalizeRunBinding(binding)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.recordRunBindingLocked(binding)
}

func (j *Journal) recordRunBindingLocked(binding RunBinding) error {
	alias, ok := j.sessionAliasByTuple[sessionAliasKeyFromRunBinding(binding)]
	if !ok {
		return fmt.Errorf("%w: session alias %q", ErrIdentityNotFound, binding.PlatformSessionID)
	}
	if alias.PlatformSessionID != binding.PlatformSessionID {
		return ErrIdentityConflict
	}
	platformKey := runBindingPlatformKey(binding)
	if existing, ok := j.runBindings[platformKey]; ok {
		merged, changed, err := mergeRunBinding(existing, binding)
		if err != nil {
			return err
		}
		if !changed {
			return nil
		}
		if err := j.checkRunBindingIndexesLocked(merged, platformKey); err != nil {
			return err
		}
		if err := j.appendLocked(journalRecord{
			FormatVersion: journalFormatVersion,
			Type:          "run_binding",
			At:            merged.UpdatedAt,
			RunBinding:    &merged,
		}); err != nil {
			return err
		}
		j.removeRunBindingIndexesLocked(existing)
		j.indexRunBindingLocked(merged)
		return nil
	}
	if err := j.checkRunBindingIndexesLocked(binding, platformKey); err != nil {
		return err
	}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "run_binding",
		At:            binding.UpdatedAt,
		RunBinding:    &binding,
	}); err != nil {
		return err
	}
	j.indexRunBindingLocked(binding)
	return nil
}

func (j *Journal) checkRunBindingIndexesLocked(binding RunBinding, platformKey string) error {
	if existing, ok := j.runBindingByCommand[binding.CommandID]; ok && existing != platformKey {
		return ErrIdentityConflict
	}
	if key := runBindingNativeTurnKey(binding); key != "" {
		if existing, ok := j.runBindingByNativeTurn[key]; ok && existing != platformKey {
			return ErrIdentityConflict
		}
	}
	if key := runBindingNativeOperationKey(binding); key != "" {
		if existing, ok := j.runBindingByNativeOperation[key]; ok && existing != platformKey {
			return ErrIdentityConflict
		}
	}
	return nil
}

func (j *Journal) indexRunBindingLocked(binding RunBinding) {
	platformKey := runBindingPlatformKey(binding)
	j.runBindings[platformKey] = binding
	j.runBindingByCommand[binding.CommandID] = platformKey
	if key := runBindingNativeTurnKey(binding); key != "" {
		j.runBindingByNativeTurn[key] = platformKey
	}
	if key := runBindingNativeOperationKey(binding); key != "" {
		j.runBindingByNativeOperation[key] = platformKey
	}
}

func (j *Journal) applyRunBindingLoadedLocked(binding RunBinding) error {
	alias, ok := j.sessionAliasByTuple[sessionAliasKeyFromRunBinding(binding)]
	if !ok {
		return fmt.Errorf("%w: run binding %q has no session alias", ErrJournalCorrupt, runBindingPlatformKey(binding))
	}
	if alias.PlatformSessionID != binding.PlatformSessionID {
		return fmt.Errorf("%w: run binding %q disagrees with session alias", ErrJournalCorrupt, runBindingPlatformKey(binding))
	}
	platformKey := runBindingPlatformKey(binding)
	if existing, ok := j.runBindings[platformKey]; ok {
		merged, changed, err := mergeRunBinding(existing, binding)
		if err != nil {
			return fmt.Errorf("%w: conflicting run binding %q", ErrJournalCorrupt, platformKey)
		}
		if !changed {
			return nil
		}
		if err := j.checkRunBindingIndexesLocked(merged, platformKey); err != nil {
			return fmt.Errorf("%w: %v", ErrJournalCorrupt, err)
		}
		j.removeRunBindingIndexesLocked(existing)
		j.indexRunBindingLocked(merged)
		return nil
	}
	if err := j.checkRunBindingIndexesLocked(binding, platformKey); err != nil {
		return fmt.Errorf("%w: %v", ErrJournalCorrupt, err)
	}
	j.indexRunBindingLocked(binding)
	return nil
}

func (j *Journal) removeRunBindingIndexesLocked(binding RunBinding) {
	platformKey := runBindingPlatformKey(binding)
	delete(j.runBindings, platformKey)
	if existing, ok := j.runBindingByCommand[binding.CommandID]; ok && existing == platformKey {
		delete(j.runBindingByCommand, binding.CommandID)
	}
	if key := runBindingNativeTurnKey(binding); key != "" {
		if existing, ok := j.runBindingByNativeTurn[key]; ok && existing == platformKey {
			delete(j.runBindingByNativeTurn, key)
		}
	}
	if key := runBindingNativeOperationKey(binding); key != "" {
		if existing, ok := j.runBindingByNativeOperation[key]; ok && existing == platformKey {
			delete(j.runBindingByNativeOperation, key)
		}
	}
}

// RunBinding returns the exact platform session/run relationship.
func (j *Journal) RunBinding(platformSessionID, platformRunID string) (RunBinding, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	binding, ok := j.runBindings[identityTupleKey(strings.TrimSpace(platformSessionID), strings.TrimSpace(platformRunID))]
	return cloneRunBinding(binding), ok
}

// RunBindingForCommand resolves one command only when its durable command
// identity maps to exactly one platform run.
func (j *Journal) RunBindingForCommand(commandID string) (RunBinding, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	platformKey, ok := j.runBindingByCommand[strings.TrimSpace(commandID)]
	if !ok {
		return RunBinding{}, false
	}
	binding, ok := j.runBindings[platformKey]
	return cloneRunBinding(binding), ok
}

// RunBindingForNativeTurn resolves a native turn using every identity fact
// that distinguishes one app-server generation from another.
func (j *Journal) RunBindingForNativeTurn(adapterSessionID, externalThreadRef, generation, nativeTurnID string) (RunBinding, bool) {
	key := identityTupleKey(normalizeIdentityPart(adapterSessionID), normalizeIdentityPart(externalThreadRef), normalizeIdentityPart(generation), normalizeIdentityPart(nativeTurnID))
	j.mu.Lock()
	defer j.mu.Unlock()
	platformKey, ok := j.runBindingByNativeTurn[key]
	if !ok {
		return RunBinding{}, false
	}
	binding, ok := j.runBindings[platformKey]
	return cloneRunBinding(binding), ok
}

// RunBindingForNativeOperation is the exact reverse lookup used while an ACK
// is still pending. It can return a pending binding, but never falls back to a
// current or nearest turn.
func (j *Journal) RunBindingForNativeOperation(adapterSessionID, externalThreadRef, generation, nativeOperationID string) (RunBinding, bool) {
	key := identityTupleKey(normalizeIdentityPart(adapterSessionID), normalizeIdentityPart(externalThreadRef), normalizeIdentityPart(generation), normalizeIdentityPart(nativeOperationID))
	j.mu.Lock()
	defer j.mu.Unlock()
	platformKey, ok := j.runBindingByNativeOperation[key]
	if !ok {
		return RunBinding{}, false
	}
	binding, ok := j.runBindings[platformKey]
	return cloneRunBinding(binding), ok
}

// RunBindings returns all durable relationships in stable platform order.
func (j *Journal) RunBindings() []RunBinding {
	j.mu.Lock()
	defer j.mu.Unlock()
	values := make([]RunBinding, 0, len(j.runBindings))
	for _, binding := range j.runBindings {
		values = append(values, cloneRunBinding(binding))
	}
	return sortRunBindings(values)
}

// AppendObservedEvent persists the raw event and its exact adapter-side
// observation. It returns delivered=false and an empty public event until the
// SessionAlias and, when needed, RunBinding are present. The original payload
// is never rewritten or discarded.
func (j *Journal) AppendObservedEvent(event protocol.Event, observation EventObservation) (protocol.Event, bool, error) {
	_, mapped, delivered, err := j.appendObservedEvent(event, observation)
	return mapped, delivered, err
}

// AppendObservedEventWithRecord is the adapter-facing variant of
// AppendObservedEvent. It returns the durable raw record while identity
// materialization is pending, allowing ACKs to carry the journal cursor
// without exposing an unmapped public event.
func (j *Journal) AppendObservedEventWithRecord(event protocol.Event, observation EventObservation) (protocol.Event, bool, error) {
	raw, mapped, delivered, err := j.appendObservedEvent(event, observation)
	if err != nil {
		return protocol.Event{}, false, err
	}
	if delivered {
		return mapped, true, nil
	}
	return raw, false, nil
}

// observedEventObservation returns the durable adapter-side identity for one
// raw observed event without materializing a public platform event.
func (j *Journal) observedEventObservation(eventID string) (EventObservation, bool) {
	if j == nil || strings.TrimSpace(eventID) == "" {
		return EventObservation{}, false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	observed, ok := j.observedEvents[eventID]
	if !ok {
		return EventObservation{}, false
	}
	return observed.Observation, true
}

func (j *Journal) appendObservedEvent(event protocol.Event, observation EventObservation) (protocol.Event, protocol.Event, bool, error) {
	if event.SessionID == "" {
		return protocol.Event{}, protocol.Event{}, false, errors.New("event adapter session id must not be empty")
	}
	observation, err := normalizeEventObservation(observation)
	if err != nil {
		return protocol.Event{}, protocol.Event{}, false, err
	}
	if observation.AdapterSessionID != strings.TrimSpace(event.SessionID) {
		return protocol.Event{}, protocol.Event{}, false, ErrIdentityConflict
	}
	if event.RunID != nil && strings.TrimSpace(*event.RunID) != "" {
		if observation.NativeTurnID != "" && observation.NativeTurnID != strings.TrimSpace(*event.RunID) {
			return protocol.Event{}, protocol.Event{}, false, ErrIdentityConflict
		}
		observation.NativeTurnID = strings.TrimSpace(*event.RunID)
	}
	approvalEvent := cloneEvent(event)
	if observation.NativeTurnID != "" {
		approvalEvent.RunID = stringPointer(observation.NativeTurnID)
	}
	event.RunID = nil

	j.mu.Lock()
	defer j.mu.Unlock()
	if event.EventID != "" {
		if existing, ok := j.observedEvents[event.EventID]; ok {
			if !sameObservedEvent(existing, event, observation) {
				return protocol.Event{}, protocol.Event{}, false, ErrIdentityConflict
			}
			mapped, delivered := j.materializedObservedEventLocked(existing)
			return cloneEvent(existing.Event), mapped, delivered, nil
		}
		if _, exists := j.eventIDs[event.EventID]; exists {
			return protocol.Event{}, protocol.Event{}, false, ErrIdentityConflict
		}
	}
	if len(j.events) >= maxJournalEvents {
		return protocol.Event{}, protocol.Event{}, false, fmt.Errorf("%w: event count exceeds %d", ErrJournalTooLarge, maxJournalEvents)
	}
	if event.OccurredAt == "" {
		event.OccurredAt = now()
	}
	if event.Sequence <= 0 {
		event.Sequence = j.sequenceBySession[event.SessionID] + 1
	}
	if event.Cursor == "" {
		event.Cursor = fmt.Sprintf("%s:%d", event.SessionID, event.Sequence)
	}
	if event.EventID == "" {
		event.EventID = digestString(event.SessionID + "\x00" + event.Cursor + "\x00" + string(event.Payload))
	}
	observed := journalObservedEvent{Event: cloneEvent(event), Observation: observation}
	if err := j.appendLocked(journalRecord{
		FormatVersion: journalFormatVersion,
		Type:          "observed_event",
		At:            event.OccurredAt,
		ObservedEvent: &observed,
	}); err != nil {
		return protocol.Event{}, protocol.Event{}, false, err
	}
	j.events = append(j.events, cloneEvent(event))
	j.observedEvents[event.EventID] = observed
	j.eventIndexByID[event.EventID] = len(j.events) - 1
	if _, exists := j.eventIndexByCursor[event.Cursor]; !exists {
		j.eventIndexByCursor[event.Cursor] = len(j.events) - 1
	}
	j.eventIDs[event.EventID] = struct{}{}
	if event.Sequence > j.sequenceBySession[event.SessionID] {
		j.sequenceBySession[event.SessionID] = event.Sequence
	}
	if approvalEvent.Type == protocol.EventTypeApprovalResolved && (approvalEvent.RunID == nil || strings.TrimSpace(*approvalEvent.RunID) == "") {
		if runID := j.approvalRunIDLocked(approvalEvent); runID != "" {
			approvalEvent.RunID = &runID
		}
	}
	j.updatePendingApprovalLocked(approvalEvent)
	mapped, delivered := j.materializedObservedEventLocked(observed)
	return cloneEvent(event), mapped, delivered, nil
}

// ReadMappedEvents is the identity-safe event read seam. It excludes all raw
// observations that do not have an exact durable mapping and returns platform
// session/run identities only. Existing ReadEvents remains the legacy raw
// journal reader for recovery and compatibility tests.
func (j *Journal) ReadMappedEvents(query protocol.EventQuery) (protocol.EventPage, error) {
	if strings.TrimSpace(query.SessionID) == "" {
		return protocol.EventPage{}, errors.New("mapped event platform session id must not be empty")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	start := 0
	if query.AfterCursor != "" {
		index, found := j.eventIndexByCursor[query.AfterCursor]
		if !found || index < 0 || index >= len(j.events) {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		mapped, ok := j.mappedEventAtLocked(index)
		if !ok {
			if query.RunID != "" || !j.unresolvedEventIsSkippableMappedTelemetryLocked(j.events[index], query.SessionID) {
				return protocol.EventPage{}, protocol.ErrCursorExpired
			}
		} else if mapped.SessionID != query.SessionID || (query.RunID != "" && valueOrEmpty(mapped.RunID) != query.RunID) {
			return protocol.EventPage{}, protocol.ErrCursorExpired
		}
		start = index + 1
	}
	mappedSequence := j.mappedEventCountBeforeLocked(start, query.SessionID)
	limit := query.Limit
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	page := protocol.EventPage{Events: make([]protocol.Event, 0)}
	for index := start; index < len(j.events); index++ {
		mapped, ok := j.mappedEventWithoutSequenceAtLocked(index)
		if !ok {
			if query.RunID == "" && j.unresolvedEventIsSkippableMappedTelemetryLocked(j.events[index], query.SessionID) {
				page.HasMore = true
				next := j.events[index].Cursor
				page.NextCursor = &next
				break
			}
			if query.RunID == "" && j.unresolvedEventBlocksMappedDeliveryLocked(j.events[index], query.SessionID) {
				if len(page.Events) > 0 {
					page.HasMore = true
					last := page.Events[len(page.Events)-1].Cursor
					page.NextCursor = &last
				}
				break
			}
			continue
		}
		if mapped.SessionID != query.SessionID || (query.RunID != "" && valueOrEmpty(mapped.RunID) != query.RunID) {
			if mapped.SessionID == query.SessionID {
				mappedSequence++
			}
			continue
		}
		if int64(len(page.Events)) >= limit {
			page.HasMore = true
			break
		}
		mappedSequence++
		mapped.Sequence = mappedSequence
		page.Events = append(page.Events, mapped)
	}
	if len(page.Events) > 0 && page.HasMore && page.NextCursor == nil {
		last := page.Events[len(page.Events)-1].Cursor
		page.NextCursor = &last
	}
	return page, nil
}

func (j *Journal) unresolvedEventIsSkippableMappedTelemetryLocked(event protocol.Event, platformSessionID string) bool {
	if event.Type != protocol.EventTypeUnknown || !j.unresolvedEventBelongsToPlatformSessionLocked(event, platformSessionID) {
		return false
	}
	observed, ok := j.observedEvents[event.EventID]
	if !ok {
		return false
	}
	if observed.Observation.NativeTurnID == "" && observed.Observation.NativeOperationID == "" {
		return true
	}
	return event.Source == protocol.EventSourceAppServer && isSkippableMappedTelemetry(event.Payload)
}

func isSkippableMappedTelemetry(payload json.RawMessage) bool {
	var envelope struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return false
	}
	switch envelope.Method {
	case "thread/tokenUsage/updated":
		return true
	default:
		return false
	}
}

func (j *Journal) unresolvedEventBlocksMappedDeliveryLocked(event protocol.Event, platformSessionID string) bool {
	if !j.unresolvedEventBelongsToPlatformSessionLocked(event, platformSessionID) {
		return false
	}
	if event.Type != protocol.EventTypeUnknown {
		return true
	}
	observed, ok := j.observedEvents[event.EventID]
	if !ok {
		return true
	}
	return observed.Observation.NativeTurnID != "" || observed.Observation.NativeOperationID != ""
}

func (j *Journal) unresolvedEventBelongsToPlatformSessionLocked(event protocol.Event, platformSessionID string) bool {
	if observed, ok := j.observedEvents[event.EventID]; ok {
		mappedPlatformSessionID, mapped := j.sessionAliasByAdapter[sessionAliasKeyFromObservation(observed.Observation)]
		return mapped && mappedPlatformSessionID == platformSessionID
	}
	legacy, ok := j.legacySessionFacts[event.SessionID]
	if !ok {
		return false
	}
	mappedPlatformSessionID, mapped := j.sessionAliasByAdapter[sessionAliasKey(legacy)]
	return mapped && mappedPlatformSessionID == platformSessionID
}

// MappedEvent resolves one raw event by its durable identity. A false result
// is the normal unknown state and must not be converted into a guessed run.
func (j *Journal) MappedEvent(eventID string) (protocol.Event, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	index, ok := j.eventIndexByID[eventID]
	if !ok {
		return protocol.Event{}, false
	}
	return j.mappedEventAtLocked(index)
}

func (j *Journal) mappedEventAtLocked(index int) (protocol.Event, bool) {
	event, ok := j.mappedEventWithoutSequenceAtLocked(index)
	if !ok {
		return protocol.Event{}, false
	}
	event.Sequence = j.mappedEventCountThroughLocked(index, event.SessionID)
	return event, true
}

func (j *Journal) mappedEventWithoutSequenceAtLocked(index int) (protocol.Event, bool) {
	if index < 0 || index >= len(j.events) {
		return protocol.Event{}, false
	}
	event := j.events[index]
	observed, ok := j.observedEvents[event.EventID]
	if !ok {
		return protocol.Event{}, false
	}
	return j.materializedObservedEventLocked(observed)
}

func (j *Journal) mappedEventCountBeforeLocked(index int, platformSessionID string) int64 {
	if index < 0 {
		return 0
	}
	if index > len(j.events) {
		index = len(j.events)
	}
	var count int64
	for current := 0; current < index; current++ {
		mapped, ok := j.mappedEventWithoutSequenceAtLocked(current)
		if ok && mapped.SessionID == platformSessionID {
			count++
		}
	}
	return count
}

func (j *Journal) mappedEventCountThroughLocked(index int, platformSessionID string) int64 {
	return j.mappedEventCountBeforeLocked(index+1, platformSessionID)
}

func (j *Journal) materializedObservedEventLocked(observed journalObservedEvent) (protocol.Event, bool) {
	platformSessionID, ok := j.sessionAliasByAdapter[sessionAliasKeyFromObservation(observed.Observation)]
	if !ok {
		return protocol.Event{}, false
	}
	alias, ok := j.sessionAliases[platformSessionID]
	if !ok {
		return protocol.Event{}, false
	}
	event := cloneEvent(observed.Event)
	event.SessionID = alias.PlatformSessionID
	if eventRequiresNativeIdentity(event.Type) && observed.Observation.NativeTurnID == "" && observed.Observation.NativeOperationID == "" {
		return protocol.Event{}, false
	}
	if observed.Observation.NativeTurnID == "" && observed.Observation.NativeOperationID == "" {
		return event, true
	}
	binding, ok := j.bindingForObservationLocked(observed.Observation)
	if !ok || binding.State != IdentityStateBound {
		return protocol.Event{}, false
	}
	event.RunID = stringPointer(binding.PlatformRunID)
	return event, true
}

func eventRequiresNativeIdentity(eventType protocol.EventType) bool {
	switch eventType {
	case protocol.EventTypeSessionCreated, protocol.EventTypeSessionAttached, protocol.EventTypeReconciliationRequired, protocol.EventTypeReconciliationCompleted:
		return false
	default:
		return true
	}
}

func (j *Journal) bindingForObservationLocked(observation EventObservation) (RunBinding, bool) {
	var platformKey string
	operationBound := false
	if observation.NativeTurnID != "" {
		platformKey = j.runBindingByNativeTurn[identityTupleKey(observation.AdapterSessionID, observation.ExternalThreadRef, observation.Generation, observation.NativeTurnID)]
	}
	if observation.NativeOperationID != "" {
		operationKey := identityTupleKey(observation.AdapterSessionID, observation.ExternalThreadRef, observation.Generation, observation.NativeOperationID)
		operationPlatformKey := j.runBindingByNativeOperation[operationKey]
		if operationPlatformKey != "" {
			if platformKey != "" && platformKey != operationPlatformKey {
				return RunBinding{}, false
			}
			platformKey = operationPlatformKey
			operationBound = true
		} else if platformKey == "" {
			return RunBinding{}, false
		}
	}
	if platformKey == "" {
		return RunBinding{}, false
	}
	binding, ok := j.runBindings[platformKey]
	if !ok || binding.State != IdentityStateBound {
		return RunBinding{}, false
	}
	if binding.AdapterSessionID != observation.AdapterSessionID || binding.ExternalThreadRef != observation.ExternalThreadRef || binding.Generation != observation.Generation {
		return RunBinding{}, false
	}
	if observation.NativeTurnID != "" && binding.NativeTurnID != observation.NativeTurnID {
		return RunBinding{}, false
	}
	if operationBound && observation.NativeOperationID != "" && binding.NativeOperationID != observation.NativeOperationID {
		return RunBinding{}, false
	}
	return binding, true
}

func sessionAliasKeyFromObservation(observation EventObservation) string {
	return identityTupleKey(observation.AdapterSessionID, observation.ExternalThreadRef, observation.Generation)
}

func sessionAliasKeyFromRunBinding(binding RunBinding) string {
	return identityTupleKey(binding.AdapterSessionID, binding.ExternalThreadRef, binding.Generation)
}

func sameObservedEvent(existing journalObservedEvent, event protocol.Event, observation EventObservation) bool {
	return existing.Observation == observation &&
		existing.Event.SessionID == event.SessionID &&
		existing.Event.EventID == event.EventID &&
		existing.Event.Cursor == event.Cursor &&
		existing.Event.OccurredAt == event.OccurredAt &&
		existing.Event.Sequence == event.Sequence &&
		existing.Event.Source == event.Source &&
		existing.Event.Type == event.Type &&
		string(existing.Event.Payload) == string(event.Payload)
}

func sortSessionAliases(values []SessionAlias) []SessionAlias {
	sort.Slice(values, func(i, k int) bool { return values[i].PlatformSessionID < values[k].PlatformSessionID })
	return values
}

func sortRunBindings(values []RunBinding) []RunBinding {
	sort.Slice(values, func(i, k int) bool {
		if values[i].PlatformSessionID == values[k].PlatformSessionID {
			return values[i].PlatformRunID < values[k].PlatformRunID
		}
		return values[i].PlatformSessionID < values[k].PlatformSessionID
	})
	return values
}

func cloneSessionAlias(value SessionAlias) SessionAlias {
	return value
}

func cloneRunBinding(value RunBinding) RunBinding {
	return value
}
