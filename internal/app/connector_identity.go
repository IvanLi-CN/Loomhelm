package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	connectorruntime "github.com/IvanLi-CN/Loomhelm/internal/connector"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// OpenPlatformSession is the app-owned result returned after the selected
// Gateway/Adapter path has completed and the explicit platform alias is
// durable. U03 can activate its session store from these two execution facts.
type OpenPlatformSession struct {
	GatewaySession protocol.GatewaySession
	AdapterSession protocol.AdapterSession
}

// OpenSession selects the existing private session path and binds its result
// to the caller-provided platform session identity before returning success.
func (c *Connector) OpenSession(ctx context.Context, platformSessionID string, request protocol.CreateSessionRequest) (OpenPlatformSession, error) {
	if c == nil || c.journal == nil || c.appGateway == nil || c.adapter == nil {
		return OpenPlatformSession{}, errors.New("connector session assembly is unavailable")
	}
	platformSessionID = strings.TrimSpace(platformSessionID)
	if platformSessionID == "" {
		return OpenPlatformSession{}, errors.New("platform session identity is required")
	}
	var gatewaySession protocol.GatewaySession
	var adapterSession protocol.AdapterSession
	if request.Path == protocol.SessionPathNew {
		namespace := connectorruntime.PlatformSessionCommandNamespace(platformSessionID)
		nativeRequest := newSessionStartRequest(request)
		var err error
		gatewaySession, err = c.appGateway.StartNewSessionInNamespace(ctx, namespace, nativeRequest)
		if err != nil {
			return OpenPlatformSession{}, err
		}
		adapterSession, err = c.adapter.StartSessionInNamespace(ctx, namespace, gatewaySession, nativeRequest)
		if err != nil {
			return OpenPlatformSession{}, err
		}
	} else {
		// Existing-session attachment keeps the established R01 selector. The
		// public creation payload may carry an initial prompt, but this path must
		// not synthesize a run before the server has created its durable Run.
		openRequest := request
		openRequest.Prompt = nil
		opened, err := protocol.OpenSessionWithIdentity(ctx, c.appGateway, c.adapter, openRequest)
		if err != nil {
			return OpenPlatformSession{}, err
		}
		gatewaySession = opened.GatewaySession
		adapterSession = opened.AdapterSession
	}
	if err := validateSessionIdentity(platformSessionID, request.CommandID, gatewaySession, adapterSession); err != nil {
		return OpenPlatformSession{}, unknownSessionIdentityError(err)
	}
	if gatewaySession.ExternalThreadRef == "" {
		gatewaySession.ExternalThreadRef = adapterSession.ExternalThreadRef
	}
	if err := c.appGateway.SetExternalThreadRef(gatewaySession, gatewaySession.ExternalThreadRef); err != nil {
		return OpenPlatformSession{}, unknownSessionIdentityError(err)
	}
	if err := c.BindSessionIdentity(platformSessionID, request.CommandID, gatewaySession, adapterSession); err != nil {
		return OpenPlatformSession{}, unknownSessionIdentityError(err)
	}
	return OpenPlatformSession{GatewaySession: gatewaySession, AdapterSession: adapterSession}, nil
}

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
	if err := validateSessionIdentity(platformSessionID, commandID, gatewaySession, adapterSession); err != nil {
		return err
	}
	alias := connectorruntime.SessionAlias{
		PlatformSessionID: platformSessionID,
		AdapterSessionID:  strings.TrimSpace(adapterSession.SessionID),
		ExternalThreadRef: strings.TrimSpace(adapterSession.ExternalThreadRef),
		Generation:        strings.TrimSpace(gatewaySession.Generation),
		CommandID:         commandID,
	}
	if err := c.journal.RecordSessionAlias(alias); err != nil {
		return err
	}
	return c.journal.RecordGatewaySessionLink(connectorruntime.GatewaySessionLink{
		GatewayHandle:     strings.TrimSpace(gatewaySession.Handle),
		PlatformSessionID: platformSessionID,
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		CommandID:         commandID,
	})
}

func validateSessionIdentity(platformSessionID, commandID string, gatewaySession protocol.GatewaySession, adapterSession protocol.AdapterSession) error {
	if strings.TrimSpace(platformSessionID) == "" || strings.TrimSpace(commandID) == "" {
		return errors.New("platform session and creation command identities are required")
	}
	if strings.TrimSpace(gatewaySession.Handle) == "" || strings.TrimSpace(gatewaySession.Generation) == "" {
		return errors.New("gateway session identity is incomplete")
	}
	if strings.TrimSpace(adapterSession.SessionID) == "" || strings.TrimSpace(adapterSession.ExternalThreadRef) == "" {
		return errors.New("adapter session identity is incomplete")
	}
	if gatewaySession.ExternalThreadRef != "" && gatewaySession.ExternalThreadRef != adapterSession.ExternalThreadRef {
		return connectorruntime.ErrIdentityConflict
	}
	return nil
}

func unknownSessionIdentityError(cause error) error {
	return fmt.Errorf("%w: persist platform session identity: %w", connectorruntime.ErrUnknownOutcome, cause)
}

func newSessionStartRequest(request protocol.CreateSessionRequest) protocol.NewSessionRequest {
	return protocol.NewSessionRequest{
		CommandID: request.CommandID,
		ProjectID: optionalIdentityValue(request.ProjectID),
		TaskID:    optionalIdentityValue(request.TaskID),
	}
}

// RotateSessionIdentity advances one platform session to the fresh Gateway
// generation produced by cold recovery while preserving historical mappings.
func (c *Connector) RotateSessionIdentity(platformSessionID, commandID string, gatewaySession protocol.GatewaySession, adapterSession protocol.AdapterSession) error {
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
	return c.journal.RotateSessionAlias(connectorruntime.SessionAlias{
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
	if existing, found := c.journal.RunBinding(alias.PlatformSessionID, platformRunID); found {
		if existing.CommandID != commandID {
			return connectorruntime.RunBinding{}, connectorruntime.ErrIdentityConflict
		}
		return existing, nil
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
			binding, err := c.boundRunIdentity(alias, platformRunID)
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
		binding, err := c.boundRunIdentity(alias, platformRunID)
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
	bindingAlias := alias
	if existingBinding.Generation != alias.Generation || existingBinding.AdapterSessionID != alias.AdapterSessionID || existingBinding.ExternalThreadRef != alias.ExternalThreadRef {
		bindingAlias = connectorruntime.SessionAlias{
			PlatformSessionID: alias.PlatformSessionID,
			AdapterSessionID:  existingBinding.AdapterSessionID,
			ExternalThreadRef: existingBinding.ExternalThreadRef,
			Generation:        existingBinding.Generation,
			CommandID:         alias.CommandID,
		}
	}
	nativeTurnID := ackString(ack.RunID)
	nativeOperationID := ackString(ack.OperationID)
	if isUnqualifiedOperationIdentity(nativeOperationID) {
		nativeOperationID = ""
	}
	if generation := qualifiedOperationGeneration(nativeOperationID); generation != "" && generation != existingBinding.Generation {
		return connectorruntime.ErrIdentityConflict
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
		PlatformSessionID: bindingAlias.PlatformSessionID,
		PlatformRunID:     platformRunID,
		CommandID:         commandID,
		AdapterSessionID:  bindingAlias.AdapterSessionID,
		ExternalThreadRef: bindingAlias.ExternalThreadRef,
		Generation:        bindingAlias.Generation,
		NativeTurnID:      nativeTurnID,
		NativeOperationID: nativeOperationID,
		State:             state,
	})
}

func (c *Connector) acceptPlatformCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	if command.Kind == protocol.CommandKindSessionStart || command.Kind == protocol.CommandKindSessionAttach {
		return c.acceptSessionCommand(ctx, command)
	}
	prepared, err := c.PreparePlatformCommand(command)
	if err != nil {
		return protocol.CommandAck{}, err
	}
	preparedNamespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	if ack, found, err := c.journal.LookupCommandForRequestInNamespace(preparedNamespace, prepared); err != nil {
		return ack, err
	} else if found {
		if command.Kind == protocol.CommandKindRunSend {
			return c.reconcileCachedRunCommand(ctx, command, prepared, ack)
		}
		if command.Kind == protocol.CommandKindRunApprove || command.Kind == protocol.CommandKindRunDeny {
			return c.reconcileCachedApprovalCommand(command, prepared, ack)
		}
		if ack.State == protocol.CommandStateUnknown {
			return ack, protocol.ErrUnknownCommandResult
		}
		return ack, nil
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
	return c.completePlatformCommand(command, prepared, ack, acceptErr)
}

// reconcileCachedApprovalCommand proves an unknown approval ACK from the
// journal's exact durable resolution. It never replays the adapter response.
func (c *Connector) reconcileCachedApprovalCommand(command, prepared protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	if ack.State == protocol.CommandStateSucceeded || ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
		return ack, nil
	}
	namespace := connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID)
	resolution, found, err := c.journal.ApprovalResultInNamespace(namespace, prepared.CommandID)
	if err != nil {
		return c.persistUnknownCommand(namespace, prepared.CommandID, ack, err)
	}
	if !found {
		return c.persistUnknownCommand(namespace, prepared.CommandID, ack, protocol.ErrUnknownCommandResult)
	}
	desired := "accept"
	if command.Kind == protocol.CommandKindRunDeny {
		desired = "decline"
	}
	if resolution != desired && resolution != "cleared" {
		cause := fmt.Errorf("approval resolved as %q, requested %q", resolution, desired)
		durable := ack
		durable.Deduplicated = false
		durable.State = protocol.CommandStateFailed
		durable.Error = &protocol.ApiError{Code: protocol.ErrorCodeConflict, Message: cause.Error(), RequestID: command.CommandID}
		if updateErr := c.journal.UpdateCommandInNamespace(namespace, prepared.CommandID, durable); updateErr != nil {
			return ack, errors.Join(cause, updateErr)
		}
		durable.Deduplicated = true
		return durable, cause
	}
	result, err := json.Marshal(map[string]string{"decision": desired})
	if err != nil {
		return c.persistUnknownCommand(namespace, prepared.CommandID, ack, err)
	}
	durable := ack
	durable.Deduplicated = false
	durable.State = protocol.CommandStateSucceeded
	durable.Error = nil
	durable.Result = result
	if err := c.journal.UpdateCommandInNamespace(namespace, prepared.CommandID, durable); err != nil {
		return ack, err
	}
	durable.Deduplicated = true
	return durable, nil
}

func (c *Connector) completePlatformCommand(command, prepared protocol.Command, ack protocol.CommandAck, acceptErr error) (protocol.CommandAck, error) {
	observeErr := c.ObserveCommandIdentity(command, ack)
	combinedErr := errors.Join(acceptErr, observeErr)
	if ack.State == protocol.CommandStateSucceeded && combinedErr != nil {
		unknown, unknownErr := c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, combinedErr)
		unknown.Deduplicated = false
		return unknown, unknownErr
	}
	return ack, combinedErr
}

func (c *Connector) acceptSessionCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, error) {
	if c == nil || c.journal == nil {
		return protocol.CommandAck{}, errors.New("connector session command journal is unavailable")
	}
	namespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	ack, deduplicated, err := c.journal.BeginCommandInNamespace(namespace, command)
	if err != nil {
		return ack, err
	}
	if deduplicated {
		if command.Kind == protocol.CommandKindSessionStart && ack.State != protocol.CommandStateFailed && ack.State != protocol.CommandStateRejected {
			request, decodeErr := decodeSessionCommand(command.Payload)
			if decodeErr != nil {
				return c.persistUnknownCommand(namespace, command.CommandID, ack, decodeErr)
			}
			if request.CommandID != command.CommandID || request.Path != protocol.SessionPathNew {
				return c.rejectSessionCommand(command, ack, protocol.ErrIdempotencyConflict)
			}
			return c.reconcileCachedSessionStart(command, request, ack)
		}
		if ack.State == protocol.CommandStateUnknown {
			return ack, protocol.ErrUnknownCommandResult
		}
		return ack, nil
	}
	if command.Kind == protocol.CommandKindSessionAttach {
		return c.rejectSessionCommand(command, ack, protocol.ErrUnsupportedSessionPath)
	}
	request, err := decodeSessionCommand(command.Payload)
	if err != nil {
		return c.rejectSessionCommand(command, ack, err)
	}
	if request.CommandID != command.CommandID {
		return c.rejectSessionCommand(command, ack, protocol.ErrIdempotencyConflict)
	}
	if request.Path != protocol.SessionPathNew {
		return c.rejectSessionCommand(command, ack, protocol.ErrUnsupportedSessionPath)
	}
	opened, err := c.OpenSession(ctx, command.SessionID, request)
	if err != nil {
		if errors.Is(err, protocol.ErrUnknownCommandResult) || errors.Is(err, connectorruntime.ErrUnknownOutcome) {
			ack.State = protocol.CommandStateUnknown
			ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "session opening outcome is unknown", RequestID: command.CommandID}
			if updateErr := c.journal.UpdateCommandInNamespace(namespace, command.CommandID, ack); updateErr != nil {
				return ack, errors.Join(err, updateErr)
			}
			return ack, err
		}
		return c.rejectSessionCommand(command, ack, err)
	}
	result, err := json.Marshal(sessionOpenResult{
		ExternalThreadRef: opened.AdapterSession.ExternalThreadRef,
		Generation:        opened.GatewaySession.Generation,
	})
	if err != nil {
		return c.rejectSessionCommand(command, ack, err)
	}
	ack.State = protocol.CommandStateSucceeded
	ack.Error = nil
	ack.Result = result
	if err := c.journal.UpdateCommandInNamespace(namespace, command.CommandID, ack); err != nil {
		return ack, err
	}
	return ack, nil
}

// reconcileCachedRunCommand proves a cached run.send ACK against its durable
// native identity before the platform sees success. The path only reconciles
// existing journal facts; it never submits the native command again.
func (c *Connector) reconcileCachedRunCommand(ctx context.Context, command, prepared protocol.Command, ack protocol.CommandAck) (protocol.CommandAck, error) {
	if ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
		return ack, nil
	}
	platformRunID, err := platformCommandRunID(command)
	if err != nil {
		return ack, err
	}
	binding, found := c.journal.RunBinding(command.SessionID, platformRunID)
	if found {
		if binding.PlatformSessionID != command.SessionID || binding.PlatformRunID != platformRunID || binding.CommandID != command.CommandID {
			return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, connectorruntime.ErrIdentityConflict)
		}
		if err := validateRunAckAgainstBinding(binding, ack); err != nil {
			return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, err)
		}
	} else if err := c.ensureRunIdentityForRecovery(command, ack); err != nil {
		return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, err)
	}

	var reconcileErr error
	if ack.State != protocol.CommandStateSucceeded && ack.State != protocol.CommandStateFailed && ack.State != protocol.CommandStateRejected {
		if c.controller == nil {
			reconcileErr = errors.New("connector command controller is unavailable for durable reconciliation")
		} else {
			_, reconcileErr = c.controller.ReconcileCommand(ctx, command.SessionID, command.CommandID)
		}
		latest, lookupErr := c.journal.LookupCommandInNamespace(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID)
		if lookupErr != nil {
			return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, errors.Join(reconcileErr, lookupErr))
		}
		ack = latest
	}

	if err := c.ObserveCommandIdentity(command, ack); err != nil {
		return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, errors.Join(reconcileErr, err))
	}
	latest, err := c.journal.LookupCommandInNamespace(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID)
	if err != nil {
		return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, errors.Join(reconcileErr, err))
	}
	ack = latest
	binding, found = c.journal.RunBinding(command.SessionID, platformRunID)
	if err := validateRunAckAgainstBinding(binding, ack); err != nil || !found || binding.State != connectorruntime.IdentityStateBound || binding.NativeTurnID == "" || ack.State != protocol.CommandStateSucceeded {
		if err == nil {
			err = protocol.ErrUnknownCommandResult
		}
		return c.persistUnknownCommand(connectorruntime.AdapterSessionCommandNamespace(prepared.SessionID), prepared.CommandID, ack, errors.Join(reconcileErr, err))
	}
	ack.Deduplicated = true
	return ack, nil
}

func (c *Connector) ensureRunIdentityForRecovery(command protocol.Command, ack protocol.CommandAck) error {
	platformRunID, err := platformCommandRunID(command)
	if err != nil {
		return err
	}
	if _, found := c.journal.RunBinding(command.SessionID, platformRunID); found {
		return nil
	}
	alias, ok := c.journal.SessionAlias(command.SessionID)
	if !ok {
		return connectorruntime.ErrIdentityNotFound
	}
	operationID := ackString(ack.OperationID)
	if isUnqualifiedOperationIdentity(operationID) {
		operationID = ""
	}
	if generation := qualifiedOperationGeneration(operationID); generation != "" && generation != alias.Generation {
		historical, historicalOK := c.journal.SessionAliasForAdapter(alias.AdapterSessionID, alias.ExternalThreadRef, generation)
		if !historicalOK || historical.PlatformSessionID != alias.PlatformSessionID {
			return connectorruntime.ErrIdentityConflict
		}
		alias = historical
	}
	return c.journal.RecordRunBinding(connectorruntime.RunBinding{
		PlatformSessionID: alias.PlatformSessionID,
		PlatformRunID:     platformRunID,
		CommandID:         command.CommandID,
		AdapterSessionID:  alias.AdapterSessionID,
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
		State:             connectorruntime.IdentityStateUnknown,
	})
}

func validateRunAckAgainstBinding(binding connectorruntime.RunBinding, ack protocol.CommandAck) error {
	if binding.PlatformSessionID == "" || binding.PlatformRunID == "" || binding.CommandID == "" {
		return protocol.ErrUnknownCommandResult
	}
	if nativeTurnID := ackString(ack.RunID); nativeTurnID != "" && binding.NativeTurnID != "" && nativeTurnID != binding.NativeTurnID {
		return connectorruntime.ErrIdentityConflict
	}
	operationID := ackString(ack.OperationID)
	if isUnqualifiedOperationIdentity(operationID) {
		operationID = ""
	}
	if operationID != "" && binding.NativeOperationID != "" && operationID != binding.NativeOperationID {
		return connectorruntime.ErrIdentityConflict
	}
	if generation := qualifiedOperationGeneration(operationID); generation != "" && generation != binding.Generation {
		return connectorruntime.ErrIdentityConflict
	}
	return nil
}

func qualifiedOperationGeneration(operationID string) string {
	separator := strings.IndexByte(operationID, '\x00')
	if separator <= 0 {
		return ""
	}
	return strings.TrimSpace(operationID[:separator])
}

func (c *Connector) reconcileCachedSessionStart(command protocol.Command, request protocol.CreateSessionRequest, ack protocol.CommandAck) (protocol.CommandAck, error) {
	namespace := connectorruntime.PlatformSessionCommandNamespace(command.SessionID)
	nativeRequest := newSessionStartRequest(request)
	// Recovery must resolve through the verified platform alias/link. A bare
	// command ID is not enough because separate platform sessions may reuse it.
	proof, found, err := c.journal.ResolvedSessionStartProofForPlatform(command.SessionID, nativeRequest)
	if err != nil {
		return c.persistUnknownCommand(namespace, command.CommandID, ack, err)
	}
	if !found {
		return c.persistUnknownCommand(namespace, command.CommandID, ack, connectorruntime.ErrCommandScopeUnknown)
	}
	alias, aliasFound := c.journal.SessionAlias(command.SessionID)
	if aliasFound {
		if alias.PlatformSessionID != command.SessionID || alias.CommandID != command.CommandID {
			return c.persistUnknownCommand(namespace, command.CommandID, ack, connectorruntime.ErrIdentityConflict)
		}
		if proof.AdapterSession.SessionID != alias.AdapterSessionID || proof.AdapterSession.ExternalThreadRef != alias.ExternalThreadRef || proof.Generation != alias.Generation {
			return c.persistUnknownCommand(namespace, command.CommandID, ack, connectorruntime.ErrIdentityConflict)
		}
	}
	gatewaySession := protocol.GatewaySession{
		Handle:            proof.GatewayHandle,
		ExternalThreadRef: proof.AdapterSession.ExternalThreadRef,
		Generation:        proof.Generation,
		Path:              protocol.SessionPathNew,
	}
	if err := c.BindSessionIdentity(command.SessionID, command.CommandID, gatewaySession, proof.AdapterSession); err != nil {
		return c.persistUnknownCommand(namespace, command.CommandID, ack, err)
	}
	alias, aliasFound = c.journal.SessionAlias(command.SessionID)
	if !aliasFound {
		return c.persistUnknownCommand(namespace, command.CommandID, ack, connectorruntime.ErrCommandScopeUnknown)
	}
	result, err := json.Marshal(sessionOpenResult{
		ExternalThreadRef: alias.ExternalThreadRef,
		Generation:        alias.Generation,
	})
	if err != nil {
		return c.persistUnknownCommand(namespace, command.CommandID, ack, err)
	}
	durable := ack
	durable.Deduplicated = false
	durable.State = protocol.CommandStateSucceeded
	durable.Error = nil
	durable.Result = result
	if err := c.journal.UpdateCommandInNamespace(namespace, command.CommandID, durable); err != nil {
		return ack, err
	}
	durable.Deduplicated = true
	return durable, nil
}

func (c *Connector) persistUnknownCommand(namespace connectorruntime.CommandNamespace, commandID string, ack protocol.CommandAck, cause error) (protocol.CommandAck, error) {
	durable := ack
	durable.Deduplicated = false
	durable.State = protocol.CommandStateUnknown
	durable.Error = &protocol.ApiError{Code: protocol.ErrorCodeUnknownResult, Message: "command outcome is unknown", RequestID: commandID}
	updateErr := c.journal.UpdateCommandInNamespace(namespace, commandID, durable)
	durable.Deduplicated = true
	return durable, errors.Join(protocol.ErrUnknownCommandResult, cause, updateErr)
}

func (c *Connector) rejectSessionCommand(command protocol.Command, ack protocol.CommandAck, cause error) (protocol.CommandAck, error) {
	deduplicated := ack.Deduplicated
	ack.State = protocol.CommandStateRejected
	ack.Error = &protocol.ApiError{Code: protocol.ErrorCodeInvalidRequest, Message: "session command was rejected", RequestID: command.CommandID}
	durable := ack
	durable.Deduplicated = false
	if err := c.journal.UpdateCommandInNamespace(connectorruntime.PlatformSessionCommandNamespace(command.SessionID), command.CommandID, durable); err != nil {
		return ack, errors.Join(cause, err)
	}
	ack.Deduplicated = deduplicated
	return ack, cause
}

func decodeSessionCommand(payload json.RawMessage) (protocol.CreateSessionRequest, error) {
	if len(bytes.TrimSpace(payload)) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return protocol.CreateSessionRequest{}, errors.New("session command payload is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var request protocol.CreateSessionRequest
	if err := decoder.Decode(&request); err != nil {
		return protocol.CreateSessionRequest{}, fmt.Errorf("decode session command payload: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return protocol.CreateSessionRequest{}, errors.New("session command payload must contain one JSON object")
	}
	return request, nil
}

func (c *Connector) boundRunIdentity(alias connectorruntime.SessionAlias, platformRunID string) (connectorruntime.RunBinding, error) {
	binding, ok := c.journal.RunBinding(alias.PlatformSessionID, platformRunID)
	if !ok {
		return connectorruntime.RunBinding{}, fmt.Errorf("%w: platform run %q is not durably bound", protocol.ErrUnknownCommandResult, platformRunID)
	}
	if binding.Generation != alias.Generation || binding.AdapterSessionID != alias.AdapterSessionID || binding.ExternalThreadRef != alias.ExternalThreadRef {
		return connectorruntime.RunBinding{}, fmt.Errorf("%w: platform run %q belongs to a historical session generation", protocol.ErrUnknownCommandResult, platformRunID)
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

func optionalIdentityValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
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
	if strings.TrimSpace(gatewaySession.Generation) == "" {
		return fmt.Errorf("%w: recovered generation is empty", connectorruntime.ErrIdentityConflict)
	}
	return nil
}
