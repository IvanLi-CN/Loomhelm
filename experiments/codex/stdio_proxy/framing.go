package stdioproxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const DefaultMaxFrameBytes = 4 << 20

type frameWriteError struct {
	BytesWritten int
	Err          error
}

func (e *frameWriteError) Error() string {
	return fmt.Sprintf("write JSONL frame after %d bytes: %v", e.BytesWritten, e.Err)
}

func (e *frameWriteError) Unwrap() error {
	return e.Err
}

func readFrame(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("maximum frame size must be greater than zero")
	}

	var frame []byte
	for {
		part, err := reader.ReadSlice('\n')
		frame = append(frame, part...)
		if len(frame) > maxBytes {
			return nil, fmt.Errorf("JSONL frame exceeds %d bytes", maxBytes)
		}
		if err == nil {
			return frame, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(frame) == 0 {
				return nil, io.EOF
			}
			return frame, nil
		}
		return nil, err
	}
}

func writeFrame(writer io.Writer, frame []byte) error {
	if writer == nil {
		return fmt.Errorf("frame writer must not be nil")
	}
	if len(bytes.TrimSpace(frame)) == 0 {
		return fmt.Errorf("JSONL frame must not be empty")
	}

	data := frame
	if !bytes.HasSuffix(data, []byte{'\n'}) {
		data = append(append([]byte(nil), data...), '\n')
	}
	written, err := writeAll(writer, data)
	if err != nil {
		return &frameWriteError{BytesWritten: written, Err: err}
	}
	return nil
}

func writeAll(writer io.Writer, data []byte) (int, error) {
	total := 0
	for total < len(data) {
		written, err := writer.Write(data[total:])
		total += written
		if err != nil {
			return total, err
		}
		if written == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}

type rpcMessage struct {
	fields    map[string]json.RawMessage
	method    string
	hasMethod bool
	id        json.RawMessage
	hasID     bool
	hasResult bool
	hasError  bool
}

func parseRPCMessage(frame []byte) (rpcMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(frame), &fields); err != nil {
		return rpcMessage{}, fmt.Errorf("decode JSON-RPC object: %w", err)
	}
	if fields == nil {
		return rpcMessage{}, fmt.Errorf("JSON-RPC message must be an object")
	}

	message := rpcMessage{fields: fields}
	if raw, ok := fields["method"]; ok {
		if err := json.Unmarshal(raw, &message.method); err != nil {
			return rpcMessage{}, fmt.Errorf("decode JSON-RPC method: %w", err)
		}
		message.hasMethod = true
	}
	if raw, ok := fields["id"]; ok {
		message.id = append(json.RawMessage(nil), raw...)
		message.hasID = true
	}
	_, message.hasResult = fields["result"]
	_, message.hasError = fields["error"]
	return message, nil
}

func (m rpcMessage) isResponse() bool {
	return m.hasID && !m.hasMethod
}

func (m rpcMessage) isValidResponse() bool {
	return m.isResponse() && !isNullID(m.id) && m.hasResult != m.hasError
}

func isNullID(id json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(id), []byte("null"))
}

func withID(frame []byte, id json.RawMessage) ([]byte, error) {
	message, err := parseRPCMessage(frame)
	if err != nil {
		return nil, err
	}
	if !message.hasID {
		return nil, fmt.Errorf("JSON-RPC message does not contain an id")
	}
	if isNullID(id) {
		return nil, fmt.Errorf("JSON-RPC id must not be null")
	}
	if !json.Valid(id) {
		return nil, fmt.Errorf("JSON-RPC id is not valid JSON")
	}
	message.fields["id"] = append(json.RawMessage(nil), id...)
	return json.Marshal(message.fields)
}

func errorFrame(id json.RawMessage, code int, message string) ([]byte, error) {
	if len(bytes.TrimSpace(id)) == 0 {
		id = json.RawMessage("null")
	}
	if !json.Valid(id) {
		id = json.RawMessage("null")
	}
	return json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}
