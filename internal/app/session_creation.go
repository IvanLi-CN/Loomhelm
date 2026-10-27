package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/gateway"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/IvanLi-CN/Loomhelm/internal/runs"
	"github.com/IvanLi-CN/Loomhelm/internal/sessions"
)

type sessionCreationApplication interface {
	CreateSession(context.Context, auth.Principal, protocol.CreateSessionRequest) (protocol.Session, error)
}

type sessionCreationRecords interface {
	CreateIntent(context.Context, sessions.CreationIntentInput) (sessions.CreationIntent, error)
	MarkIntentUnknown(context.Context, sessions.UnknownIntentInput) (sessions.CreationIntent, error)
	MarkIntentDefiniteFailure(context.Context, sessions.DefiniteFailureIntentInput) (sessions.CreationIntent, error)
	ActivateIntent(context.Context, sessions.ActivationInput) (sessions.Session, error)
	Get(context.Context, string) (sessions.Session, error)
}

type sessionCreationHostSelector interface {
	ConfiguredHost(context.Context) (hosts.Host, error)
}

type sessionCreationTransport interface {
	SendSessionCommand(context.Context, string, protocol.Command) (protocol.CommandAck, error)
}

type sessionInitialRunSubmitter interface {
	SubmitRun(context.Context, auth.Principal, string, protocol.SubmitRunRequest) (protocol.CommandAckResponse, error)
}

type sessionCreationService struct {
	records    sessionCreationRecords
	projects   sessionProjectAccess
	hosts      sessionCreationHostSelector
	transport  sessionCreationTransport
	initialRun sessionInitialRunSubmitter
	now        func() time.Time
	newID      func() (string, error)
}

type sessionOpenResult struct {
	ExternalThreadRef string `json:"external_thread_ref"`
	Generation        string `json:"generation"`
}

func newSessionCreationService(records sessionCreationRecords, projects sessionProjectAccess, hostSelector sessionCreationHostSelector, transport sessionCreationTransport, initialRun sessionInitialRunSubmitter) *sessionCreationService {
	return &sessionCreationService{
		records:    records,
		projects:   projects,
		hosts:      hostSelector,
		transport:  transport,
		initialRun: initialRun,
		now:        time.Now,
		newID:      newSessionID,
	}
}

func (s *sessionCreationService) CreateSession(ctx context.Context, principal auth.Principal, request protocol.CreateSessionRequest) (protocol.Session, error) {
	if ctx == nil {
		return protocol.Session{}, fmt.Errorf("%w: session creation context must not be nil", auth.ErrInvalid)
	}
	if principal.UserID == "" {
		return protocol.Session{}, auth.ErrUnauthenticated
	}
	normalized, err := normalizeCreateSessionRequest(request)
	if err != nil {
		return protocol.Session{}, err
	}
	if err := s.authorize(ctx, principal, normalized); err != nil {
		return protocol.Session{}, err
	}
	if s.records == nil || s.hosts == nil || s.transport == nil {
		return protocol.Session{}, runs.ErrControlServiceUnavailable
	}
	host, err := s.hosts.ConfiguredHost(ctx)
	if err != nil {
		return protocol.Session{}, fmt.Errorf("resolve configured execution host: %w", err)
	}
	if strings.TrimSpace(host.ID) == "" {
		return protocol.Session{}, fmt.Errorf("%w: configured execution host has no identity", hosts.ErrInvalid)
	}
	parameters, err := json.Marshal(normalized)
	if err != nil {
		return protocol.Session{}, fmt.Errorf("encode session creation parameters: %w", err)
	}
	if s.newID == nil {
		s.newID = newSessionID
	}
	sessionID, err := s.newID()
	if err != nil {
		return protocol.Session{}, err
	}
	createdAt := ""
	if s.now != nil {
		createdAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	intent, err := s.records.CreateIntent(ctx, sessions.CreationIntentInput{
		SessionID:     sessionID,
		CommandID:     normalized.CommandID,
		CreatorUserID: principal.UserID,
		HostID:        host.ID,
		Path:          normalized.Path,
		ProjectID:     optionalRequestValue(normalized.ProjectID),
		TaskID:        optionalRequestValue(normalized.TaskID),
		Parameters:    parameters,
		Summary:       "session.start",
		CreatedAt:     createdAt,
		UpdatedAt:     createdAt,
	})
	if err != nil {
		return protocol.Session{}, err
	}

	switch intent.State {
	case sessions.IntentStateConfirmed:
		return s.finishConfirmedSession(ctx, principal, normalized, intent.SessionID)
	case sessions.IntentStateUnknown:
		// An unchanged caller retry may reconcile the exact durable creation
		// command. The Connector owns the command journal and will return the
		// cached native session proof without issuing a second session/start.
		return s.openPendingSession(ctx, principal, normalized, intent)
	case sessions.IntentStatePending:
		return s.openPendingSession(ctx, principal, normalized, intent)
	default:
		return protocol.Session{}, fmt.Errorf("%w: unsupported creation intent state %q", sessions.ErrSessionTransition, intent.State)
	}
}

func (s *sessionCreationService) authorize(ctx context.Context, principal auth.Principal, request protocol.CreateSessionRequest) error {
	projectID := optionalRequestValue(request.ProjectID)
	if projectID == "" {
		if len(principal.ProjectScope) != 0 {
			return auth.ErrForbidden
		}
		return nil
	}
	if !principal.HasProjectScope(projectID) || s.projects == nil {
		return auth.ErrNotFound
	}
	allowed, err := s.projects.CanWriteProject(ctx, principal, projectID)
	if err != nil {
		return fmt.Errorf("authorize session project: %w", err)
	}
	if !allowed {
		return auth.ErrNotFound
	}
	return nil
}

func (s *sessionCreationService) openPendingSession(ctx context.Context, principal auth.Principal, request protocol.CreateSessionRequest, intent sessions.CreationIntent) (protocol.Session, error) {
	parameters, err := json.Marshal(request)
	if err != nil {
		return protocol.Session{}, fmt.Errorf("encode session command payload: %w", err)
	}
	issuedAt := ""
	if s.now != nil {
		issuedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	ack, err := s.transport.SendSessionCommand(ctx, intent.HostID, protocol.Command{
		CommandID: intent.CommandID,
		IssuedAt:  issuedAt,
		Kind:      protocol.CommandKindSessionStart,
		Payload:   parameters,
		SessionID: intent.SessionID,
	})
	if err != nil {
		if isUnknownSessionOutcome(err) {
			return protocol.Session{}, s.markUnknown(ctx, intent.SessionID, err)
		}
		return protocol.Session{}, err
	}
	if ack.State != protocol.CommandStateSucceeded {
		if ack.State == protocol.CommandStateFailed || ack.State == protocol.CommandStateRejected {
			definiteErr := fmt.Errorf("session creation command %q returned definite state %q", intent.CommandID, ack.State)
			if _, markErr := s.records.MarkIntentDefiniteFailure(ctx, sessions.DefiniteFailureIntentInput{SessionID: intent.SessionID, State: ack.State}); markErr != nil {
				return protocol.Session{}, errors.Join(definiteErr, fmt.Errorf("record definite session failure: %w", markErr))
			}
			return protocol.Session{}, definiteErr
		}
		return protocol.Session{}, s.markUnknown(ctx, intent.SessionID, fmt.Errorf("host returned session command state %q", ack.State))
	}
	var opened sessionOpenResult
	if err := json.Unmarshal(ack.Result, &opened); err != nil || strings.TrimSpace(opened.ExternalThreadRef) == "" || strings.TrimSpace(opened.Generation) == "" {
		return protocol.Session{}, s.markUnknown(ctx, intent.SessionID, errors.New("host session acknowledgement did not contain a complete execution identity"))
	}
	active, err := s.records.ActivateIntent(ctx, sessions.ActivationInput{
		SessionID:           intent.SessionID,
		ExternalThreadRef:   opened.ExternalThreadRef,
		ExecutionGeneration: opened.Generation,
	})
	if err != nil {
		return protocol.Session{}, err
	}
	return s.finishInitialPrompt(ctx, principal, request, active)
}

func (s *sessionCreationService) finishConfirmedSession(ctx context.Context, principal auth.Principal, request protocol.CreateSessionRequest, sessionID string) (protocol.Session, error) {
	if s.records == nil {
		return protocol.Session{}, runs.ErrControlServiceUnavailable
	}
	active, err := s.records.Get(ctx, sessionID)
	if err != nil {
		return protocol.Session{}, err
	}
	return s.finishInitialPrompt(ctx, principal, request, active)
}

func (s *sessionCreationService) finishInitialPrompt(ctx context.Context, principal auth.Principal, request protocol.CreateSessionRequest, session sessions.Session) (protocol.Session, error) {
	if request.Prompt == nil || strings.TrimSpace(*request.Prompt) == "" {
		return session.Session, nil
	}
	if s.initialRun == nil {
		return protocol.Session{}, runs.ErrControlServiceUnavailable
	}
	_, err := s.initialRun.SubmitRun(ctx, principal, session.ID, protocol.SubmitRunRequest{
		CommandID: request.CommandID + ":initial",
		Prompt:    *request.Prompt,
	})
	if err != nil {
		return protocol.Session{}, err
	}
	return session.Session, nil
}

func (s *sessionCreationService) markUnknown(ctx context.Context, sessionID string, cause error) error {
	if s.records == nil {
		return errors.Join(protocol.ErrUnknownCommandResult, cause)
	}
	_, markErr := s.records.MarkIntentUnknown(ctx, sessions.UnknownIntentInput{SessionID: sessionID, Reason: cause.Error()})
	return errors.Join(protocol.ErrUnknownCommandResult, cause, markErr)
}

func isUnknownSessionOutcome(err error) bool {
	return errors.Is(err, protocol.ErrUnknownCommandResult) || errors.Is(err, gateway.ErrUnknownDelivery) || errors.Is(err, gateway.ErrConnectionClosed)
}

func normalizeCreateSessionRequest(request protocol.CreateSessionRequest) (protocol.CreateSessionRequest, error) {
	if request.CommandID == "" || request.CommandID != strings.TrimSpace(request.CommandID) {
		return protocol.CreateSessionRequest{}, fmt.Errorf("%w: command id is required and must not have surrounding whitespace", auth.ErrInvalid)
	}
	if request.Path != protocol.SessionPathNew {
		if request.Path == protocol.SessionPathExistingActive {
			return protocol.CreateSessionRequest{}, protocol.ErrUnsupportedSessionPath
		}
		return protocol.CreateSessionRequest{}, fmt.Errorf("%w: unsupported session path %q", auth.ErrInvalid, request.Path)
	}
	for name, value := range map[string]*string{"project_id": request.ProjectID, "task_id": request.TaskID} {
		if value != nil && (strings.TrimSpace(*value) == "" || *value != strings.TrimSpace(*value)) {
			return protocol.CreateSessionRequest{}, fmt.Errorf("%w: %s must be a non-empty value without surrounding whitespace", auth.ErrInvalid, name)
		}
	}
	if request.ActiveThreadRef != nil && strings.TrimSpace(*request.ActiveThreadRef) != "" {
		return protocol.CreateSessionRequest{}, fmt.Errorf("%w: active_thread_ref is only valid for an active-session path", auth.ErrInvalid)
	}
	if request.ActiveThreadRef != nil {
		request.ActiveThreadRef = nil
	}
	return request, nil
}

func optionalRequestValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func newSessionID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate session id: %w", err)
	}
	return "session_" + hex.EncodeToString(value), nil
}
