package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/approvals"
	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

var (
	ErrControlServiceUnavailable = errors.New("run control service is unavailable")
	ErrInvalidControlRequest     = errors.New("run control request is invalid")
)

// AuthorizeFunc is the application authorization seam shared by REST and MCP
// adapters. The application resolves project ownership and roles; this
// package only supplies the persisted Session identity and access direction.
type AuthorizeFunc func(context.Context, auth.Principal, string, bool) error

type SessionReader interface {
	Get(context.Context, string) (sessions.Session, error)
}

type RunControlStore interface {
	GetRun(context.Context, string) (Run, error)
	RequestInterrupt(context.Context, string, string) (Run, error)
}

type ApprovalControlStore interface {
	Get(context.Context, string) (approvals.Approval, error)
	Resolve(context.Context, approvals.ResolveRequest) (approvals.Resolution, error)
}

type ControlServiceConfig struct {
	Controller *Controller
	Sessions   SessionReader
	Runs       RunControlStore
	Approvals  ApprovalControlStore
	Authorize  AuthorizeFunc
	Now        func() time.Time
}

// ControlService is the common application boundary for the public Run
// operations. REST and MCP adapters should call these methods rather than
// constructing Commands or reading persistence independently.
type ControlService struct {
	controller *Controller
	sessions   SessionReader
	runs       RunControlStore
	approvals  ApprovalControlStore
	authorize  AuthorizeFunc
	now        func() time.Time
}

func NewControlService(config ControlServiceConfig) (*ControlService, error) {
	if config.Controller == nil || config.Controller.store == nil || config.Controller.transport == nil {
		return nil, fmt.Errorf("%w: controller and command transport are required", ErrControlServiceUnavailable)
	}
	if config.Sessions == nil {
		return nil, fmt.Errorf("%w: session store is required", ErrControlServiceUnavailable)
	}
	if config.Runs == nil {
		return nil, fmt.Errorf("%w: run store is required", ErrControlServiceUnavailable)
	}
	if config.Approvals == nil {
		return nil, fmt.Errorf("%w: approval store is required", ErrControlServiceUnavailable)
	}
	if config.Authorize == nil {
		return nil, fmt.Errorf("%w: authorizer is required", ErrControlServiceUnavailable)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &ControlService{
		controller: config.Controller,
		sessions:   config.Sessions,
		runs:       config.Runs,
		approvals:  config.Approvals,
		authorize:  config.Authorize,
		now:        config.Now,
	}, nil
}

// SubmitRun admits a new run command for the URL-selected Session. The
// Controller allocates the durable Run identity and owns command delivery.
func (s *ControlService) SubmitRun(ctx context.Context, principal auth.Principal, sessionID string, request protocol.SubmitRunRequest) (protocol.CommandAckResponse, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if err := validateSubmitRunRequest(request); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	session, err := s.authorizedSession(ctx, principal, sessionID, true)
	if err != nil {
		return protocol.CommandAckResponse{}, err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return protocol.CommandAckResponse{}, fmt.Errorf("encode submit run payload: %w", err)
	}
	ack, err := s.controller.AcceptCommand(ctx, protocol.Command{
		CommandID: request.CommandID,
		IssuedAt:  s.now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunSend,
		Payload:   payload,
		SessionID: session.ID,
	})
	return protocol.CommandAckResponse{Ack: ack}, err
}

// InterruptRun admits one interruption command after reserving the existing
// Run's interrupt state. A retry with the same command ID is delegated to the
// Controller's durable command ledger and does not send a second command.
func (s *ControlService) InterruptRun(ctx context.Context, principal auth.Principal, runID string, request protocol.InterruptRunRequest) (protocol.CommandAckResponse, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if err := validateIdentity(runID, "run id"); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if err := validateCommandID(request.CommandID); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	run, _, err := s.authorizedRun(ctx, principal, runID, true)
	if err != nil {
		return protocol.CommandAckResponse{}, err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return protocol.CommandAckResponse{}, fmt.Errorf("encode interrupt payload: %w", err)
	}
	command := protocol.Command{
		CommandID: request.CommandID,
		IssuedAt:  s.now().UTC().Format(time.RFC3339Nano),
		Kind:      protocol.CommandKindRunInterrupt,
		Payload:   payload,
		RunID:     stringPointer(run.ID),
		SessionID: run.SessionID,
	}
	if ack, found, err := s.lookupExistingCommand(ctx, command); err != nil {
		return protocol.CommandAckResponse{Ack: ack}, err
	} else if found {
		return protocol.CommandAckResponse{Ack: ack}, nil
	}
	if _, err := s.runs.RequestInterrupt(ctx, run.ID, run.Generation); err != nil {
		if errors.Is(err, ErrInterruptRequested) {
			if ack, found, lookupErr := s.lookupExistingCommand(ctx, command); lookupErr != nil {
				return protocol.CommandAckResponse{Ack: ack}, lookupErr
			} else if found {
				return protocol.CommandAckResponse{Ack: ack}, nil
			}
		}
		return protocol.CommandAckResponse{}, err
	}
	ack, err := s.controller.AcceptCommand(ctx, command)
	return protocol.CommandAckResponse{Ack: ack}, err
}

// ResolveApproval validates the URL-owned approval and Run, performs the
// durable pending+revision CAS, then admits the matching Controller command.
// A concurrent response that loses the CAS never crosses the transport edge.
func (s *ControlService) ResolveApproval(ctx context.Context, principal auth.Principal, runID, approvalID string, request protocol.ResolveApprovalRequest) (protocol.CommandAckResponse, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if err := validateIdentity(runID, "run id"); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if err := validateIdentity(approvalID, "approval id"); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if err := validateResolveApprovalRequest(request); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	approval, err := s.approvals.Get(ctx, approvalID)
	if err != nil {
		return protocol.CommandAckResponse{}, err
	}
	run, _, err := s.authorizedRun(ctx, principal, approval.RunID, true)
	if err != nil {
		return protocol.CommandAckResponse{}, err
	}
	if run.ID != runID || approval.SessionID != run.SessionID || approval.Generation != run.Generation {
		return protocol.CommandAckResponse{}, fmt.Errorf("%w: approval does not belong to the requested run", approvals.ErrApprovalContext)
	}
	if run.Generation == "" {
		return protocol.CommandAckResponse{}, fmt.Errorf("%w: run generation is required", ErrStaleGeneration)
	}
	payload, err := json.Marshal(approvalCommandPayload{
		ApprovalID: approval.ID,
		CommandID:  request.CommandID,
		Decision:   request.Decision,
		Revision:   request.Revision,
	})
	if err != nil {
		return protocol.CommandAckResponse{}, fmt.Errorf("encode approval payload: %w", err)
	}
	kind := protocol.CommandKindRunDeny
	if request.Decision == protocol.ApprovalDecisionApprove {
		kind = protocol.CommandKindRunApprove
	}
	command := protocol.Command{
		CommandID: request.CommandID,
		IssuedAt:  s.now().UTC().Format(time.RFC3339Nano),
		Kind:      kind,
		Payload:   payload,
		RunID:     stringPointer(run.ID),
		SessionID: run.SessionID,
	}
	if _, found, err := s.lookupCommand(ctx, command.CommandID); err != nil {
		return protocol.CommandAckResponse{}, err
	} else if found {
		ack, err := s.controller.AcceptCommand(ctx, command)
		if err != nil {
			return protocol.CommandAckResponse{Ack: ack}, err
		}
		_, err = s.approvals.Resolve(ctx, approvals.ResolveRequest{
			ApprovalID: approval.ID,
			RunID:      run.ID,
			SessionID:  run.SessionID,
			Generation: run.Generation,
			Request:    request,
		})
		if err != nil {
			return protocol.CommandAckResponse{Ack: ack}, err
		}
		return protocol.CommandAckResponse{Ack: ack}, nil
	}
	if _, err := s.approvals.Resolve(ctx, approvals.ResolveRequest{
		ApprovalID: approval.ID,
		RunID:      run.ID,
		SessionID:  run.SessionID,
		Generation: run.Generation,
		Request:    request,
	}); err != nil {
		return protocol.CommandAckResponse{}, err
	}
	ack, err := s.controller.AcceptCommand(ctx, command)
	return protocol.CommandAckResponse{Ack: ack}, err
}

func (s *ControlService) ListRunEvents(ctx context.Context, principal auth.Principal, runID string, request protocol.ListRunEventsQuery) (protocol.EventPage, error) {
	if err := s.ready(ctx); err != nil {
		return protocol.EventPage{}, err
	}
	if err := validateIdentity(runID, "run id"); err != nil {
		return protocol.EventPage{}, err
	}
	run, _, err := s.authorizedRun(ctx, principal, runID, false)
	if err != nil {
		return protocol.EventPage{}, err
	}
	query := protocol.EventQuery{SessionID: run.SessionID, RunID: run.ID}
	if request.AfterCursor != nil {
		query.AfterCursor = *request.AfterCursor
	}
	if request.Limit != nil {
		query.Limit = *request.Limit
	}
	return s.controller.ReadEvents(ctx, query)
}

type approvalCommandPayload struct {
	ApprovalID string                    `json:"approval_id"`
	CommandID  string                    `json:"command_id"`
	Decision   protocol.ApprovalDecision `json:"decision"`
	Revision   int64                     `json:"revision"`
}

func (s *ControlService) authorizedRun(ctx context.Context, principal auth.Principal, runID string, write bool) (Run, sessions.Session, error) {
	run, err := s.runs.GetRun(ctx, runID)
	if err != nil {
		return Run{}, sessions.Session{}, err
	}
	session, err := s.authorizedSession(ctx, principal, run.SessionID, write)
	if err != nil {
		return Run{}, sessions.Session{}, err
	}
	if session.ID != run.SessionID {
		return Run{}, sessions.Session{}, fmt.Errorf("%w: run session identity changed", ErrRunConflict)
	}
	if write && session.Generation != run.Generation {
		return Run{}, sessions.Session{}, fmt.Errorf("%w: run belongs to generation %q, session is on %q", ErrStaleGeneration, run.Generation, session.Generation)
	}
	return run, session, nil
}

func (s *ControlService) authorizedSession(ctx context.Context, principal auth.Principal, sessionID string, write bool) (sessions.Session, error) {
	if err := validateIdentity(sessionID, "session id"); err != nil {
		return sessions.Session{}, err
	}
	session, err := s.sessions.Get(ctx, sessionID)
	if err != nil {
		return sessions.Session{}, err
	}
	if session.ID != sessionID {
		return sessions.Session{}, fmt.Errorf("%w: session identity changed", ErrRunConflict)
	}
	if err := s.authorize(ctx, principal, session.ID, write); err != nil {
		return sessions.Session{}, err
	}
	return session, nil
}

func (s *ControlService) lookupExistingCommand(ctx context.Context, command protocol.Command) (protocol.CommandAck, bool, error) {
	ack, found, err := s.lookupCommand(ctx, command.CommandID)
	if err != nil {
		return protocol.CommandAck{}, false, err
	}
	if !found {
		return protocol.CommandAck{}, false, nil
	}
	ack, err = s.controller.AcceptCommand(ctx, command)
	return ack, true, err
}

func (s *ControlService) lookupCommand(ctx context.Context, commandID string) (protocol.CommandAck, bool, error) {
	ack, err := s.controller.LookupCommand(ctx, commandID)
	if errors.Is(err, ErrCommandNotFound) {
		return protocol.CommandAck{}, false, nil
	}
	if err != nil {
		return protocol.CommandAck{}, false, err
	}
	return ack, true, nil
}

func (s *ControlService) ready(ctx context.Context) error {
	if s == nil || s.controller == nil || s.controller.store == nil || s.controller.transport == nil || s.sessions == nil || s.runs == nil || s.approvals == nil || s.authorize == nil || s.now == nil {
		return ErrControlServiceUnavailable
	}
	if ctx == nil {
		return fmt.Errorf("%w: context must not be nil", ErrInvalidControlRequest)
	}
	return nil
}

func validateSubmitRunRequest(request protocol.SubmitRunRequest) error {
	if err := validateCommandID(request.CommandID); err != nil {
		return err
	}
	if request.Prompt == "" {
		return fmt.Errorf("%w: prompt is required", ErrInvalidControlRequest)
	}
	return nil
}

func validateResolveApprovalRequest(request protocol.ResolveApprovalRequest) error {
	if err := validateCommandID(request.CommandID); err != nil {
		return err
	}
	if request.Revision <= 0 {
		return fmt.Errorf("%w: approval revision must be positive", ErrInvalidControlRequest)
	}
	switch request.Decision {
	case protocol.ApprovalDecisionApprove, protocol.ApprovalDecisionDeny:
		return nil
	default:
		return fmt.Errorf("%w: unsupported approval decision %q", ErrInvalidControlRequest, request.Decision)
	}
}

func validateCommandID(commandID string) error {
	if strings.TrimSpace(commandID) == "" || commandID != strings.TrimSpace(commandID) {
		return fmt.Errorf("%w: command id is required and must not have surrounding whitespace", ErrInvalidControlRequest)
	}
	return nil
}

func validateIdentity(value, name string) error {
	if strings.TrimSpace(value) == "" || value != strings.TrimSpace(value) {
		return fmt.Errorf("%w: %s is required and must not have surrounding whitespace", ErrInvalidControlRequest, name)
	}
	return nil
}

func stringPointer(value string) *string {
	return &value
}
