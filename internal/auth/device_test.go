package auth

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

type connectorDeviceStoreFake struct {
	record        connectorDeviceAuthorization
	userCodeHash  []byte
	authorization []byte
	consumed      bool
	claimed       bool
	claimedAt     time.Time
	completeErr   error
}

func (s *connectorDeviceStoreFake) Create(_ context.Context, record connectorDeviceAuthorization, userCodeHash, _ []byte) error {
	s.record = record
	s.userCodeHash = append([]byte(nil), userCodeHash...)
	return nil
}

func (s *connectorDeviceStoreFake) Lookup(_ context.Context, userCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if string(userCodeHash) != string(s.userCodeHash) || !s.record.ExpiresAt.After(now) || s.record.AuthorizationCodeSet {
		return connectorDeviceAuthorization{}, ErrInvalid
	}
	return s.record, nil
}

func (s *connectorDeviceStoreFake) Authorize(_ context.Context, userCodeHash []byte, userID string, authorizationCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if string(userCodeHash) != string(s.userCodeHash) || !s.record.ExpiresAt.After(now) || s.record.AuthorizationCodeSet {
		return connectorDeviceAuthorization{}, ErrInvalid
	}
	s.record.AuthorizedUserID = userID
	s.record.AuthorizationCodeSet = true
	s.authorization = append([]byte(nil), authorizationCodeHash...)
	return s.record, nil
}

func (s *connectorDeviceStoreFake) Claim(_ context.Context, authorizationCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if s.consumed || string(authorizationCodeHash) != string(s.authorization) || !s.record.ExpiresAt.After(now) || (s.claimed && now.Sub(s.claimedAt) < connectorExchangeClaim) {
		return connectorDeviceAuthorization{}, ErrInvalid
	}
	s.claimed = true
	s.claimedAt = now
	return s.record, nil
}

func (s *connectorDeviceStoreFake) Complete(_ context.Context, authorizationCodeHash []byte, now time.Time) error {
	if !s.claimed || string(authorizationCodeHash) != string(s.authorization) || !s.claimedAt.Equal(now) {
		return ErrInvalid
	}
	if s.completeErr != nil {
		err := s.completeErr
		s.completeErr = nil
		return err
	}
	s.claimed = false
	s.claimedAt = time.Time{}
	s.consumed = true
	return nil
}

func (s *connectorDeviceStoreFake) Release(_ context.Context, authorizationCodeHash []byte, now time.Time) error {
	if !s.claimed || string(authorizationCodeHash) != string(s.authorization) || !s.claimedAt.Equal(now) {
		return ErrInvalid
	}
	s.claimed = false
	s.claimedAt = time.Time{}
	return nil
}

type connectorEnrollerFake struct {
	credential        ConnectorCredential
	calls             int
	userID            string
	hostID            string
	enrollmentID      string
	authorizationCode string
	err               error
}

func (e *connectorEnrollerFake) EnrollConnector(_ context.Context, userID, hostID, enrollmentID, authorizationCode string) (ConnectorCredential, error) {
	e.calls++
	e.userID, e.hostID = userID, hostID
	e.enrollmentID, e.authorizationCode = enrollmentID, authorizationCode
	if e.err != nil {
		return ConnectorCredential{}, e.err
	}
	return e.credential, nil
}

func TestConnectorDeviceFlowRejectsNonLoopbackCallback(t *testing.T) {
	flow := &connectorDeviceFlow{store: &connectorDeviceStoreFake{}, enroller: &connectorEnrollerFake{}}
	_, err := flow.start(context.Background(), connectorDeviceStartRequest{
		RedirectURI: "https://example.test/callback",
		State:       strings.Repeat("s", 32),
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("start error = %v, want invalid callback", err)
	}
}

func TestConnectorDeviceFlowExchangesAuthorizationCodeOnce(t *testing.T) {
	now := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	store := &connectorDeviceStoreFake{}
	enroller := &connectorEnrollerFake{credential: ConnectorCredential{HostID: "host-1", Token: "token-1"}}
	flow := &connectorDeviceFlow{store: store, enroller: enroller, now: func() time.Time { return now }}
	started, err := flow.start(context.Background(), connectorDeviceStartRequest{
		RedirectURI: "http://127.0.0.1:43123/callback",
		State:       strings.Repeat("s", 32),
		HostID:      "host-1",
	})
	if err != nil {
		t.Fatalf("start error = %v", err)
	}
	callback, err := flow.authorize(context.Background(), started.UserCode, "user-1")
	if err != nil {
		t.Fatalf("authorize error = %v", err)
	}
	parsed, err := url.Parse(callback)
	if err != nil || parsed.Query().Get("state") != strings.Repeat("s", 32) || parsed.Query().Get("code") == "" {
		t.Fatalf("authorization callback = %q, error = %v", callback, err)
	}
	apiKey, err := flow.exchange(context.Background(), parsed.Query().Get("code"))
	if err != nil {
		t.Fatalf("exchange error = %v", err)
	}
	credential, err := DecodeConnectorAPIKey(apiKey)
	if err != nil || credential != enroller.credential {
		t.Fatalf("exchanged credential = %+v, error = %v", credential, err)
	}
	if _, err := flow.exchange(context.Background(), parsed.Query().Get("code")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("replayed exchange error = %v, want invalid", err)
	}
	if enroller.calls != 1 {
		t.Fatalf("enroller calls = %d, want 1", enroller.calls)
	}
	if enroller.userID != "user-1" || enroller.hostID != "host-1" {
		t.Fatalf("enroller binding = (%q, %q), want (%q, %q)", enroller.userID, enroller.hostID, "user-1", "host-1")
	}
	if enroller.enrollmentID == "" || enroller.authorizationCode != parsed.Query().Get("code") {
		t.Fatalf("enroller exchange binding = (%q, %q), want non-empty authorization and code", enroller.enrollmentID, enroller.authorizationCode)
	}
}

func TestConnectorDeviceFlowReleasesClaimWhenEnrollmentFails(t *testing.T) {
	now := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	store := &connectorDeviceStoreFake{}
	enrollmentErr := errors.New("host enrollment failed")
	enroller := &connectorEnrollerFake{
		credential: ConnectorCredential{HostID: "host-1", Token: "token-1"},
		err:        enrollmentErr,
	}
	flow := &connectorDeviceFlow{store: store, enroller: enroller, now: func() time.Time { return now }}
	started, err := flow.start(context.Background(), connectorDeviceStartRequest{
		RedirectURI: "http://127.0.0.1:43123/callback",
		State:       strings.Repeat("s", 32),
		HostID:      "host-1",
	})
	if err != nil {
		t.Fatalf("start error = %v", err)
	}
	callback, err := flow.authorize(context.Background(), started.UserCode, "user-1")
	if err != nil {
		t.Fatalf("authorize error = %v", err)
	}
	parsed, err := url.Parse(callback)
	if err != nil {
		t.Fatalf("parse callback: %v", err)
	}
	code := parsed.Query().Get("code")
	if code == "" {
		t.Fatal("authorization callback did not contain a code")
	}
	if _, err := flow.exchange(context.Background(), code); !errors.Is(err, enrollmentErr) {
		t.Fatalf("failed enrollment error = %v, want %v", err, enrollmentErr)
	}
	if store.claimed {
		t.Fatal("authorization code remained claimed after enrollment failure")
	}
	enroller.err = nil
	if _, err := flow.exchange(context.Background(), code); err != nil {
		t.Fatalf("retry exchange error = %v", err)
	}
	if enroller.calls != 2 {
		t.Fatalf("enroller calls = %d, want 2", enroller.calls)
	}
}

func TestConnectorDeviceFlowRetriesEnrollmentAfterCompletionLeaseFailure(t *testing.T) {
	now := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	store := &connectorDeviceStoreFake{completeErr: errors.New("completion lost")}
	enroller := &connectorEnrollerFake{credential: ConnectorCredential{HostID: "host-1", Token: "token-1"}}
	flow := &connectorDeviceFlow{store: store, enroller: enroller, now: func() time.Time { return now }}
	started, err := flow.start(context.Background(), connectorDeviceStartRequest{
		RedirectURI: "http://127.0.0.1:43123/callback",
		State:       strings.Repeat("s", 32),
	})
	if err != nil {
		t.Fatalf("start error = %v", err)
	}
	callback, err := flow.authorize(context.Background(), started.UserCode, "user-1")
	if err != nil {
		t.Fatalf("authorize error = %v", err)
	}
	parsed, err := url.Parse(callback)
	if err != nil {
		t.Fatalf("parse callback: %v", err)
	}
	code := parsed.Query().Get("code")
	if _, err := flow.exchange(context.Background(), code); err == nil {
		t.Fatal("exchange succeeded despite completion failure")
	}
	firstEnrollmentID, firstAuthorizationCode := enroller.enrollmentID, enroller.authorizationCode
	now = now.Add(connectorExchangeClaim + time.Second)
	apiKey, err := flow.exchange(context.Background(), code)
	if err != nil {
		t.Fatalf("retry exchange error = %v", err)
	}
	if enroller.calls != 2 || enroller.enrollmentID != firstEnrollmentID || enroller.authorizationCode != firstAuthorizationCode {
		t.Fatalf("retry enrollment binding = (%d, %q, %q), want the same authorization binding", enroller.calls, enroller.enrollmentID, enroller.authorizationCode)
	}
	credential, err := DecodeConnectorAPIKey(apiKey)
	if err != nil || credential != enroller.credential {
		t.Fatalf("retry credential = (%+v, %v), want %+v", credential, err, enroller.credential)
	}
}

func TestConnectorDeviceFlowClaimLeaseCannotBeMutatedByAnOlderExchange(t *testing.T) {
	start := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	store := &connectorDeviceStoreFake{}
	flow := &connectorDeviceFlow{
		store:    store,
		enroller: &connectorEnrollerFake{},
		now:      func() time.Time { return start },
	}
	started, err := flow.start(context.Background(), connectorDeviceStartRequest{
		RedirectURI: "http://127.0.0.1:43123/callback",
		State:       strings.Repeat("s", 32),
	})
	if err != nil {
		t.Fatalf("start error = %v", err)
	}
	if _, err := flow.authorize(context.Background(), started.UserCode, "user-1"); err != nil {
		t.Fatalf("authorize error = %v", err)
	}
	firstClaimAt := start
	secondClaimAt := start.Add(connectorExchangeClaim + time.Second)
	hash := append([]byte(nil), store.authorization...)
	if _, err := store.Claim(context.Background(), hash, firstClaimAt); err != nil {
		t.Fatalf("first claim error = %v", err)
	}
	if _, err := store.Claim(context.Background(), hash, secondClaimAt); err != nil {
		t.Fatalf("second claim after expired lease error = %v", err)
	}
	if err := store.Release(context.Background(), hash, firstClaimAt); !errors.Is(err, ErrInvalid) {
		t.Fatalf("old release error = %v, want invalid", err)
	}
	if err := store.Complete(context.Background(), hash, firstClaimAt); !errors.Is(err, ErrInvalid) {
		t.Fatalf("old complete error = %v, want invalid", err)
	}
	if err := store.Complete(context.Background(), hash, secondClaimAt); err != nil {
		t.Fatalf("current complete error = %v", err)
	}
}

func TestSafeAuthReturnToRejectsExternalURL(t *testing.T) {
	if got := safeAuthReturnTo("https://evil.example/callback"); got != "" {
		t.Fatalf("external return target = %q, want empty", got)
	}
	if got := safeAuthReturnTo("/api/v1/auth/device/verify?user_code=ABCD-2345"); got == "" {
		t.Fatal("relative return target was rejected")
	}
	for _, value := range []string{`/\\evil.example/callback`, "/%5C%5Cevil.example/callback"} {
		if got := safeAuthReturnTo(value); got != "" {
			t.Fatalf("backslash return target %q = %q, want empty", value, got)
		}
	}
}

func TestConnectorOIDCStartPathPreservesDeploymentPrefix(t *testing.T) {
	if got := connectorOIDCStartPath("/loomhelm/api/v1/auth/device/verify"); got != "/loomhelm/api/v1/auth/oidc/start" {
		t.Fatalf("OIDC start path = %q", got)
	}
}
