package projects

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestValidResourceID(t *testing.T) {
	valid := "project_" + strings.Repeat("a", 32)
	for _, value := range []string{valid, "project_0123456789abcdef0123456789abcdef"} {
		if !validResourceID(value, "project") {
			t.Errorf("validResourceID(%q) = false", value)
		}
	}
	for _, value := range []string{
		"project_" + strings.Repeat("a", 31),
		"project_" + strings.Repeat("a", 31) + "g",
		"project_" + strings.ToUpper(strings.Repeat("a", 32)),
		"task_" + strings.Repeat("a", 32),
	} {
		if validResourceID(value, "project") {
			t.Errorf("validResourceID(%q) = true", value)
		}
	}
}

func TestDecodeCreateRequestDistinguishesMissingAndEmptyID(t *testing.T) {
	omitted, err := decodeCreateRequest(httptest.NewRequest("POST", "/projects", strings.NewReader(`{"name":"Project"}`)))
	if err != nil {
		t.Fatalf("decode omitted id: %v", err)
	}
	if omitted.ID != nil {
		t.Fatalf("omitted id = %q, want nil", *omitted.ID)
	}

	empty, err := decodeCreateRequest(httptest.NewRequest("POST", "/projects", strings.NewReader(`{"id":"","name":"Project"}`)))
	if err != nil {
		t.Fatalf("decode empty id: %v", err)
	}
	if empty.ID == nil || *empty.ID != "" {
		t.Fatalf("empty id = %#v, want pointer to empty string", empty.ID)
	}
}

func TestIsUniqueViolation(t *testing.T) {
	if !isUniqueViolation(&pgconn.PgError{Code: "23505"}) {
		t.Fatal("isUniqueViolation() = false for a unique violation")
	}
	if isUniqueViolation(errors.New("not a database conflict")) {
		t.Fatal("isUniqueViolation() = true for an unrelated error")
	}
}
