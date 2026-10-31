package app

import (
	"context"
	"errors"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/auth"
	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
)

type connectorAuthService struct {
	registry *hosts.Service
}

func (s connectorAuthService) EnrollConnector(ctx context.Context, approvingUserID, requestedHostID, enrollmentID, authorizationCode string) (auth.ConnectorCredential, error) {
	registration, err := s.registry.EnrollConnectorForUser(ctx, approvingUserID, requestedHostID, enrollmentID, authorizationCode, hosts.RegisterRequest{
		Name:           "Loomhelm execution environment",
		CredentialName: "loomhelm-connector",
	})
	if err != nil {
		if errors.Is(err, hosts.ErrForbidden) || errors.Is(err, hosts.ErrNotFound) {
			return auth.ConnectorCredential{}, auth.ErrForbidden
		}
		return auth.ConnectorCredential{}, auth.ErrUnavailable
	}
	return auth.ConnectorCredential{HostID: registration.Host.ID, Token: registration.Token}, nil
}

func (s connectorAuthService) ResolveConnectorCredential(ctx context.Context, token string) (string, error) {
	token = strings.TrimSpace(token)
	expectedHostID := ""
	if decoded, decodeErr := auth.DecodeConnectorAPIKey(token); decodeErr == nil {
		expectedHostID = decoded.HostID
		token = decoded.Token
	}
	credential, err := s.registry.Authenticate(ctx, token)
	if err != nil {
		if errors.Is(err, hosts.ErrUnauthenticated) || errors.Is(err, hosts.ErrCredentialRevoked) {
			return "", auth.ErrUnauthenticated
		}
		return "", auth.ErrUnavailable
	}
	if expectedHostID != "" && credential.HostID != expectedHostID {
		return "", auth.ErrUnauthenticated
	}
	return credential.HostID, nil
}
