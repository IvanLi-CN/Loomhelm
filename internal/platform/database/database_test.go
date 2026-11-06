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
		wantMsg string
	}{
		{name: "valid defaults", config: Config{URL: "postgres://localhost/loomhelm"}},
		{name: "missing URL", config: Config{}, wantErr: true},
		{name: "negative minimum", config: Config{URL: "postgres://localhost/loomhelm", MinConns: -1}, wantErr: true},
		{name: "negative maximum", config: Config{URL: "postgres://localhost/loomhelm", MaxConns: -1}, wantErr: true},
		{name: "minimum exceeds maximum", config: Config{URL: "postgres://localhost/loomhelm", MinConns: 2, MaxConns: 1}, wantErr: true},
		{name: "environment minimum exceeds URL maximum", config: Config{URL: "postgres://localhost/loomhelm?pool_max_conns=1", MinConns: 2}, wantErr: true},
		{name: "URL minimum exceeds environment maximum", config: Config{URL: "postgres://localhost/loomhelm?pool_min_conns=5", MaxConns: 4}, wantErr: true},
		{name: "negative URL minimum", config: Config{URL: "postgres://localhost/loomhelm?pool_min_conns=-1"}, wantErr: true, wantMsg: "database pool sizes must not be negative"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.config.Validate()
			if (err != nil) != test.wantErr {
				t.Fatalf("Config.Validate() error = %v, wantErr %t", err, test.wantErr)
			}
			if test.wantMsg != "" && (err == nil || !strings.Contains(err.Error(), test.wantMsg)) {
				t.Fatalf("Config.Validate() error = %v, want substring %q", err, test.wantMsg)
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
