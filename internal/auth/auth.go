// Package auth owns browser sessions, OIDC identity binding, and revocable
// user API credentials. Domain packages consume PrincipalResolver instead of
// reimplementing bearer or session authentication.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
	"github.com/alexedwards/scs/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUnauthenticated = errors.New("authentication required")
	ErrForbidden       = errors.New("operation is not authorized")
	ErrNotFound        = errors.New("resource not found")
	ErrConflict        = errors.New("resource conflict")
	ErrInvalid         = errors.New("invalid request")
)

type Principal struct {
	UserID       string
	CredentialID string
	ProjectScope map[string]struct{}
}

func (p Principal) HasProjectScope(projectID string) bool {
	if len(p.ProjectScope) == 0 {
		return true
	}
	_, ok := p.ProjectScope[projectID]
	return ok
}

type PrincipalResolver interface {
	ResolvePrincipal(context.Context, *http.Request) (Principal, error)
}

type Identity struct {
	Issuer        string
	Subject       string
	Email         string
	DisplayName   string
	EmailVerified bool
}

type Provider interface {
	AuthorizationURL(state, nonce string) (string, error)
	Exchange(context.Context, string, string) (Identity, error)
}

type Config struct {
	SessionCookieName string
	SessionLifetime   time.Duration
	SessionCookiePath string
	SecureCookies     bool
	SuccessRedirect   string
	OIDC              OIDCConfig
}

type Service struct {
	pool     *pgxpool.Pool
	sessions *scs.SessionManager
	oidc     Provider
	cfg      Config
	now      func() time.Time
}

type User struct {
	ID          string `json:"id"`
	Issuer      string `json:"issuer"`
	Subject     string `json:"subject"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type Credential struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	ProjectIDs []string `json:"project_ids"`
	CreatedAt  string   `json:"created_at"`
	LastUsedAt *string  `json:"last_used_at,omitempty"`
	RevokedAt  *string  `json:"revoked_at,omitempty"`
	Token      string   `json:"token,omitempty"`
}

type CreateCredentialRequest struct {
	Name       string   `json:"name"`
	ProjectIDs []string `json:"project_ids"`
}

func NewService(pool *pgxpool.Pool, cfg Config, provider Provider) (*Service, error) {
	if pool == nil {
		return nil, errors.New("auth database pool must not be nil")
	}
	if cfg.SessionCookieName == "" {
		cfg.SessionCookieName = "loomhelm_session"
	}
	if cfg.SessionLifetime <= 0 {
		cfg.SessionLifetime = 24 * time.Hour
	}
	if cfg.SessionCookiePath == "" {
		cfg.SessionCookiePath = "/"
	}
	if cfg.SuccessRedirect == "" {
		cfg.SuccessRedirect = "/"
	}
	manager := scs.New()
	manager.Store = &pgxStore{pool: pool}
	manager.Lifetime = cfg.SessionLifetime
	manager.Cookie.Name = cfg.SessionCookieName
	manager.Cookie.Path = cfg.SessionCookiePath
	manager.Cookie.HttpOnly = true
	manager.Cookie.Secure = cfg.SecureCookies
	manager.Cookie.SameSite = http.SameSiteLaxMode
	return &Service{pool: pool, sessions: manager, oidc: provider, cfg: cfg, now: time.Now}, nil
}

func (s *Service) Middleware(next http.Handler) http.Handler {
	if s == nil || s.sessions == nil {
		return next
	}
	return s.sessions.LoadAndSave(next)
}

// Mount adds relative auth routes. The caller owns the /api/v1 prefix and
// should call MountAPI on the router inside that prefix.
func (s *Service) Mount(r chi.Router) {
	r.Route("/auth", func(authRouter chi.Router) {
		authRouter.Get("/oidc/start", s.handleOIDCStart)
		authRouter.Get("/oidc/callback", s.handleOIDCCallback)
		authRouter.Post("/logout", s.handleLogout)
		authRouter.Get("/me", s.handleMe)
	})
}

func (s *Service) MountAPI(r chi.Router) {
	for _, path := range []string{"/credentials", "/credentials/"} {
		r.Get(path, s.handleListCredentials)
		r.Post(path, s.handleCreateCredential)
	}
	r.Delete("/credentials/{credential_id}", s.handleRevokeCredential)
}

func (s *Service) ResolvePrincipal(ctx context.Context, request *http.Request) (Principal, error) {
	if s == nil || s.pool == nil || s.sessions == nil || request == nil {
		return Principal{}, ErrUnauthenticated
	}
	if raw, ok := bearerToken(request.Header.Get("Authorization")); ok {
		return s.resolveCredential(ctx, raw)
	}
	userID := s.sessions.GetString(ctx, "user_id")
	if userID == "" {
		return Principal{}, ErrUnauthenticated
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM auth_users WHERE id = $1)`, userID).Scan(&exists); err != nil {
		return Principal{}, fmt.Errorf("resolve session user: %w", err)
	}
	if !exists {
		return Principal{}, ErrUnauthenticated
	}
	return Principal{UserID: userID}, nil
}

func (s *Service) resolveCredential(ctx context.Context, raw string) (Principal, error) {
	hash := sha256.Sum256([]byte(raw))
	var principal Principal
	rows, err := s.pool.Query(ctx, `
		SELECT credential.id, credential.user_id, scope.project_id
		FROM auth_api_credentials AS credential
		LEFT JOIN auth_api_credential_project_scopes AS scope
			ON scope.credential_id = credential.id
		WHERE credential.token_hash = $1 AND credential.revoked_at IS NULL
		ORDER BY scope.project_id
	`, hash[:])
	if err != nil {
		return Principal{}, fmt.Errorf("resolve API credential: %w", err)
	}
	defer rows.Close()
	found := false
	principal.ProjectScope = make(map[string]struct{})
	for rows.Next() {
		var credentialID, userID string
		var projectID *string
		if err := rows.Scan(&credentialID, &userID, &projectID); err != nil {
			return Principal{}, fmt.Errorf("scan API credential: %w", err)
		}
		if !found {
			principal.CredentialID = credentialID
			principal.UserID = userID
			found = true
		}
		if projectID != nil {
			principal.ProjectScope[*projectID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return Principal{}, fmt.Errorf("read API credential: %w", err)
	}
	if !found {
		return Principal{}, ErrUnauthenticated
	}
	if _, err := s.pool.Exec(ctx, `UPDATE auth_api_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`, principal.CredentialID); err != nil {
		return Principal{}, fmt.Errorf("record API credential use: %w", err)
	}
	if len(principal.ProjectScope) == 0 {
		principal.ProjectScope = nil
	}
	return principal, nil
}

func (s *Service) CreateCredential(ctx context.Context, principal Principal, request CreateCredentialRequest) (Credential, error) {
	if principal.UserID == "" {
		return Credential{}, ErrUnauthenticated
	}
	name := strings.TrimSpace(request.Name)
	if name == "" || len(name) > 128 {
		return Credential{}, fmt.Errorf("%w: credential name must be between 1 and 128 characters", ErrInvalid)
	}
	projectIDs := uniqueStrings(request.ProjectIDs)
	if len(principal.ProjectScope) > 0 && len(projectIDs) == 0 {
		return Credential{}, ErrForbidden
	}
	for _, projectID := range projectIDs {
		if !principal.HasProjectScope(projectID) {
			return Credential{}, ErrForbidden
		}
	}
	credentialID, err := randomID("cred")
	if err != nil {
		return Credential{}, err
	}
	secret, err := randomToken(32)
	if err != nil {
		return Credential{}, err
	}
	rawToken := "lh_" + credentialID + "_" + secret
	hash := sha256.Sum256([]byte(rawToken))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Credential{}, fmt.Errorf("begin credential transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT id
		FROM projects
		WHERE id = ANY($1::text[])
		ORDER BY id
		FOR SHARE
	`, projectIDs)
	if err != nil {
		return Credential{}, fmt.Errorf("lock credential projects: %w", err)
	}
	lockedProjects := make(map[string]struct{}, len(projectIDs))
	for rows.Next() {
		var projectID string
		if err := rows.Scan(&projectID); err != nil {
			rows.Close()
			return Credential{}, fmt.Errorf("scan locked credential project: %w", err)
		}
		lockedProjects[projectID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Credential{}, fmt.Errorf("read locked credential projects: %w", err)
	}
	rows.Close()
	if len(lockedProjects) != len(projectIDs) {
		return Credential{}, ErrNotFound
	}
	for _, projectID := range projectIDs {
		var allowed bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM project_members
				WHERE project_id = $1 AND user_id = $2
			)
		`, projectID, principal.UserID).Scan(&allowed); err != nil {
			return Credential{}, fmt.Errorf("check credential project scope: %w", err)
		}
		if !allowed {
			return Credential{}, ErrForbidden
		}
	}
	var createdAt time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO auth_api_credentials (id, user_id, name, token_hash)
		VALUES ($1, $2, $3, $4)
		RETURNING created_at
	`, credentialID, principal.UserID, name, hash[:]).Scan(&createdAt); err != nil {
		return Credential{}, fmt.Errorf("create API credential: %w", err)
	}
	for _, projectID := range projectIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO auth_api_credential_project_scopes (credential_id, project_id)
			VALUES ($1, $2)
		`, credentialID, projectID); err != nil {
			return Credential{}, fmt.Errorf("create API credential scope: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Credential{}, fmt.Errorf("commit API credential: %w", err)
	}
	return Credential{ID: credentialID, Name: name, ProjectIDs: projectIDs, CreatedAt: formatTime(createdAt), Token: rawToken}, nil
}

func (s *Service) ListCredentials(ctx context.Context, principal Principal) ([]Credential, error) {
	if principal.UserID == "" {
		return nil, ErrUnauthenticated
	}
	if len(principal.ProjectScope) > 0 {
		return nil, ErrForbidden
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, created_at, last_used_at, revoked_at
		FROM auth_api_credentials
		WHERE user_id = $1
		ORDER BY created_at, id
	`, principal.UserID)
	if err != nil {
		return nil, fmt.Errorf("list API credentials: %w", err)
	}
	defer rows.Close()
	credentials := make([]Credential, 0)
	for rows.Next() {
		var credential Credential
		var createdAt time.Time
		var lastUsedAt, revokedAt *time.Time
		if err := rows.Scan(&credential.ID, &credential.Name, &createdAt, &lastUsedAt, &revokedAt); err != nil {
			return nil, fmt.Errorf("scan API credential: %w", err)
		}
		credential.CreatedAt = formatTime(createdAt)
		credential.LastUsedAt = formatOptionalTime(lastUsedAt)
		credential.RevokedAt = formatOptionalTime(revokedAt)
		credential.ProjectIDs, err = s.credentialScopes(ctx, credential.ID)
		if err != nil {
			return nil, err
		}
		credentials = append(credentials, credential)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read API credentials: %w", err)
	}
	return credentials, nil
}

func (s *Service) credentialScopes(ctx context.Context, credentialID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT project_id FROM auth_api_credential_project_scopes
		WHERE credential_id = $1 ORDER BY project_id
	`, credentialID)
	if err != nil {
		return nil, fmt.Errorf("list API credential scopes: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var projectID string
		if err := rows.Scan(&projectID); err != nil {
			return nil, fmt.Errorf("scan API credential scope: %w", err)
		}
		result = append(result, projectID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read API credential scopes: %w", err)
	}
	return result, nil
}

func (s *Service) RevokeCredential(ctx context.Context, principal Principal, credentialID string) error {
	if principal.UserID == "" {
		return ErrUnauthenticated
	}
	if len(principal.ProjectScope) > 0 {
		return ErrForbidden
	}
	command, err := s.pool.Exec(ctx, `
		UPDATE auth_api_credentials
		SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
		WHERE id = $1 AND user_id = $2
	`, credentialID, principal.UserID)
	if err != nil {
		return fmt.Errorf("revoke API credential: %w", err)
	}
	if command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Service) upsertIdentity(ctx context.Context, identity Identity) (User, error) {
	issuer := strings.TrimSpace(identity.Issuer)
	subject := strings.TrimSpace(identity.Subject)
	if issuer == "" || subject == "" {
		return User{}, fmt.Errorf("%w: OIDC issuer and subject are required", ErrInvalid)
	}
	userID, err := identityID(issuer, subject)
	if err != nil {
		return User{}, err
	}
	var user User
	var createdAt, updatedAt time.Time
	err = s.pool.QueryRow(ctx, `
		INSERT INTO auth_users (id, issuer, subject, email, display_name)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (issuer, subject) DO UPDATE SET
			email = EXCLUDED.email,
			display_name = EXCLUDED.display_name,
			updated_at = CURRENT_TIMESTAMP
		RETURNING id, issuer, subject, email, display_name, created_at, updated_at
	`, userID, issuer, subject, strings.TrimSpace(identity.Email), strings.TrimSpace(identity.DisplayName)).Scan(
		&user.ID, &user.Issuer, &user.Subject, &user.Email, &user.DisplayName, &createdAt, &updatedAt,
	)
	if err != nil {
		return User{}, fmt.Errorf("upsert OIDC identity: %w", err)
	}
	user.CreatedAt = formatTime(createdAt)
	user.UpdatedAt = formatTime(updatedAt)
	return user, nil
}

func identityID(issuer, subject string) (string, error) {
	return stableID("user", issuer+"\x00"+subject), nil
}

func (s *Service) handleOIDCStart(writer http.ResponseWriter, request *http.Request) {
	if s.oidc == nil {
		writeError(writer, request, http.StatusServiceUnavailable, ErrInvalid, "OIDC is not configured")
		return
	}
	state, err := randomToken(32)
	if err != nil {
		writeError(writer, request, http.StatusInternalServerError, err, "failed to create OIDC state")
		return
	}
	nonce, err := randomToken(32)
	if err != nil {
		writeError(writer, request, http.StatusInternalServerError, err, "failed to create OIDC nonce")
		return
	}
	s.sessions.Put(request.Context(), "oidc_state", state)
	s.sessions.Put(request.Context(), "oidc_nonce", nonce)
	location, err := s.oidc.AuthorizationURL(state, nonce)
	if err != nil {
		writeError(writer, request, http.StatusServiceUnavailable, err, "failed to create OIDC authorization URL")
		return
	}
	http.Redirect(writer, request, location, http.StatusFound)
}

func (s *Service) handleOIDCCallback(writer http.ResponseWriter, request *http.Request) {
	if s.oidc == nil {
		writeError(writer, request, http.StatusServiceUnavailable, ErrInvalid, "OIDC is not configured")
		return
	}
	if callbackError := request.URL.Query().Get("error"); callbackError != "" {
		writeError(writer, request, http.StatusUnauthorized, fmt.Errorf("%w: OIDC provider returned %s", ErrUnauthenticated, callbackError), "OIDC login was rejected")
		return
	}
	state := request.URL.Query().Get("state")
	expectedState := s.sessions.GetString(request.Context(), "oidc_state")
	nonce := s.sessions.GetString(request.Context(), "oidc_nonce")
	if state == "" || expectedState == "" || nonce == "" || !secureEqual(state, expectedState) {
		writeError(writer, request, http.StatusBadRequest, ErrInvalid, "invalid OIDC state")
		return
	}
	code := request.URL.Query().Get("code")
	if code == "" {
		writeError(writer, request, http.StatusBadRequest, ErrInvalid, "OIDC callback code is required")
		return
	}
	identity, err := s.oidc.Exchange(request.Context(), code, nonce)
	if err != nil {
		writeError(writer, request, http.StatusUnauthorized, err, "OIDC identity verification failed")
		return
	}
	user, err := s.upsertIdentity(request.Context(), identity)
	if err != nil {
		writeError(writer, request, http.StatusInternalServerError, err, "failed to persist OIDC identity")
		return
	}
	if err := s.sessions.RenewToken(request.Context()); err != nil {
		writeError(writer, request, http.StatusInternalServerError, err, "failed to rotate session")
		return
	}
	s.sessions.Put(request.Context(), "user_id", user.ID)
	s.sessions.Remove(request.Context(), "oidc_state")
	s.sessions.Remove(request.Context(), "oidc_nonce")
	http.Redirect(writer, request, s.cfg.SuccessRedirect, http.StatusFound)
}

func (s *Service) handleLogout(writer http.ResponseWriter, request *http.Request) {
	if err := s.sessions.Destroy(request.Context()); err != nil {
		writeError(writer, request, http.StatusInternalServerError, err, "failed to end session")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleMe(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.ResolvePrincipal(request.Context(), request)
	if err != nil {
		writeError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	user, err := s.user(request.Context(), principal.UserID)
	if err != nil {
		writeError(writer, request, http.StatusInternalServerError, err, "failed to load current user")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]User{"user": user})
}

func (s *Service) user(ctx context.Context, userID string) (User, error) {
	var user User
	var createdAt, updatedAt time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, issuer, subject, email, display_name, created_at, updated_at
		FROM auth_users WHERE id = $1
	`, userID).Scan(&user.ID, &user.Issuer, &user.Subject, &user.Email, &user.DisplayName, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("load user: %w", err)
	}
	user.CreatedAt = formatTime(createdAt)
	user.UpdatedAt = formatTime(updatedAt)
	return user, nil
}

func (s *Service) handleListCredentials(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.ResolvePrincipal(request.Context(), request)
	if err != nil {
		writeError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	credentials, err := s.ListCredentials(request.Context(), principal)
	if err != nil {
		writeError(writer, request, statusForError(err), err, "failed to list credentials")
		return
	}
	writeJSON(writer, http.StatusOK, map[string][]Credential{"items": credentials})
}

func (s *Service) handleCreateCredential(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.ResolvePrincipal(request.Context(), request)
	if err != nil {
		writeError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	var body CreateCredentialRequest
	if err := decodeJSON(request, &body); err != nil {
		writeError(writer, request, http.StatusBadRequest, err, "invalid credential request")
		return
	}
	credential, err := s.CreateCredential(request.Context(), principal, body)
	if err != nil {
		writeError(writer, request, statusForError(err), err, "failed to create credential")
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]Credential{"credential": credential})
}

func (s *Service) handleRevokeCredential(writer http.ResponseWriter, request *http.Request) {
	principal, err := s.ResolvePrincipal(request.Context(), request)
	if err != nil {
		writeError(writer, request, http.StatusUnauthorized, err, "authentication required")
		return
	}
	if err := s.RevokeCredential(request.Context(), principal, chi.URLParam(request, "credential_id")); err != nil {
		writeError(writer, request, statusForError(err), err, "failed to revoke credential")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func bearerToken(value string) (string, bool) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

func decodeJSON(request *http.Request, destination any) error {
	if request == nil || request.Body == nil {
		return fmt.Errorf("%w: request body is required", ErrInvalid)
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("%w: request body must contain one JSON value", ErrInvalid)
	}
	return nil
}

func DecodeJSON(request *http.Request, destination any) error {
	return decodeJSON(request, destination)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func WriteJSON(writer http.ResponseWriter, status int, value any) { writeJSON(writer, status, value) }

func writeError(writer http.ResponseWriter, request *http.Request, status int, err error, message string) {
	code := protocol.ErrorCodeInvalidRequest
	switch {
	case errors.Is(err, ErrUnauthenticated):
		code = protocol.ErrorCodeUnauthorized
	case errors.Is(err, ErrForbidden):
		code = protocol.ErrorCodeUnauthorized
	case errors.Is(err, ErrNotFound):
		code = protocol.ErrorCodeNotFound
	case errors.Is(err, ErrConflict):
		code = protocol.ErrorCodeConflict
	}
	requestID := ""
	if request != nil {
		requestID = request.Header.Get("X-Request-ID")
	}
	if requestID == "" {
		requestID, _ = randomID("req")
	}
	writeJSON(writer, status, protocol.ApiError{Code: code, Message: message, RequestID: requestID})
}

func WriteError(writer http.ResponseWriter, request *http.Request, status int, err error, message string) {
	writeError(writer, request, status, err, message)
}

func statusForError(err error) int {
	switch {
	case errors.Is(err, ErrUnauthenticated):
		return http.StatusUnauthorized
	case errors.Is(err, ErrForbidden):
		return http.StatusForbidden
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, ErrConflict):
		return http.StatusConflict
	case errors.Is(err, ErrInvalid):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

func StatusForError(err error) int { return statusForError(err) }

func randomToken(size int) (string, error) {
	if size <= 0 {
		return "", fmt.Errorf("token size must be positive")
	}
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func randomID(prefix string) (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate %s id: %w", prefix, err)
	}
	return prefix + "_" + hex.EncodeToString(value), nil
}

func stableID(prefix, value string) string {
	digest := sha256.Sum256([]byte(value))
	return prefix + "_" + hex.EncodeToString(digest[:16])
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}

func secureEqual(a, b string) bool {
	left := sha256.Sum256([]byte(a))
	right := sha256.Sum256([]byte(b))
	return left == right
}
