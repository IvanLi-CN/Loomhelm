package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// BindSessionIdentity records the explicit platform-to-host session
// relationship after the gateway and adapter have both resolved it. The
// platform session ID is supplied by the session creation assembly; it is
// never derived from an adapter or thread ID.
func (c *Connector) BindSessionIdentity(platformSessionID, commandID string, gatewaySession protocol.GatewaySession, adapterSession protocol.AdapterSession) error {
	if c == nil || c.journal == nil {
		return errors.New("connector identity journal is unavailable")
	}
	platformSessionID = strings.TrimSpace(platformSessionID)
	commandID = strings.TrimSpace(commandID)
	if platformSessionID == "" || commandID == "" {
		return errors.New("platform session and creation command identities are required")
	}
	if strings.TrimSpace(adapterSession.SessionID) == "" || strings.TrimSpace(adapterSession.ExternalThreadRef) == "" {
		return errors.New("adapter session identity is incomplete")
	}
	if strings.TrimSpace(gatewaySession.Generation) == "" {
		return errors.New("gateway session generation is required")
	}
	if gatewaySession.ExternalThreadRef != "" && gatewaySession.ExternalThreadRef != adapterSession.ExternalThreadRef {
		return connectorruntime.ErrIdentityConflict
	}
	return c.journal.RecordSessionAlias(connectorruntime.SessionAlias{
		PlatformSessionID: platformSessionID,
		AdapterSessionID:  strings.TrimSpace(adapterSession.SessionID),
		ExternalThreadRef: strings.TrimSpace(adapterSession.ExternalThreadRef),
		Generation:        strings.TrimSpace(gatewaySession.Generation),
		CommandID:         commandID,
	})
}

// BeginRunIdentity durably reserves a platform run before the adapter can
// produce native evidence. The resulting unknown binding is intentional: it
// prevents an ACK or event from being guessed onto another native turn.
func (c *Connector) BeginRunIdentity(command protocol.Command) (connectorruntime.RunBinding, error) {
	if c == nil || c.journal == nil {
		return connectorruntime.RunBinding{}, errors.New("connector identity journal is unavailable")
	}
	if command.Kind != protocol.CommandKindRunSend {
		return connectorruntime.RunBinding{}, fmt.Errorf("run identity requires command kind %q", protocol.CommandKindRunSend)
	}
	platformRunID, err := platformCommandRunID(command)
	if err != nil {
		return connectorruntime.RunBinding{}, err
	}
	commandID := strings.TrimSpace(command.CommandID)
	if commandID == "" {
		return connectorruntime.RunBinding{}, errors.New("command identity is required")
	}
	alias, ok := c.journal.SessionAlias(command.SessionID)
	if !ok {
		return connectorruntime.RunBinding{}, fmt.Errorf("%w: platform session %q has no explicit adapter alias", connectorruntime.ErrIdentityNotFound, command.SessionID)
	}
	binding := connectorruntime.RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     platformRunID,
		CommandID:         commandID,
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		State:             connectorruntime.IdentityStateUnknown,
	}
	if err := c.journal.RecordRunBinding(binding); err != nil {
		return connectorruntime.RunBinding{}, err
	}
	if binding, ok := c.journal.RunBinding(alias.PlatformSessionID, platformRunID); ok {
		return binding, nil
	}
	return connectorruntime.RunBinding{}, connectorruntime.ErrIdentityNotFound
}

// PreparePlatformCommand translates a public command into the adapter's
// session and native-turn identity space. It rejects a control command until
// an exact bound RunBinding exists, and never forwards a platform RunID as a
// native turn.
func (c *Connector) PreparePlatformCommand(command protocol.Command) (protocol.Command, error) {
	if c == nil || c.journal == nil {
		return protocol.Command{}, errors.New("connector identity journal is unavailable")
	}
	if err := protocol.ValidateCommand(command); err != nil {
		return protocol.Command{}, err
	}
	alias, ok := c.journal.SessionAlias(command.SessionID)
	if !ok {
		return protocol.Command{}, fmt.Errorf("%w: platform session %q has no explicit adapter alias", connectorruntime.ErrIdentityNotFound, command.SessionID)
	}
	prepared := command
	prepared.SessionID = alias.AdapterSessionID
	prepared.RunID = nil

	switch command.Kind {
	case protocol.CommandKindRunSend:
		platformRunID, err := platformCommandRunID(command)
		if err != nil {
			return protocol.Command{}, err
		}
		payload, err := decodeIdentityCommandPayload(command.Payload)
		if err != nil {
			return protocol.Command{}, err
		}
		steer, err := identitySteerPayload(payload)
		if err != nil {
			return protocol.Command{}, err
		}
		if steer {
			binding, err := c.boundRunIdentity(alias.PlatformSessionID, platformRunID)
			if err != nil {
				return protocol.Command{}, err
			}
			if err := validateAndRewriteNativeTarget(payload, []string{"expected_turn_id", "turn_id", "run_id"}, binding.NativeTurnID); err != nil {
				return protocol.Command{}, err
			}
			prepared.Payload, err = encodeIdentityCommandPayload(payload)
			if err != nil {
				return protocol.Command{}, err
			}
			prepared.RunID = identityStringPointer(binding.NativeTurnID)
		}
	case protocol.CommandKindRunApprove, protocol.CommandKindRunDeny, protocol.CommandKindRunInterrupt:
		platformRunID, err := platformCommandRunID(command)
		if err != nil {
			return protocol.Command{}, err
		}
		binding, err := c.boundRunIdentity(alias.PlatformSessionID, platformRunID)
		if err != nil {
			return protocol.Command{}, err
		}
		payload, err := decodeIdentityCommandPayload(command.Payload)
		if err != nil {
			return protocol.Command{}, err
		}
		if err := validateAndRewriteNativeTarget(payload, []string{"expected_turn_id", "turn_id", "run_id"}, binding.NativeTurnID); err != nil {
			return protocol.Command{}, err
		}
		prepared.Payload, err = encodeIdentityCommandPayload(payload)
		if err != nil {
			return protocol.Command{}, err
		}
		prepared.RunID = identityStringPointer(binding.NativeTurnID)
	}
	return prepared, nil
}

// ObserveCommandIdentity advances a platform run binding only with the
// native evidence returned by the adapter. The caller must invoke this before
// the public gateway ACK is rewritten back to its platform RunID.
func (c *Connector) ObserveCommandIdentity(command protocol.Command, ack protocol.CommandAck) error {
	if c == nil || c.journal == nil {
		return errors.New("connector identity journal is unavailable")
	}
	platformRunID, err := optionalPlatformCommandRunID(command)
	if err != nil || platformRunID == "" {
		return err
	}
	alias, ok := c.journal.SessionAlias(command.SessionID)
	if !ok {
		return fmt.Errorf("%w: platform session %q has no explicit adapter alias", connectorruntime.ErrIdentityNotFound, command.SessionID)
	}
	if command.Kind != protocol.CommandKindRunSend && command.Kind != protocol.CommandKindRunApprove && command.Kind != protocol.CommandKindRunDeny && command.Kind != protocol.CommandKindRunInterrupt {
		return nil
	}
	existingBinding, found := c.journal.RunBinding(alias.PlatformSessionID, platformRunID)
	if !found {
		return fmt.Errorf("%w: platform run %q has no durable binding", protocol.ErrUnknownCommandResult, platformRunID)
	}
	nativeTurnID := ackString(ack.RunID)
	nativeOperationID := ackString(ack.OperationID)
	if isUnqualifiedOperationIdentity(nativeOperationID) {
		nativeOperationID = ""
	}
	if command.Kind != protocol.CommandKindRunSend {
		if nativeTurnID != "" && nativeTurnID != existingBinding.NativeTurnID {
			return connectorruntime.ErrIdentityConflict
		}
		return nil
	}
	if existingBinding.State == connectorruntime.IdentityStateBound {
		payload, payloadErr := decodeIdentityCommandPayload(command.Payload)
		if payloadErr == nil {
			steer, steerErr := identitySteerPayload(payload)
			if steerErr == nil && steer {
				if nativeTurnID != "" && nativeTurnID != existingBinding.NativeTurnID {
					return connectorruntime.ErrIdentityConflict
				}
				return nil
			}
		}
	}
	if nativeTurnID == "" && nativeOperationID == "" {
		return nil
	}
	state := connectorruntime.IdentityStatePending
	if nativeTurnID != "" {
		state = connectorruntime.IdentityStateBound
	}
	commandID := strings.TrimSpace(command.CommandID)
	if command.Kind != protocol.CommandKindRunSend {
		commandID = existingBinding.CommandID
	}
	return c.journal.RecordRunBinding(connectorruntime.RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     platformRunID,
		CommandID:         commandID,
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		NativeTurnID:      nativeTurnID,
		NativeOperationID: nativeOperationID,
		State:             state,
	})
}

func (c *Connector) acceptPlatformCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	prepared, err := c.PreparePlatformCommand(command)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	if command.Kind == protocol.CommandKindRunSend {
		if _, err := c.BeginRunIdentity(command); err != nil {
			return protocol.CommandAck{}, err
		}
	}
	if c.controller == nil {
		return protocol.CommandAck{}, errors.New("connector command controller is unavailable")
	}
	ack, acceptErr := c.controller.AcceptCommand(ctx, prepared)
	observeErr := c.ObserveCommandIdentity(command, ack)
	return ack, errors.Join(acceptErr, observeErr)
}

func (c *Connector) boundRunIdentity(platformSessionID, platformRunID string) (connectorruntime.RunBinding, error) {
	binding, ok := c.journal.RunBinding(platformSessionID, platformRunID)
	if !ok {
		return connectorruntime.RunBinding{}, fmt.Errorf("%w: platform run %q is not durably bound", protocol.ErrUnknownCommandResult, platformRunID)
	}
	if binding.State != connectorruntime.IdentityStateBound || binding.NativeTurnID == "" {
		return connectorruntime.RunBinding{}, fmt.Errorf("%w: platform run %q has no exact native turn", protocol.ErrUnknownCommandResult, platformRunID)
	}
	return binding, nil
}

func platformCommandRunID(command protocol.Command) (string, error) {
	runID, err := optionalPlatformCommandRunID(command)
	if err != nil {
		return "", err
	}
	if runID == "" {
		return "", fmt.Errorf("platform RunID is required for command kind %q", command.Kind)
	}
	return runID, nil
}

func optionalPlatformCommandRunID(command protocol.Command) (string, error) {
	if command.RunID == nil {
		return "", nil
	}
	runID := strings.TrimSpace(*command.RunID)
	if runID == "" {
		return "", errors.New("command RunID must not be empty")
	}
	return runID, nil
}

func decodeIdentityCommandPayload(payload json.RawMessage) (map[string]json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(payload, &value); err != nil {
		return nil, fmt.Errorf("command payload must be a JSON object for identity mapping: %w", err)
	}
	if value == nil {
		return nil, errors.New("command payload must be a JSON object for identity mapping")
	}
	return value, nil
}

func encodeIdentityCommandPayload(payload map[string]json.RawMessage) (json.RawMessage, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode identity-mapped command payload: %w", err)
	}
	return encoded, nil
}

func identitySteerPayload(payload map[string]json.RawMessage) (bool, error) {
	for _, key := range []string{"steer", "turn_steer"} {
		raw, ok := payload[key]
		if !ok {
			continue
		}
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return false, fmt.Errorf("command payload field %q must be boolean: %w", key, err)
		}
		if value {
			return true, nil
		}
	}
	for _, key := range []string{"expected_turn_id", "turn_id"} {
		if raw, ok := payload[key]; ok {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil || strings.TrimSpace(value) == "" {
				return false, fmt.Errorf("command payload field %q must be a non-empty string", key)
			}
			return true, nil
		}
	}
	return false, nil
}

func validateAndRewriteNativeTarget(payload map[string]json.RawMessage, keys []string, nativeTurnID string) error {
	var requested string
	for _, key := range keys {
		raw, ok := payload[key]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || strings.TrimSpace(value) == "" {
			return fmt.Errorf("command payload field %q must be a non-empty string", key)
		}
		value = strings.TrimSpace(value)
		if requested != "" && requested != value {
			return connectorruntime.ErrIdentityConflict
		}
		requested = value
	}
	if requested != "" && requested != nativeTurnID {
		return connectorruntime.ErrIdentityConflict
	}
	for _, key := range keys {
		if _, ok := payload[key]; ok {
			payload[key] = json.RawMessage(strconv.Quote(nativeTurnID))
		}
	}
	return nil
}

func ackString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func identityStringPointer(value string) *string {
	return &value
}

func isUnqualifiedOperationIdentity(value string) bool {
	switch value {
	case "turn/start", "turn/steer", "turn/interrupt", "approval response":
		return true
	default:
		return false
	}
}

func validateRecoveredSessionIdentity(alias connectorruntime.SessionAlias, gatewaySession protocol.GatewaySession, adapterSession protocol.AdapterSession) error {
	if err := validateRecoveredGatewaySession(alias, gatewaySession); err != nil {
		return err
	}
	if adapterSession.SessionID != alias.AdapterSessionID || adapterSession.ExternalThreadRef != alias.ExternalThreadRef {
		return connectorruntime.ErrIdentityConflict
	}
	return nil
}

func validateRecoveredGatewaySession(alias connectorruntime.SessionAlias, gatewaySession protocol.GatewaySession) error {
	if gatewaySession.ExternalThreadRef != "" && gatewaySession.ExternalThreadRef != alias.ExternalThreadRef {
		return connectorruntime.ErrIdentityConflict
	}
	if gatewaySession.Generation != alias.Generation {
		return fmt.Errorf("%w: recovered generation %q does not match immutable alias generation %q", connectorruntime.ErrIdentityConflict, gatewaySession.Generation, alias.Generation)
	}
	return nil
}
