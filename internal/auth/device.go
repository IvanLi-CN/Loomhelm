package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	connectorDeviceLifetime = 10 * time.Minute
	connectorDeviceCodeSize = 8
	connectorDeviceCodeURL  = "/api/v1/auth/device/verify"
	connectorExchangeClaim  = 2 * time.Minute
)

type connectorDeviceAuthorization struct {
	ID                   string
	RedirectURI          string
	State                string
	ExpiresAt            time.Time
	AuthorizedUserID     string
	RequestedHostID      string
	AuthorizationCodeSet bool
}

type connectorDeviceStore interface {
	Create(context.Context, connectorDeviceAuthorization, []byte, []byte) error
	Lookup(context.Context, []byte, time.Time) (connectorDeviceAuthorization, error)
	Authorize(context.Context, []byte, string, []byte, time.Time) (connectorDeviceAuthorization, error)
	Claim(context.Context, []byte, time.Time) (connectorDeviceAuthorization, error)
	Complete(context.Context, []byte, time.Time) error
	Release(context.Context, []byte, time.Time) error
}

type connectorDeviceFlow struct {
	store    connectorDeviceStore
	enroller ConnectorEnrollment
	now      func() time.Time
}

func newConnectorDeviceFlow(pool *pgxpool.Pool, connector ConnectorAuth) *connectorDeviceFlow {
	return &connectorDeviceFlow{
		store:    &postgresConnectorDeviceStore{pool: pool},
		enroller: connector,
		now:      time.Now,
	}
}

type connectorDeviceStartRequest struct {
	RedirectURI string `json:"redirect_uri"`
	State       string `json:"state"`
	HostID      string `json:"host_id,omitempty"`
}

type connectorDeviceStartResponse struct {
	VerificationURI string `json:"verification_uri"`
	UserCode        string `json:"user_code"`
	ExpiresIn       int    `json:"expires_in"`
}

type connectorDeviceTokenRequest struct {
	Code string `json:"code"`
}

func (f *connectorDeviceFlow) start(ctx context.Context, request connectorDeviceStartRequest) (connectorDeviceStartResponse, error) {
	if f == nil || f.store == nil || f.enroller == nil {
		return connectorDeviceStartResponse{}, ErrUnavailable
	}
	redirectURI, err := validateConnectorCallbackURI(request.RedirectURI)
	if err != nil {
		return connectorDeviceStartResponse{}, err
	}
	state := strings.TrimSpace(request.State)
	if len(state) < 16 || len(state) > 256 || strings.ContainsAny(state, " \t\r\n\x00") {
		return connectorDeviceStartResponse{}, fmt.Errorf("%w: device state is invalid", ErrInvalid)
	}
	hostID := strings.TrimSpace(request.HostID)
	if len(hostID) > 256 || strings.ContainsAny(hostID, " \t\r\n\x00") {
		return connectorDeviceStartResponse{}, fmt.Errorf("%w: requested Host is invalid", ErrInvalid)
	}
	code, normalized := newConnectorDeviceCode()
	if code == "" {
		return connectorDeviceStartResponse{}, errors.New("generate connector device code")
	}
	id, err := randomID("cdevice")
	if err != nil {
		return connectorDeviceStartResponse{}, err
	}
	now := f.now()
	expiresAt := now.Add(connectorDeviceLifetime)
	userCodeHash := sha256.Sum256([]byte(normalized))
	if err := f.store.Create(ctx, connectorDeviceAuthorization{
		ID:              id,
		RedirectURI:     redirectURI,
		State:           state,
		ExpiresAt:       expiresAt,
		RequestedHostID: hostID,
	}, userCodeHash[:], nil); err != nil {
		return connectorDeviceStartResponse{}, err
	}
	query := url.Values{}
	query.Set("user_code", code)
	return connectorDeviceStartResponse{
		VerificationURI: connectorDeviceCodeURL + "?" + query.Encode(),
		UserCode:        code,
		ExpiresIn:       int(connectorDeviceLifetime / time.Second),
	}, nil
}

func (f *connectorDeviceFlow) lookup(ctx context.Context, code string) (connectorDeviceAuthorization, error) {
	normalized, err := normalizeConnectorDeviceCode(code)
	if err != nil {
		return connectorDeviceAuthorization{}, err
	}
	hash := sha256.Sum256([]byte(normalized))
	return f.store.Lookup(ctx, hash[:], f.now())
}

func (f *connectorDeviceFlow) authorize(ctx context.Context, code, userID string) (string, error) {
	normalized, err := normalizeConnectorDeviceCode(code)
	if err != nil {
		return "", err
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", ErrUnauthenticated
	}
	authorizationCode, err := randomToken(32)
	if err != nil {
		return "", err
	}
	userCodeHash := sha256.Sum256([]byte(normalized))
	authorizationCodeHash := sha256.Sum256([]byte(authorizationCode))
	record, err := f.store.Authorize(ctx, userCodeHash[:], userID, authorizationCodeHash[:], f.now())
	if err != nil {
		return "", err
	}
	redirect, err := url.Parse(record.RedirectURI)
	if err != nil {
		return "", fmt.Errorf("%w: device callback URI is invalid", ErrInvalid)
	}
	query := redirect.Query()
	query.Set("code", authorizationCode)
	query.Set("state", record.State)
	redirect.RawQuery = query.Encode()
	return redirect.String(), nil
}

func (f *connectorDeviceFlow) exchange(ctx context.Context, code string) (string, error) {
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 512 {
		return "", fmt.Errorf("%w: device authorization code is invalid", ErrInvalid)
	}
	hash := sha256.Sum256([]byte(code))
	now := f.now()
	record, err := f.store.Claim(ctx, hash[:], now)
	if err != nil {
		return "", err
	}
	credential, err := f.enroller.EnrollConnector(ctx, record.AuthorizedUserID, record.RequestedHostID, record.ID, code)
	if err != nil {
		_ = f.store.Release(ctx, hash[:], now)
		return "", err
	}
	if err := f.store.Complete(ctx, hash[:], now); err != nil {
		return "", err
	}
	return EncodeConnectorAPIKey(credential.HostID, credential.Token)
}

func (s *Service) handleConnectorDeviceStart(writer http.ResponseWriter, request *http.Request) {
	if s.devices == nil {
		writeError(writer, request, http.StatusServiceUnavailable, ErrUnavailable, "Connector enrollment is unavailable")
		return
	}
	var payload connectorDeviceStartRequest
	if err := decodeJSON(request, &payload); err != nil {
		writeError(writer, request, http.StatusBadRequest, err, "invalid Connector enrollment request")
		return
	}
	response, err := s.devices.start(request.Context(), payload)
	if err != nil {
		writeError(writer, request, statusForError(err), err, "failed to start Connector enrollment")
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

func (s *Service) handleConnectorDeviceVerify(writer http.ResponseWriter, request *http.Request) {
	if s.devices == nil {
		writeError(writer, request, http.StatusServiceUnavailable, ErrUnavailable, "Connector enrollment is unavailable")
		return
	}
	code := request.URL.Query().Get("user_code")
	if request.Method == http.MethodPost {
		if err := request.ParseForm(); err != nil {
			writeError(writer, request, http.StatusBadRequest, ErrInvalid, "invalid Connector enrollment form")
			return
		}
		if code == "" {
			code = request.Form.Get("user_code")
		}
	}
	_, err := s.devices.lookup(request.Context(), code)
	if err != nil {
		writeError(writer, request, http.StatusBadRequest, err, "Connector enrollment code is invalid or expired")
		return
	}
	principal, principalErr := s.ResolvePrincipal(request.Context(), request)
	if principalErr != nil {
		if request.Method == http.MethodGet && errors.Is(principalErr, ErrUnauthenticated) {
			location := connectorOIDCStartPath(request.URL.Path) + "?return_to=" + url.QueryEscape(request.URL.RequestURI())
			http.Redirect(writer, request, location, http.StatusFound)
			return
		}
		writeError(writer, request, statusForError(principalErr), principalErr, "browser authentication is required")
		return
	}
	if principal.UserID == "" || principal.CredentialID != "" {
		writeError(writer, request, http.StatusUnauthorized, ErrUnauthenticated, "browser authentication is required")
		return
	}
	if request.Method == http.MethodPost {
		location, err := s.devices.authorize(request.Context(), code, principal.UserID)
		if err != nil {
			writeError(writer, request, statusForError(err), err, "failed to authorize Connector")
			return
		}
		http.Redirect(writer, request, location, http.StatusFound)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprintf(writer, "<!doctype html><html><head><title>Loomhelm Connector</title></head><body><h1>Authorize Loomhelm Connector</h1><p>Authorize this computer to use your Loomhelm Host.</p><form method=post action=%q><input type=hidden name=user_code value=%q><button type=submit>Authorize Connector</button></form></body></html>", html.EscapeString(request.URL.Path), html.EscapeString(code))
}

func (s *Service) handleConnectorDeviceToken(writer http.ResponseWriter, request *http.Request) {
	if s.devices == nil {
		writeError(writer, request, http.StatusServiceUnavailable, ErrUnavailable, "Connector enrollment is unavailable")
		return
	}
	var payload connectorDeviceTokenRequest
	if err := decodeJSON(request, &payload); err != nil {
		writeError(writer, request, http.StatusBadRequest, err, "invalid Connector token request")
		return
	}
	apiKey, err := s.devices.exchange(request.Context(), payload.Code)
	if err != nil {
		writeError(writer, request, statusForError(err), err, "Connector enrollment code is invalid or expired")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"api_key": apiKey})
}

func (s *Service) handleConnectorIdentity(writer http.ResponseWriter, request *http.Request) {
	if s.cfg.ConnectorAuth == nil {
		writeError(writer, request, http.StatusServiceUnavailable, ErrUnavailable, "Connector enrollment is unavailable")
		return
	}
	raw, ok := bearerToken(request.Header.Get("Authorization"))
	if !ok {
		writeError(writer, request, http.StatusUnauthorized, ErrUnauthenticated, "Connector credential is required")
		return
	}
	hostID, err := s.cfg.ConnectorAuth.ResolveConnectorCredential(request.Context(), raw)
	if err != nil {
		writeError(writer, request, statusForError(err), err, "Connector credential is invalid")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"host_id": hostID})
}

func safeAuthReturnTo(raw string) string {
	if raw == "" || strings.ContainsAny(raw, "\\\x00\r\n") || strings.HasPrefix(raw, "//") {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || !strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") {
		return ""
	}
	if strings.Contains(parsed.Path, "\\") || strings.Contains(strings.ToLower(parsed.RawPath), "%5c") {
		return ""
	}
	return parsed.RequestURI()
}

func connectorOIDCStartPath(deviceVerifyPath string) string {
	const deviceVerifySuffix = "/auth/device/verify"
	if strings.HasSuffix(deviceVerifyPath, deviceVerifySuffix) {
		return strings.TrimSuffix(deviceVerifyPath, deviceVerifySuffix) + "/auth/oidc/start"
	}
	return "/api/v1/auth/oidc/start"
}

func validateConnectorCallbackURI(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "/callback" {
		return "", fmt.Errorf("%w: Connector callback must be a loopback HTTP callback", ErrInvalid)
	}
	if parsed.Port() == "" {
		return "", fmt.Errorf("%w: Connector callback port is required", ErrInvalid)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("%w: Connector callback port is invalid", ErrInvalid)
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return "", fmt.Errorf("%w: Connector callback must use loopback", ErrInvalid)
	}
	return parsed.String(), nil
}

func newConnectorDeviceCode() (string, string) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buffer := make([]byte, 0, connectorDeviceCodeSize)
	var random [32]byte
	limit := 256 - (256 % len(alphabet))
	for len(buffer) < connectorDeviceCodeSize {
		if _, err := rand.Read(random[:]); err != nil {
			return "", ""
		}
		for _, value := range random {
			if int(value) >= limit {
				continue
			}
			buffer = append(buffer, alphabet[int(value)%len(alphabet)])
			if len(buffer) == connectorDeviceCodeSize {
				break
			}
		}
	}
	normalized := string(buffer)
	return normalized[:4] + "-" + normalized[4:], normalized
}

func normalizeConnectorDeviceCode(value string) (string, error) {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), "-", ""))
	if len(normalized) != connectorDeviceCodeSize {
		return "", fmt.Errorf("%w: Connector enrollment code is invalid", ErrInvalid)
	}
	for _, character := range normalized {
		if !strings.ContainsRune("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", character) {
			return "", fmt.Errorf("%w: Connector enrollment code is invalid", ErrInvalid)
		}
	}
	return normalized, nil
}

type postgresConnectorDeviceStore struct{ pool *pgxpool.Pool }

func (s *postgresConnectorDeviceStore) Create(ctx context.Context, record connectorDeviceAuthorization, userCodeHash, authorizationCodeHash []byte) error {
	if err := s.cleanup(ctx, record.ExpiresAt); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO connector_device_authorizations (id, user_code_hash, redirect_uri, state, expires_at, requested_host_id, authorization_code_hash)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7)
	`, record.ID, userCodeHash, record.RedirectURI, record.State, record.ExpiresAt, record.RequestedHostID, authorizationCodeHash); err != nil {
		return fmt.Errorf("%w: create Connector device authorization: %v", ErrUnavailable, err)
	}
	return nil
}

func (s *postgresConnectorDeviceStore) Lookup(ctx context.Context, userCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if err := s.cleanup(ctx, now); err != nil {
		return connectorDeviceAuthorization{}, err
	}
	var record connectorDeviceAuthorization
	var userID *string
	var requestedHostID *string
	var authorizationCodeHash []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, redirect_uri, state, expires_at, authorized_user_id, requested_host_id, authorization_code_hash
		FROM connector_device_authorizations
		WHERE user_code_hash = $1
	`, userCodeHash).Scan(&record.ID, &record.RedirectURI, &record.State, &record.ExpiresAt, &userID, &requestedHostID, &authorizationCodeHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: Connector enrollment code is invalid", ErrInvalid)
	}
	if err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: load Connector device authorization: %v", ErrUnavailable, err)
	}
	if !record.ExpiresAt.After(now) || userID != nil || len(authorizationCodeHash) != 0 {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: Connector enrollment code is invalid or expired", ErrInvalid)
	}
	if requestedHostID != nil {
		record.RequestedHostID = *requestedHostID
	}
	return record, nil
}

func (s *postgresConnectorDeviceStore) Authorize(ctx context.Context, userCodeHash []byte, userID string, authorizationCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if err := s.cleanup(ctx, now); err != nil {
		return connectorDeviceAuthorization{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: begin Connector authorization: %v", ErrUnavailable, err)
	}
	defer tx.Rollback(ctx)
	var record connectorDeviceAuthorization
	var authorizedUserID *string
	var requestedHostID *string
	var existingCode []byte
	err = tx.QueryRow(ctx, `
		SELECT id, redirect_uri, state, expires_at, authorized_user_id, requested_host_id, authorization_code_hash
		FROM connector_device_authorizations
		WHERE user_code_hash = $1
		FOR UPDATE
	`, userCodeHash).Scan(&record.ID, &record.RedirectURI, &record.State, &record.ExpiresAt, &authorizedUserID, &requestedHostID, &existingCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: Connector enrollment code is invalid", ErrInvalid)
	}
	if err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: load Connector device authorization: %v", ErrUnavailable, err)
	}
	if !record.ExpiresAt.After(now) || authorizedUserID != nil || len(existingCode) != 0 {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: Connector enrollment code is invalid or expired", ErrInvalid)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE connector_device_authorizations
		SET authorized_user_id = $2, authorization_code_hash = $3, authorized_at = $4
		WHERE id = $1
	`, record.ID, userID, authorizationCodeHash, now); err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: authorize Connector device: %v", ErrUnavailable, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: commit Connector device authorization: %v", ErrUnavailable, err)
	}
	record.AuthorizedUserID = userID
	if requestedHostID != nil {
		record.RequestedHostID = *requestedHostID
	}
	record.AuthorizationCodeSet = true
	return record, nil
}

func (s *postgresConnectorDeviceStore) Claim(ctx context.Context, authorizationCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if err := s.cleanup(ctx, now); err != nil {
		return connectorDeviceAuthorization{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: begin Connector token exchange: %v", ErrUnavailable, err)
	}
	defer tx.Rollback(ctx)
	var record connectorDeviceAuthorization
	var consumedAt *time.Time
	var authorizedUserID *string
	var requestedHostID *string
	var exchangeStartedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, redirect_uri, state, expires_at, authorized_user_id, requested_host_id, consumed_at, exchange_started_at
		FROM connector_device_authorizations
		WHERE authorization_code_hash = $1
		FOR UPDATE
	`, authorizationCodeHash).Scan(&record.ID, &record.RedirectURI, &record.State, &record.ExpiresAt, &authorizedUserID, &requestedHostID, &consumedAt, &exchangeStartedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: Connector authorization code is invalid", ErrInvalid)
	}
	if err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: load Connector authorization code: %v", ErrUnavailable, err)
	}
	if consumedAt != nil || !record.ExpiresAt.After(now) || authorizedUserID == nil || (exchangeStartedAt != nil && now.Sub(*exchangeStartedAt) < connectorExchangeClaim) {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: Connector authorization code is invalid or expired", ErrInvalid)
	}
	if _, err := tx.Exec(ctx, `UPDATE connector_device_authorizations SET exchange_started_at = $2 WHERE id = $1`, record.ID, now); err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: claim Connector authorization code: %v", ErrUnavailable, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return connectorDeviceAuthorization{}, fmt.Errorf("%w: commit Connector token claim: %v", ErrUnavailable, err)
	}
	record.AuthorizedUserID = *authorizedUserID
	if requestedHostID != nil {
		record.RequestedHostID = *requestedHostID
	}
	return record, nil
}

func (s *postgresConnectorDeviceStore) Complete(ctx context.Context, authorizationCodeHash []byte, now time.Time) error {
	result, err := s.pool.Exec(ctx, `
		UPDATE connector_device_authorizations
		SET consumed_at = $2, exchange_started_at = NULL
		WHERE authorization_code_hash = $1 AND consumed_at IS NULL AND exchange_started_at = $2
	`, authorizationCodeHash, now)
	if err != nil {
		return fmt.Errorf("%w: complete Connector token exchange: %v", ErrUnavailable, err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("%w: Connector authorization code is no longer exchangeable", ErrInvalid)
	}
	return nil
}

func (s *postgresConnectorDeviceStore) Release(ctx context.Context, authorizationCodeHash []byte, now time.Time) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE connector_device_authorizations
		SET exchange_started_at = NULL
		WHERE authorization_code_hash = $1 AND consumed_at IS NULL AND exchange_started_at = $2
	`, authorizationCodeHash, now); err != nil {
		return fmt.Errorf("%w: release Connector token claim: %v", ErrUnavailable, err)
	}
	return nil
}

func (s *postgresConnectorDeviceStore) cleanup(ctx context.Context, now time.Time) error {
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM connector_device_authorizations
		WHERE expires_at < $1 - INTERVAL '1 hour'
	`, now); err != nil {
		return fmt.Errorf("%w: cleanup expired Connector authorizations: %v", ErrUnavailable, err)
	}
	return nil
}
