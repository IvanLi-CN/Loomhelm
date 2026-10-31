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
}

func (s *connectorDeviceStoreFake) Create(_ context.Context, record connectorDeviceAuthorization, userCodeHash, _ []byte) error {
	s.record = record
	s.userCodeHash = append([]byte(nil), userCodeHash...)
	return nil
}

func (s *connectorDeviceStoreFake) Lookup(_ context.Context, userCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if string(userCodeHash) != string(s.userCodeHash) || s.record.ExpiresAt.Before(now) || s.record.AuthorizationCodeSet {
		return connectorDeviceAuthorization{}, ErrInvalid
	}
	return s.record, nil
}

func (s *connectorDeviceStoreFake) Authorize(_ context.Context, userCodeHash []byte, userID string, authorizationCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if string(userCodeHash) != string(s.userCodeHash) || s.record.ExpiresAt.Before(now) || s.record.AuthorizationCodeSet {
		return connectorDeviceAuthorization{}, ErrInvalid
	}
	s.record.AuthorizedUserID = userID
	s.record.AuthorizationCodeSet = true
	s.authorization = append([]byte(nil), authorizationCodeHash...)
	return s.record, nil
}

func (s *connectorDeviceStoreFake) Consume(_ context.Context, authorizationCodeHash []byte, now time.Time) (connectorDeviceAuthorization, error) {
	if s.consumed || string(authorizationCodeHash) != string(s.authorization) || s.record.ExpiresAt.Before(now) {
		return connectorDeviceAuthorization{}, ErrInvalid
	}
	s.consumed = true
	return s.record, nil
}

type connectorEnrollerFake struct {
	credential ConnectorCredential
	calls      int
}

func (e *connectorEnrollerFake) EnrollConnector(context.Context) (ConnectorCredential, error) {
	e.calls++
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
}

func TestSafeAuthReturnToRejectsExternalURL(t *testing.T) {
	if got := safeAuthReturnTo("https://evil.example/callback"); got != "" {
		t.Fatalf("external return target = %q, want empty", got)
	}
	if got := safeAuthReturnTo("/api/v1/auth/device/verify?user_code=ABCD-2345"); got == "" {
		t.Fatal("relative return target was rejected")
	}
}

func TestConnectorOIDCStartPathPreservesDeploymentPrefix(t *testing.T) {
	if got := connectorOIDCStartPath("/loomhelm/api/v1/auth/device/verify"); got != "/loomhelm/api/v1/auth/oidc/start" {
		t.Fatalf("OIDC start path = %q", got)
	}
}
