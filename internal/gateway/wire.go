// Package gateway owns the authenticated Connector link to the installation's
// one configured execution environment. Its wire messages are internal to the
// platform gateway and are not a second public REST/MCP contract.
package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/IvanLi-CN/Loomhelm/internal/hosts"
	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

const (
	ProtocolVersion = "loomhelm.gateway.v1"
	DefaultMaxFrame = 4 << 20
)

type MessageType string

const (
	MessageHello        MessageType = "hello"
	MessageHelloAck     MessageType = "hello_ack"
	MessageCommand      MessageType = "command"
	MessageCommandAck   MessageType = "command_ack"
	MessageEvent        MessageType = "event"
	MessageHeartbeat    MessageType = "heartbeat"
	MessageHeartbeatAck MessageType = "heartbeat_ack"
	MessageError        MessageType = "error"
)

type WireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type WireCursor struct {
	SessionID     string `json:"session_id"`
	RunID         string `json:"run_id,omitempty"`
	Value         string `json:"value"`
	ObservedAt    string `json:"observed_at"`
	RetainedUntil string `json:"retained_until"`
}

type Message struct {
	Type       MessageType          `json:"type"`
	RequestID  string               `json:"request_id,omitempty"`
	Protocol   string               `json:"protocol,omitempty"`
	HostID     string               `json:"host_id,omitempty"`
	Generation int64                `json:"generation,omitempty"`
	SessionID  string               `json:"session_id,omitempty"`
	RunID      string               `json:"run_id,omitempty"`
	Cursor     string               `json:"cursor,omitempty"`
	Cursors    []WireCursor         `json:"cursors,omitempty"`
	Command    *protocol.Command    `json:"command,omitempty"`
	Ack        *protocol.CommandAck `json:"ack,omitempty"`
	Event      *protocol.Event      `json:"event,omitempty"`
	Error      *WireError           `json:"error,omitempty"`
}

func (m Message) Validate() error {
	if m.Type == "" {
		return errors.New("gateway message type is required")
	}
	switch m.Type {
	case MessageHello:
		if m.Protocol != ProtocolVersion || strings.TrimSpace(m.HostID) == "" {
			return errors.New("gateway hello requires the supported protocol and host id")
		}
	case MessageHelloAck:
		if strings.TrimSpace(m.HostID) == "" || m.Generation <= 0 {
			return errors.New("gateway hello acknowledgement requires host id and generation")
		}
		for _, cursor := range m.Cursors {
			if err := cursor.validate(); err != nil {
				return err
			}
		}
	case MessageCommand:
		if strings.TrimSpace(m.RequestID) == "" || m.Command == nil {
			return errors.New("gateway command requires request id and command")
		}
	case MessageCommandAck:
		if strings.TrimSpace(m.RequestID) == "" || m.Ack == nil {
			return errors.New("gateway command acknowledgement requires request id and ack")
		}
		if err := validateCommandAck(*m.Ack); err != nil {
			return err
		}
	case MessageEvent:
		if m.Event == nil || strings.TrimSpace(m.Event.Cursor) == "" || strings.TrimSpace(m.Event.SessionID) == "" {
			return errors.New("gateway event requires a session id and event cursor")
		}
	case MessageHeartbeat:
		if strings.TrimSpace(m.RequestID) == "" {
			return errors.New("gateway heartbeat requires request id")
		}
		if m.Cursor != "" && strings.TrimSpace(m.SessionID) == "" {
			return errors.New("gateway heartbeat cursor requires a session id")
		}
	case MessageHeartbeatAck:
		if strings.TrimSpace(m.RequestID) == "" {
			return errors.New("gateway heartbeat acknowledgement requires request id")
		}
	case MessageError:
		if m.Error == nil || strings.TrimSpace(m.Error.Code) == "" {
			return errors.New("gateway error requires a code")
		}
	default:
		return fmt.Errorf("unsupported gateway message type %q", m.Type)
	}
	return nil
}

func (c WireCursor) validate() error {
	if strings.TrimSpace(c.SessionID) == "" || strings.TrimSpace(c.Value) == "" {
		return errors.New("gateway resume cursor requires a session id and value")
	}
	if _, err := time.Parse(time.RFC3339Nano, c.ObservedAt); err != nil {
		return errors.New("gateway resume cursor observed time is malformed")
	}
	if _, err := time.Parse(time.RFC3339Nano, c.RetainedUntil); err != nil {
		return errors.New("gateway resume cursor retention time is malformed")
	}
	return nil
}

func wireCursor(cursor hosts.Cursor) WireCursor {
	return WireCursor{
		SessionID:     cursor.SessionID,
		RunID:         cursor.RunID,
		Value:         cursor.Value,
		ObservedAt:    cursor.ObservedAt.UTC().Format(time.RFC3339Nano),
		RetainedUntil: cursor.RetainedUntil.UTC().Format(time.RFC3339Nano),
	}
}

func hostCursor(cursor WireCursor) (hosts.Cursor, error) {
	if err := cursor.validate(); err != nil {
		return hosts.Cursor{}, err
	}
	observedAt, err := time.Parse(time.RFC3339Nano, cursor.ObservedAt)
	if err != nil {
		return hosts.Cursor{}, err
	}
	retainedUntil, err := time.Parse(time.RFC3339Nano, cursor.RetainedUntil)
	if err != nil {
		return hosts.Cursor{}, err
	}
	return hosts.Cursor{
		SessionID:     cursor.SessionID,
		RunID:         cursor.RunID,
		Value:         cursor.Value,
		ObservedAt:    observedAt,
		RetainedUntil: retainedUntil,
	}, nil
}

func encodeMessage(message Message, maxFrame int64) ([]byte, error) {
	if err := message.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(message)
	if err != nil {
		return nil, fmt.Errorf("encode gateway message: %w", err)
	}
	if maxFrame > 0 && int64(len(data)) > maxFrame {
		return nil, fmt.Errorf("gateway message exceeds %d byte frame limit", maxFrame)
	}
	return data, nil
}

func decodeMessage(data []byte, maxFrame int64) (Message, error) {
	if maxFrame > 0 && int64(len(data)) > maxFrame {
		return Message{}, fmt.Errorf("gateway message exceeds %d byte frame limit", maxFrame)
	}
	var message Message
	if err := json.Unmarshal(data, &message); err != nil {
		return Message{}, fmt.Errorf("decode gateway message: %w", err)
	}
	if err := message.Validate(); err != nil {
		return Message{}, err
	}
	if message.Type == MessageCommandAck {
		if err := validateCommandAckEnvelope(data); err != nil {
			return Message{}, err
		}
	}
	return message, nil
}

func validateCommandAck(ack protocol.CommandAck) error {
	if strings.TrimSpace(ack.CommandID) == "" {
		return errors.New("gateway command acknowledgement requires command id")
	}
	switch ack.State {
	case protocol.CommandStateAccepted,
		protocol.CommandStateExecuting,
		protocol.CommandStateSucceeded,
		protocol.CommandStateFailed,
		protocol.CommandStateUnknown,
		protocol.CommandStateRejected:
	default:
		return fmt.Errorf("gateway command acknowledgement has unsupported state %q", ack.State)
	}
	if strings.TrimSpace(ack.ReceivedAt) == "" {
		return errors.New("gateway command acknowledgement requires received time")
	}
	if _, err := time.Parse(time.RFC3339Nano, ack.ReceivedAt); err != nil {
		return errors.New("gateway command acknowledgement received time is malformed")
	}
	return nil
}

func validateCommandAckEnvelope(data []byte) error {
	var envelope struct {
		Ack json.RawMessage `json:"ack"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("decode gateway command acknowledgement: %w", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(envelope.Ack, &fields); err != nil || fields == nil {
		return errors.New("gateway command acknowledgement payload must be an object")
	}
	for _, field := range []string{"command_id", "state", "received_at", "deduplicated"} {
		if _, ok := fields[field]; !ok {
			return fmt.Errorf("gateway command acknowledgement requires %s", field)
		}
	}
	var deduplicated bool
	if strings.TrimSpace(string(fields["deduplicated"])) == "null" || json.Unmarshal(fields["deduplicated"], &deduplicated) != nil {
		return errors.New("gateway command acknowledgement deduplicated must be a boolean")
	}
	return nil
}

func newRequestID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate gateway request id: %w", err)
	}
	return "gwreq_" + hex.EncodeToString(data), nil
}
