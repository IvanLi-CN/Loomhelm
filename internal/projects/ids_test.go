package projects

import (
	"errors"
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

func TestIsUniqueViolation(t *testing.T) {
	if !isUniqueViolation(&pgconn.PgError{Code: "23505"}) {
		t.Fatal("isUniqueViolation() = false for a unique violation")
	}
	if isUniqueViolation(errors.New("not a database conflict")) {
		t.Fatal("isUniqueViolation() = true for an unrelated error")
	}
}
