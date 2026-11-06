package connector

import (
	"fmt"
	"strings"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// CommandNamespace separates caller-visible platform identity from the
// gateway and adapter identities used inside Connector.
type CommandNamespaceKind string

const (
	CommandNamespacePlatformSession CommandNamespaceKind = "platform-session"
	CommandNamespaceGateway         CommandNamespaceKind = "gateway"
	CommandNamespaceAdapterSession  CommandNamespaceKind = "adapter-session"
	CommandNamespaceLegacy          CommandNamespaceKind = "legacy"
)

// CommandNamespace is an internal durable command scope. The ID is never a
// translated native identifier when Kind is CommandNamespacePlatformSession.
type CommandNamespace struct {
	Kind CommandNamespaceKind `json:"kind"`
	ID   string               `json:"id"`
}

func namespacePointer(namespace CommandNamespace) *CommandNamespace {
	return &namespace
}

func PlatformSessionCommandNamespace(sessionID string) CommandNamespace {
	return CommandNamespace{Kind: CommandNamespacePlatformSession, ID: strings.TrimSpace(sessionID)}
}

func GatewayCommandNamespace(handle string) CommandNamespace {
	return CommandNamespace{Kind: CommandNamespaceGateway, ID: strings.TrimSpace(handle)}
}

func AdapterSessionCommandNamespace(sessionID string) CommandNamespace {
	return CommandNamespace{Kind: CommandNamespaceAdapterSession, ID: strings.TrimSpace(sessionID)}
}

func LegacyCommandNamespace(id string) CommandNamespace {
	return CommandNamespace{Kind: CommandNamespaceLegacy, ID: strings.TrimSpace(id)}
}

func (n CommandNamespace) validate() error {
	if n.Kind == "" || n.ID == "" {
		return ErrCommandScopeUnknown
	}
	if strings.ContainsRune(string(n.Kind), '\x00') || strings.ContainsRune(n.ID, '\x00') {
		return fmt.Errorf("command namespace contains a NUL separator")
	}
	switch n.Kind {
	case CommandNamespacePlatformSession, CommandNamespaceGateway, CommandNamespaceAdapterSession, CommandNamespaceLegacy:
		return nil
	default:
		return fmt.Errorf("unsupported command namespace %q", n.Kind)
	}
}

func (n CommandNamespace) String() string {
	return string(n.Kind) + ":" + n.ID
}

func commandNamespaceKey(namespace CommandNamespace, commandID string) string {
	return identityTupleKey(string(namespace.Kind), namespace.ID, strings.TrimSpace(commandID))
}

func commandNamespaceForCommand(command protocol.Command) CommandNamespace {
	switch command.Kind {
	case protocol.CommandKindSessionStart, protocol.CommandKindSessionAttach:
		return PlatformSessionCommandNamespace(command.SessionID)
	default:
		return AdapterSessionCommandNamespace(command.SessionID)
	}
}

func validateCommandNamespace(namespace CommandNamespace, command protocol.Command) error {
	if err := namespace.validate(); err != nil {
		return err
	}
	switch namespace.Kind {
	case CommandNamespacePlatformSession, CommandNamespaceAdapterSession:
		if namespace.ID != strings.TrimSpace(command.SessionID) {
			return fmt.Errorf("command namespace %s does not match command session %q: %w", namespace.String(), command.SessionID, ErrCommandScopeUnknown)
		}
	case CommandNamespaceGateway, CommandNamespaceLegacy:
		return fmt.Errorf("command namespace %s cannot own a command record: %w", namespace.String(), ErrCommandScopeUnknown)
	}
	return nil
}
