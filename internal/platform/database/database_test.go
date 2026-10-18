package database

import (
	"context"
	"strings"
	"testing"
)

func TestConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		wantErr bool
	}{
		{name: "valid defaults", config: Config{URL: "postgres://localhost/loomhelm"}},
		{name: "missing URL", config: Config{}, wantErr: true},
		{name: "negative minimum", config: Config{URL: "postgres://localhost/loomhelm", MinConns: -1}, wantErr: true},
		{name: "negative maximum", config: Config{URL: "postgres://localhost/loomhelm", MaxConns: -1}, wantErr: true},
		{name: "minimum exceeds maximum", config: Config{URL: "postgres://localhost/loomhelm", MinConns: 2, MaxConns: 1}, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.config.Validate()
			if (err != nil) != test.wantErr {
				t.Fatalf("Config.Validate() error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestOpenRejectsMalformedURLWithoutEchoingCredentials(t *testing.T) {
	const secret = "database-password"
	_, err := Open(context.Background(), Config{URL: "postgres://user:" + secret + "@[malformed"})
	if err == nil {
		t.Fatal("Open() error = nil, want malformed URL error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("Open() error leaked database credentials: %v", err)
	}
}
