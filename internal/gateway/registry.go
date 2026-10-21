package gateway

import (
	"context"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

// Registry is the narrow persistence boundary needed by the WSS gateway. The
// concrete hosts.Service owns credential hashes, generation fencing and cursor
// retention; keeping this interface here lets transport tests use a local peer
// without bypassing those production rules.
type Registry interface {
	Authenticate(context.Context, string) (hosts.Credential, error)
	OpenConnection(context.Context, hosts.Credential) (hosts.Connection, error)
	Touch(context.Context, hosts.Connection) error
	Checkpoint(context.Context, hosts.Connection, hosts.Cursor) error
	AuthorizeCommand(context.Context, hosts.Connection, func() error) error
	ProcessEvent(context.Context, hosts.Connection, hosts.Cursor, func(context.Context) error) error
	CloseConnection(context.Context, hosts.Connection) error
}

type EventHandler func(context.Context, hosts.Connection, protocol.Event) error
