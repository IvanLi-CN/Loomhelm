package auth

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const connectorAPIKeyPrefix = "lhk_"

// ConnectorCredential is the deployment credential returned by the device
// authorization flow. It is deliberately separate from a user API credential.
type ConnectorCredential struct {
	HostID string
	Token  string
}

// EncodeConnectorAPIKey creates the single opaque value accepted by a
// Connector configuration. The raw host token never appears in a browser
// redirect or in the public response as a separate field.
func EncodeConnectorAPIKey(hostID, token string) (string, error) {
	hostID = strings.TrimSpace(hostID)
	token = strings.TrimSpace(token)
	if hostID == "" || token == "" || strings.ContainsAny(hostID+token, " \t\r\n\x00") {
		return "", errors.New("connector credential fields must be non-empty and whitespace-free")
	}
	return connectorAPIKeyPrefix + base64.RawURLEncoding.EncodeToString([]byte(hostID+"\x00"+token)), nil
}

// DecodeConnectorAPIKey decodes only Loomhelm's opaque deployment key format.
func DecodeConnectorAPIKey(value string) (ConnectorCredential, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, connectorAPIKeyPrefix) {
		return ConnectorCredential{}, fmt.Errorf("invalid connector API key")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, connectorAPIKeyPrefix))
	if err != nil {
		return ConnectorCredential{}, fmt.Errorf("invalid connector API key")
	}
	parts := strings.Split(string(decoded), "\x00")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(string(decoded), " \t\r\n") {
		return ConnectorCredential{}, fmt.Errorf("invalid connector API key")
	}
	return ConnectorCredential{HostID: parts[0], Token: parts[1]}, nil
}
