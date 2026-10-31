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

func (s connectorAuthService) EnrollConnector(ctx context.Context) (auth.ConnectorCredential, error) {
	registration, err := s.registry.Enroll(ctx, hosts.RegisterRequest{
		Name:           "Loomhelm execution environment",
		CredentialName: "loomhelm-connector",
	})
	if err != nil {
		return auth.ConnectorCredential{}, auth.ErrUnavailable
	}
	return auth.ConnectorCredential{HostID: registration.Host.ID, Token: registration.Token}, nil
}

func (s connectorAuthService) ResolveConnectorCredential(ctx context.Context, token string) (string, error) {
	credential, err := s.registry.Authenticate(ctx, strings.TrimSpace(token))
	if err != nil {
		if errors.Is(err, hosts.ErrUnauthenticated) || errors.Is(err, hosts.ErrCredentialRevoked) {
			return "", auth.ErrUnauthenticated
		}
		return "", auth.ErrUnavailable
	}
	return credential.HostID, nil
}
