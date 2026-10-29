package auth

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/IvanLi-CN/Loomhelm/internal/protocol"
)

func TestBearerToken(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
		ok     bool
	}{
		{name: "case insensitive scheme", header: "bEaReR secret", want: "secret", ok: true},
		{name: "extra whitespace", header: "Bearer   secret", want: "secret", ok: true},
		{name: "missing token", header: "Bearer", ok: false},
		{name: "wrong scheme", header: "Basic secret", ok: false},
		{name: "multiple tokens", header: "Bearer one two", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := bearerToken(test.header)
			if got != test.want || ok != test.ok {
				t.Fatalf("bearerToken(%q) = %q, %t; want %q, %t", test.header, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestValidExpectedPrincipal(t *testing.T) {
	tests := []struct {
		name  string
		value string
		valid bool
	}{
		{name: "stable id", value: "user_0123456789abcdef", valid: true},
		{name: "empty", value: "", valid: false},
		{name: "leading whitespace", value: " user-1", valid: false},
		{name: "trailing whitespace", value: "user-1 ", valid: false},
		{name: "duplicate delimiter", value: "user-1,user-2", valid: false},
		{name: "control character", value: "user-1\n", valid: false},
		{name: "too long", value: strings.Repeat("x", 129), valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validExpectedPrincipal(test.value); got != test.valid {
				t.Fatalf("validExpectedPrincipal(%q) = %t, want %t", test.value, got, test.valid)
			}
		})
	}
}

func TestDecodeJSONRejectsUnknownAndTrailingValues(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "unknown field", body: `{"known":"value","unknown":true}`},
		{name: "trailing value", body: `{"known":"value"}{"known":"other"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", strings.NewReader(test.body))
			var value struct {
				Known string `json:"known"`
			}
			if err := decodeJSON(request, &value); !errors.Is(err, ErrInvalid) {
				t.Fatalf("decodeJSON() error = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestDecodeJSONAllowsWhitespaceAfterValue(t *testing.T) {
	request := httptest.NewRequest("POST", "/", strings.NewReader("{\"known\":\"value\"}\n  \t"))
	var value struct {
		Known string `json:"known"`
	}
	if err := decodeJSON(request, &value); err != nil {
		t.Fatalf("decodeJSON() error = %v", err)
	}
	if value.Known != "value" {
		t.Fatalf("decoded value = %q, want value", value.Known)
	}
}

func TestStatusForError(t *testing.T) {
	tests := []struct {
		err  error
		want int
	}{
		{err: ErrUnauthenticated, want: 401},
		{err: ErrForbidden, want: 403},
		{err: ErrNotFound, want: 404},
		{err: ErrConflict, want: 409},
		{err: ErrInvalid, want: 400},
		{err: errors.New("unexpected"), want: 500},
	}
	for _, test := range tests {
		if got := statusForError(test.err); got != test.want {
			t.Fatalf("statusForError(%v) = %d, want %d", test.err, got, test.want)
		}
	}
}

func TestWriteErrorUsesRequestIDAndProtocolCode(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("X-Request-ID", "req-test")
	response := httptest.NewRecorder()
	writeError(response, request, 409, ErrConflict, "conflict")

	if response.Code != 409 {
		t.Fatalf("status = %d, want 409", response.Code)
	}
	if !strings.Contains(response.Body.String(), string(protocol.ErrorCodeConflict)) || !strings.Contains(response.Body.String(), "req-test") {
		t.Fatalf("error response = %q, want conflict code and request id", response.Body.String())
	}
}

func TestDecodeJSONRejectsMissingBody(t *testing.T) {
	request := httptest.NewRequest("POST", "/", io.Reader(nil))
	request.Body = nil
	var value map[string]string
	if err := decodeJSON(request, &value); !errors.Is(err, ErrInvalid) {
		t.Fatalf("decodeJSON() error = %v, want ErrInvalid", err)
	}
}
